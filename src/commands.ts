import { type createReactAgent } from "@langchain/langgraph/prebuilt";
import { AgentConfig, GroupTossName, Participant } from "./types";
import { HELP_MESSAGE } from "./constants";
import { TossManager } from "./toss-manager";
import { checkTransactionWithRetries, createUSDCTransferCalls, extractERC20TransferData, sendTransactionReference } from "../helpers/transactions";
import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { storage } from "../helpers/lcoalStorage";
import { customJSONStringify } from "./utils";

// Wallet operations ----------------------------------------

/**
 * Create wallet send calls buttons for joining a toss
 */
async function createJoinTossWalletSendCalls(
  client: Client,
  tossId: string, 
  tossAmount: string, 
  walletAddress: string, 
  senderInboxId: string,
  option: string,
  tossManager: TossManager
): Promise<{ walletSendCalls: any, memberAddress: string }> {
  const amountInDecimals = Math.floor(parseFloat(tossAmount) * Math.pow(10, 6));
  
  // Get toss data and determine option position
  const toss = await tossManager.getToss(tossId);
  const isFirstOption = toss?.tossOptions?.[0]?.toLowerCase() === option.toLowerCase();
  
  // Get the user's wallet address from inbox ID
  const inboxState = await client.preferences.inboxStateFromInboxIds([senderInboxId]);
  const memberAddress = inboxState[0].identifiers[0].identifier;
  
  if (!memberAddress) throw new Error("Unable to find member address");
  
  // Create the wallet send calls with option metadata
  const description = `Join Toss #${tossId} with option "${option}" 👇`;
  const walletSendCalls = createUSDCTransferCalls(
    memberAddress,
    walletAddress,
    amountInDecimals,
    {
      tossId,
      selectedOption: option,
      option,
      choice: option,
      description: `Option: ${option} 👇`,
      isFirstOption,
      tossOptions: toss?.tossOptions
    },
    description
  );
  
  return { walletSendCalls, memberAddress };
}

// Command handling ----------------------------------------

/**
 * Main entry point for command processing
 */
export async function handleCommand(
  client: Client,
  conversation: Conversation,
  message: DecodedMessage,
  isDm: boolean,
  tossManager: TossManager,
  agent: ReturnType<typeof createReactAgent>,
  agentConfig: AgentConfig,
): Promise<string> {
  try {
    const conversationId = conversation.id;
    const commandContent = (message.content as string).replace(/^@toss\s+/i, "").trim();
    const commandParts = commandContent.split(" ");
    const command = commandParts[0].toLowerCase();

    // Handle explicit commands
    if (["join", "close", "help", "balance", "status"].includes(command)) {
      return handleExplicitCommand(
        command, 
        commandParts.slice(1), 
        message.senderInboxId, 
        tossManager, 
        client,
        conversation,
        isDm
      );
    }
    
    // Check for existing active toss
    const existingToss = await tossManager.getActiveTossForConversation(conversationId);
    if (existingToss) {
      return `There's already an active toss in this group. Please use or close the current toss before creating a new one.`;
    }

    console.log(`🧠 Processing prompt: "${commandContent}"`);
    
    // Create toss from prompt
    const toss = await tossManager.createGameFromPrompt(
      message.senderInboxId, 
      commandContent, 
      agent, 
      agentConfig, 
      conversationId
    );
    
    // Send toss creation confirmation
    const responseText = `🎲 Toss Created! 🎲\n\nTopic: "${toss.tossTopic}"\n${
      toss.tossOptions?.length === 2 ? `Options: ${toss.tossOptions[0]} or ${toss.tossOptions[1]}\n` : ''
    }Toss Amount: ${toss.tossAmount} USDC\n\nTo join, select an option below:`;
    
    await conversation.send(responseText);
    
    // Send option buttons if there are exactly two options
    if (toss.tossOptions?.length === 2) {
      await sendJoinOptions(client, conversation, toss, message.senderInboxId, tossManager);
    } else {
      await conversation.send("You can join by using the command: @toss join <option>");
    }
    
    return ""; // Empty string since we've sent responses directly
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Send join options as wallet send calls buttons
 */
async function sendJoinOptions(
  client: Client,
  conversation: Conversation,
  toss: GroupTossName,
  senderInboxId: string,
  tossManager: TossManager
): Promise<void> {
  try {
    for (const option of toss.tossOptions || []) {
      const { walletSendCalls } = await createJoinTossWalletSendCalls(
        client, 
        toss.id, 
        toss.tossAmount, 
        toss.walletAddress, 
        senderInboxId,
        option,
        tossManager
      );
      
      await conversation.send(walletSendCalls, ContentTypeWalletSendCalls);
    }
  } catch (error) {
    console.error("Error creating wallet send calls:", error);
    await conversation.send("Error creating join options. Please try again.");
  }
}

/**
 * Handle explicit commands (join, close, help, balance, status)
 */
export async function handleExplicitCommand(
  command: string,
  args: string[],
  inboxId: string,
  tossManager: TossManager,
  client: Client,
  conversation: Conversation,
  isDm: boolean
): Promise<string> {
  const conversationId = conversation.id;
  
  switch (command) {
    case "balance": {
      if (!isDm) return "For checking your balance, please DM me.";
      const { balance, address } = await tossManager.getBalance(inboxId);
      return `Your balance is ${balance} USDC. Your address is ${address}`;
    }
    
    case "status": {
      if (!conversationId) return "Tosses are only supported in group chats.";
      
      const toss = await tossManager.getActiveTossForConversation(conversationId);
      if (!toss) return "No active toss found in this group.";
      
      return formatTossStatus(toss);
    }
    
    case "join": {
      if (!conversationId) return "Tosses are only supported in group chats.";
      
      const toss = await tossManager.getActiveTossForConversation(conversationId);
      if (!toss) return "No active toss found in this group. Start one with '@toss <topic>'";
      
      if (!toss.tossOptions || toss.tossOptions.length !== 2) {
        return `This toss doesn't have exactly two options.`;
      }
      
      await conversation.send(`Join "${toss.tossTopic}" by selecting one of the options below:`);
      await sendJoinOptions(client, conversation, toss, inboxId, tossManager);
      return "";
    }

    case "close": {
      if (!conversationId) return "Tosses are only supported in group chats.";
      
      const toss = await tossManager.getActiveTossForConversation(conversationId);
      if (!toss) return "No active toss found in this group.";
      
      if (inboxId !== toss.creator) return "Only the toss creator can close the toss.";
      
      const winningOption = args.length > 0 ? args.join(" ") : null;
      const isForceClose = !winningOption;
      
      if (toss.participants.length < 2 && !isForceClose) {
        return "Not enough participants to determine a winner. To force close and return funds, use '@toss close' without specifying an option.";
      }
      
      await conversation.send("⏳ Thinking...");
      
      try {
        let closedToss: GroupTossName;
        
        if (isForceClose) {
          closedToss = await tossManager.forceCloseToss(toss.id);
        } else {
          closedToss = await tossManager.executeToss(toss.id, winningOption);
        }
        
        // Clear the group-to-toss mapping
        await tossManager.clearActiveTossForConversation(conversationId);
        
        const response = formatTossResult(closedToss, winningOption, isForceClose);
        
        if (closedToss.transactionHash) {
          await sendTransactionReference(conversation, closedToss.transactionHash);
        }
        
        return response;
      } catch (error) {
        return `Error closing toss: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    case "help":
    default:
      return HELP_MESSAGE;
  }
}

// Transaction handling ----------------------------------------

/**
 * Process a transaction reference that might be related to a toss
 */
export async function handleTransactionReference(
  client: Client,
  conversation: Conversation,
  message: DecodedMessage,
  tossManager: TossManager
): Promise<void> {
  try {
    tossManager.setClient(client);
    
    console.log(`📝 Processing transaction reference:`, message.content);
    
    // Extract transaction data
    const txRef = message.content as any;
    const txHash = txRef?.reference;
    if (!txHash) return;
    
    console.log(`🔍 Verifying transaction: ${txHash}`);
    const txDetails = await checkTransactionWithRetries(txHash);
    if (!txDetails) {
      await conversation.send("⚠️ Could not verify the transaction. It may be pending or not yet indexed.");
      return;
    }
    
    // Check transaction status
    if (txDetails.status !== 'success') {
      await conversation.send(`⚠️ Transaction ${txHash} failed or is still pending.`);
      return;
    }
    
    // Add detailed logging to examine transaction content
    console.log(`✅ Transaction verified: From ${txDetails.from} to ${txDetails.to}`);
    console.log(`Transaction data structure: ${customJSONStringify(txDetails, 2)}`);
    console.log(`Transaction reference structure: ${customJSONStringify(txRef, 2)}`);

    // Extract transfer data
    const transferData = txDetails.data ? extractERC20TransferData(txDetails.data) : null;
    
    // Extract toss information first
    const tossData = await extractTossData(txDetails, storage);
    if (!tossData.tossId) return;
    
    // Extract option from metadata fields
    let selectedOption = extractSelectedOption(txRef, txDetails, message);
    
    // If no option found in metadata, try amount-based extraction
    if (!selectedOption && transferData) {
      selectedOption = await extractOptionFromTransferAmount(transferData, tossData.tossId);
    }
    
    console.log(`Final extracted option: ${selectedOption || 'NONE FOUND'}`);
    
    // Verify this transaction is for the active toss in this conversation
    const activeToss = await tossManager.getActiveTossForConversation(conversation.id);
    if (activeToss && activeToss.id !== tossData.tossId) {
      await conversation.send(`⚠️ This payment is for a different toss than the one active in this conversation.`);
      return;
    }
    
    // Process the join
    if (selectedOption) {
      await processTossJoin(client, conversation, message, tossManager, tossData.tossId, selectedOption, txDetails);
    } else {
      await conversation.send(`⚠️ No option found in the transaction. Please select an option from the list of options.`);
    }
    
  } catch (error) {
    console.error("Error handling transaction reference:", error);
    try {
      await conversation.send("⚠️ An error occurred while processing your transaction.");
    } catch (sendError) {
      console.error("Failed to send error message:", sendError);
    }
  }
}

/**
 * Extract selected option from transaction data
 */
function extractSelectedOption(txRef: any, txDetails: any, message: DecodedMessage): string | null {
  console.log("Attempting to extract selected option from transaction data...");
  
  // 1. Try to find option in transaction metadata
  if (txDetails.metadata?.selectedOption) {
    console.log(`Found option in txDetails.metadata: ${txDetails.metadata.selectedOption}`);
    return txDetails.metadata.selectedOption;
  }
  
  // 2. Try transaction reference call metadata
  if (txRef.calls?.[0]?.metadata?.selectedOption) {
    console.log(`Found option in txRef.calls[0].metadata: ${txRef.calls[0].metadata.selectedOption}`);
    return txRef.calls[0].metadata.selectedOption;
  }
  
  // 3. Try direct metadata
  if (txRef.metadata?.selectedOption) {
    console.log(`Found option in txRef.metadata: ${txRef.metadata.selectedOption}`);
    return txRef.metadata.selectedOption;
  }
  
  // 4. Try call data from ALL calls
  if (txRef.calls && txRef.calls.length > 0) {
    for (let i = 0; i < txRef.calls.length; i++) {
      // Check different metadata property names that might contain the option
      const callData = txRef.calls[i];
      
      if (callData.metadata?.option) {
        console.log(`Found option in txRef.calls[${i}].metadata.option: ${callData.metadata.option}`);
        return callData.metadata.option;
      }
      
      if (callData.metadata?.choice) {
        console.log(`Found option in txRef.calls[${i}].metadata.choice: ${callData.metadata.choice}`);
        return callData.metadata.choice;
      }
      
      // Check if option is in deeper structures
      if (callData.metadata?.extras?.option) {
        console.log(`Found option in txRef.calls[${i}].metadata.extras.option: ${callData.metadata.extras.option}`);
        return callData.metadata.extras.option;
      }
    }
  }
  
  // 5. Try message context (expanded checks)
  const messageContext = message.content as any;
  
  if (messageContext?.metadata?.selectedOption) {
    console.log(`Found option in messageContext.metadata.selectedOption: ${messageContext.metadata.selectedOption}`);
    return messageContext.metadata.selectedOption;
  }
  
  if (messageContext?.metadata?.option) {
    console.log(`Found option in messageContext.metadata.option: ${messageContext.metadata.option}`);
    return messageContext.metadata.option;
  }
  
  if (messageContext?.extras?.option) {
    console.log(`Found option in messageContext.extras.option: ${messageContext.extras.option}`);
    return messageContext.extras.option;
  }
  
  // 6. Check input data if it's a token transfer
  const transferData = txDetails.data ? extractERC20TransferData(txDetails.data) : null;
  if (transferData) {
    console.log(`Transfer data found: ${customJSONStringify(transferData, 2)}`);
    
    // Simple check for amount encoding (remainder approach)
    if (transferData.amount) {
      try {
        // Convert BigInt to number (safe for USDC amounts)
        const amount = Number(transferData.amount);
        const baseAmount = Math.floor(amount / 10) * 10; // Round to nearest 10
        const remainder = amount - baseAmount;
        
        if (remainder >= 1 && remainder <= 5) {
          console.log(`Detected option encoding in amount: base=${baseAmount}, remainder=${remainder}`);
          // Don't attempt to get option here, just return null
          // We'll handle this better in the main function with extractOptionFromTransferAmount
          console.log(`Option likely encoded in amount as option #${remainder}`);
        }
      } catch (error) {
        console.error("Error checking amount encoding:", error);
      }
    }
  }
  
  // 7. Look for option in any arbitrary field in the transaction reference
  const searchForOption = (obj: any, path = ''): string | null => {
    if (!obj || typeof obj !== 'object') return null;
    
    for (const key in obj) {
      const currentPath = path ? `${path}.${key}` : key;
      
      // Check if this key might contain option information
      if (['option', 'selectedOption', 'choice'].includes(key.toLowerCase())) {
        if (typeof obj[key] === 'string') {
          console.log(`Found option in arbitrary field ${currentPath}: ${obj[key]}`);
          return obj[key];
        }
      }
      
      // If the value is an object or array, search recursively
      if (obj[key] && typeof obj[key] === 'object') {
        const nestedResult = searchForOption(obj[key], currentPath);
        if (nestedResult) return nestedResult;
      }
    }
    
    return null;
  };
  
  // Try recursive search in both txDetails and txRef
  const optionInDetails = searchForOption(txDetails);
  if (optionInDetails) return optionInDetails;
  
  const optionInRef = searchForOption(txRef);
  if (optionInRef) return optionInRef;
  
  console.log("No option found in any field of the transaction data");
  return null;
}

/**
 * Extract option from transfer amount - common pattern is to add 1 or 2 to the base amount
 * to indicate the option (option 1 or option 2)
 */
async function extractOptionFromTransferAmount(transferData: any, tossId: string): Promise<string | null> {
  try {
    if (!transferData || !transferData.amount) {
      return null;
    }
    
    // Convert BigInt to number (safe for USDC amounts)
    const amount = Number(transferData.amount);
    
    // Check for amount-based encoding (increment indicates option)
    // Common pattern: 100000 (0.1 USDC) + 1 for option 1, + 2 for option 2
    const baseAmount = Math.floor(amount / 10) * 10; // Round to nearest 10
    const remainder = amount - baseAmount;
    
    // If remainder is 1 or 2, it likely indicates option 1 or 2
    if (remainder >= 1 && remainder <= 5) {
      console.log(`Detected option encoding in amount: base=${baseAmount}, remainder=${remainder}`);
      
      // Get toss details directly using the tossId that was already found
      const toss = await storage.getData("tosses", tossId);
      
      if (!toss) {
        console.log(`Could not find toss data for ID ${tossId}`);
        return null;
      }
      
      // Cast toss to GroupTossName type to access tossOptions
      const tossData = toss as GroupTossName;
      
      if (!tossData.tossOptions || !Array.isArray(tossData.tossOptions) || tossData.tossOptions.length === 0) {
        console.log(`Toss ${tossId} has no options array`);
        return null;
      }
      
      // Option index is 1-based in this encoding (remainder 1 = first option)
      const optionIndex = remainder - 1;
      if (optionIndex >= 0 && optionIndex < tossData.tossOptions.length) {
        const option = tossData.tossOptions[optionIndex];
        console.log(`Extracted option "${option}" (index ${optionIndex}) from amount remainder ${remainder}`);
        return option;
      }
    }
    
    return null;
  } catch (error) {
    console.error("Error extracting option from transfer amount:", error);
    return null;
  }
}

/**
 * Extract toss data from transaction details
 */
async function extractTossData(txDetails: any, storage: any): Promise<{tossId: string | null, targetAddress: string | null}> {
  // Get recipient address
  const transferData = txDetails.data ? extractERC20TransferData(txDetails.data) : null;
  const targetAddress = transferData?.recipient || txDetails.to;
  
  if (!targetAddress) {
    console.log("Could not determine transaction recipient");
    return {tossId: null, targetAddress: null};
  }
  
  // Find toss ID by wallet address
  const walletByAddress = await storage.getWalletByAddress(targetAddress);
  const tossId = walletByAddress?.userId;
  
  if (tossId) {
    console.log(`📌 Address ${targetAddress} belongs to toss:${tossId}`);
  }
  
  return {tossId, targetAddress};
}


/**
 * Process a toss join after receiving transaction reference
 */
export async function processTossJoin(
  client: Client,
  conversation: Conversation,
  message: DecodedMessage,
  tossManager: TossManager,
  tossId: string,
  selectedOption: string,
  txDetails: any
): Promise<void> {
  try {
    const toss = await tossManager.getToss(tossId);
    if (!toss) {
      await conversation.send(`⚠️ Toss not found. Your payment might have been received but couldn't be associated with a valid toss.`);
      return;
    }
    
    // Associate toss with conversation if needed
    const activeToss = await tossManager.getActiveTossForConversation(conversation.id);
    if (!activeToss) {
      await tossManager.setActiveTossForConversation(conversation.id, tossId);
    }
    
    // Add player to game
    const updatedToss = await tossManager.addPlayerToGame(
      tossId, 
      message.senderInboxId, 
      selectedOption, 
      true
    );
    
    // Calculate player ID
    const playerId = `P${updatedToss.participants.findIndex(p => p === message.senderInboxId) + 1}`;
    
    // Send confirmation
    let response = `✅ Successfully joined!\nAmount: ${updatedToss.tossAmount}\nChoice: ${selectedOption}\nTotal players: ${updatedToss.participants.length}`;
    
    if (updatedToss.tossTopic) {
      response += `\nToss Topic: "${updatedToss.tossTopic}"`;
    }
    
    await conversation.send(response);
    
  } catch (error) {
    await conversation.send(`⚠️ Error joining toss: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Formatting helpers ----------------------------------------

/**
 * Format toss status information
 */
function formatTossStatus(toss: GroupTossName): string {
  // Calculate total pot
  const totalPot = parseFloat(toss.tossAmount) * toss.participants.length;
  
  // Count votes for each option
  const optionVotes: Record<string, number> = {};
  
  // Initialize vote counts
  if (toss.tossOptions && toss.tossOptions.length > 0) {
    toss.tossOptions.forEach(option => {
      optionVotes[option] = 0;
    });
  } else {
    optionVotes["heads"] = 0;
    optionVotes["tails"] = 0;
  }
  
  // Count votes
  if (toss.participantOptions && toss.participantOptions.length > 0) {
    toss.participantOptions.forEach(participant => {
      optionVotes[participant.option] = (optionVotes[participant.option] || 0) + 1;
    });
  }
  
  // Build response
  let response = `${toss.tossTopic} 📊\n\n`;
  response += `Options: ${toss.tossOptions?.join(", ")}\n`;
  response += `Total Players: ${toss.participants.length}\n`;
  response += `Creator: ${toss.creator.slice(0, 6)}...\n`;
  response += `Toss Amount: ${toss.tossAmount} USDC per player\n`;
  response += `Total Pot: ${totalPot.toFixed(2)} USDC\n\n`;
  
  // Vote distribution
  if (Object.keys(optionVotes).length > 0) {
    response += "Vote Distribution:\n";

    for (const [option, count] of Object.entries(optionVotes)) {
      if (count > 0) {
        const winningsPerPerson = count > 0 ? totalPot / count : 0;
        
        response += `${option}: ${count} vote${count !== 1 ? 's' : ''}\n`;
        if (count > 0) {
          response += `   If "${option}" wins: ${winningsPerPerson.toFixed(2)} USDC per winner\n`;
        }
      }
    }
  }
  
  return response;
}

/**
 * Format toss result information
 */
function formatTossResult(toss: GroupTossName, winningOption: string | null, isForceClose: boolean): string {
  if (isForceClose) {
    let response = `🚫 Toss force closed by creator!\n\n`;
    
    if (toss.paymentSuccess) {
      response += `All participants have been refunded their ${toss.tossAmount} USDC.\n`;
    } else {
      response += "⚠️ Refund distribution failed. Please contact support.";
    }
    
    return response;
  } else {
    // Regular close with a winning option
    const winnerEntries = toss.participantOptions
      .filter((p: Participant) => p.option.toLowerCase() === winningOption?.toLowerCase());
    
    const totalPot = parseFloat(toss.tossAmount) * toss.participants.length;
    const prizePerWinner = winnerEntries.length > 0 ? totalPot / winnerEntries.length : 0;
    
    let response = `🏆 Toss closed! Result: "${winningOption}"\n\n`;
    
    if (toss.paymentSuccess) {
      response += `${winnerEntries.length} winner(s)${winnerEntries.length > 0 ? ` with option "${winningOption}"` : ""}\n`;
      response += `Prize per winner: ${prizePerWinner.toFixed(2)} USDC\n\n`;
      response += "Winners:\n";
      
      winnerEntries.forEach((winner: Participant) => {
        response += `P${toss.participants.findIndex(p => p === winner.inboxId) + 1}\n`;
      });
    } else {
      response += "⚠️ Payment distribution failed. Please contact support.";
    }
    
    return response;
  }
}
