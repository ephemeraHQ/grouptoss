import { type createReactAgent } from "@langchain/langgraph/prebuilt";
import { AgentConfig } from "./types";
import { HELP_MESSAGE } from "./constants";
import { TossManager } from "./toss-manager";
import { createUSDCTransferCalls } from   "./transactions";
import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { parseNaturalLanguageToss } from "./utils";
import { GroupTossName, Participant } from "./types";

/**
 * Create wallet send calls buttons for joining a toss with specific options
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
  // Convert amount to decimals (6 for USDC)
  let amountInDecimals = Math.floor(parseFloat(tossAmount) * Math.pow(10, 6));
  
  // Get the toss to determine available options
  const toss = await tossManager.getToss(tossId);
  let isFirstOption = false;
  let tossOptions = null;
  
  if (toss && toss.tossOptions && toss.tossOptions.length > 0) {
    tossOptions = toss.tossOptions;
    // Check if this is the first option
    isFirstOption = toss.tossOptions[0].toLowerCase() === option.toLowerCase();
    console.log(`Option "${option}" is ${isFirstOption ? 'first' : 'second'} option out of ${tossOptions.join(', ')}`);
  }
  
  // Get the user's wallet address from their inbox ID
  const inboxState = await client.preferences.inboxStateFromInboxIds([senderInboxId]);
  const memberAddress = inboxState[0].identifiers[0].identifier;
  
  if (!memberAddress) {
    throw new Error("Unable to find member address");
  }
  
  // Create descriptive message for this option
  const description = `Join Toss #${tossId} with option "${option}" 👇`;
  
  // Create the wallet send calls with option metadata - add in multiple places for redundancy
  const walletSendCalls = createUSDCTransferCalls(
    memberAddress,
    walletAddress,
    amountInDecimals,
    // Add metadata about the option selected
    {
      tossId,
      selectedOption: option,
      option: option, // Alternative field name
      choice: option, // Another alternative field name
      description: `Option: ${option} 👇`, // Include in description too
      isFirstOption: isFirstOption, // Explicitly indicate if this is the first option
      tossOptions: tossOptions // Pass all available options
    },
    description
  );
  
  return { walletSendCalls, memberAddress };
}

/**
 * Entry point for command processing
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

    if (["join", "close", "help", "balance"].includes(command)) {
      return handleExplicitCommand(
        command, 
        commandParts.slice(1), 
        message.senderInboxId, 
        tossManager, 
        conversationId
      );
    }   
    
    // Check if there's already an active toss for this conversation
    const existingToss = await tossManager.getActiveTossForConversation(conversationId);
    if (existingToss) {
      return `There's already an active toss in this group. Please use or close the current toss before creating a new one.\n\nCurrent Toss: "${existingToss.tossTopic}"\nStatus: ${existingToss.status}\nOptions: ${existingToss.tossOptions?.join(", ") || "heads, tails"}`;
    }

    console.log(`🧠 Processing prompt: "${commandContent}"`);
    
    // Parse the toss to get the required amount
    const parsedToss = await parseNaturalLanguageToss(agent, agentConfig, commandContent);
    if (typeof parsedToss === "string") {
      return parsedToss; // Return error message if parsing failed
    }
    
    // Use the parsed amount or default to 1 USDC
    const requiredAmount = parseFloat(parsedToss.amount);
    
    // Check if user has sufficient balance
    const { balance, address:agentAddress } = await tossManager.getBalance(message.senderInboxId);
    console.log("agentAddress", agentAddress);
    if (balance < requiredAmount) {
      const amountInDecimals = Math.floor(requiredAmount * Math.pow(10, 6));
      const inboxState = await client.preferences.inboxStateFromInboxIds([
        message.senderInboxId,
      ]);
      const memberAddress = inboxState[0].identifiers[0].identifier;
      if (!memberAddress) {
        console.log("Unable to find member address, skipping");
        return "Unable to find member address, skipping";
      }
      const walletSendCalls = createUSDCTransferCalls(
        memberAddress,
        agentAddress as string,
        amountInDecimals,
      );
      console.log("Replied with wallet sendcall");
      await conversation.send(`Insufficient USDC balance. You need at least ${requiredAmount} USDC to create a toss.`);
      await conversation.send(walletSendCalls, ContentTypeWalletSendCalls);
      return ""
    }
  
    // Create toss with conversation ID
    const toss = await tossManager.createGameFromPrompt(
      message.senderInboxId, 
      commandContent, 
      agent, 
      agentConfig, 
      conversationId
    );
    
    // Send initial response about toss creation
    const responseText = `🎲 Toss Created! 🎲\n\nTopic: "${toss.tossTopic}"\n${
      toss.tossOptions?.length === 2 ? `Options: ${toss.tossOptions[0]} or ${toss.tossOptions[1]}\n` : ''
    }Toss Amount: ${toss.tossAmount} USDC\n\nTo join, select an option below:`;
    
    await conversation.send(responseText);
    
    // If we have exactly two options, send wallet send calls for both options
    if (toss.tossOptions?.length === 2) {
      // Create and send wallet send call for option 1
      try {
        const option1 = toss.tossOptions[0];
        const { walletSendCalls: option1SendCall } = await createJoinTossWalletSendCalls(
          client, 
          toss.id, 
          toss.tossAmount, 
          toss.walletAddress, 
          message.senderInboxId,
          option1,
          tossManager
        );
        
        await conversation.send(option1SendCall, ContentTypeWalletSendCalls);
        
        // Create and send wallet send call for option 2
        const option2 = toss.tossOptions[1];
        const { walletSendCalls: option2SendCall } = await createJoinTossWalletSendCalls(
          client, 
          toss.id, 
          toss.tossAmount, 
          toss.walletAddress, 
          message.senderInboxId,
          option2,
          tossManager
        );
        
        await conversation.send(option2SendCall, ContentTypeWalletSendCalls);
        
      } catch (error) {
        console.error("Error creating wallet send calls:", error);
        await conversation.send("Error creating join options. Please try again.");
      }
    } else {
      // If we don't have exactly 2 options, instruct to use the text command
      await conversation.send("You can join by using the command: @toss join <option>");
    }
    
    // Return empty string since we've already sent all responses
    return "";

  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Handle explicit commands (join, close, help)
 */
export async function handleExplicitCommand(
  command: string,
  args: string[],
  inboxId: string,
  tossManager: TossManager,
  conversationId?: string
): Promise<string> {
  switch (command) {
    case "balance": {
      const { balance, address } = await tossManager.getBalance(inboxId);
      return `Your balance is ${balance} USDC. Your address is ${address}`;
    }
    
    case "join": {
      // No conversationId means we're in a DM, which we don't support for toss
      if (!conversationId) {
        return "Tosses are only supported in group chats.";
      }
      
      // Get the active toss for this conversation
      const toss = await tossManager.getActiveTossForConversation(conversationId);
      if (!toss) {
        return "No active toss found in this group. Start one with '@toss <topic>'";
      }
      
      const tossId = toss.id;
      const chosenOption = args.length > 0 ? args.join(" ") : null;
      
      if (!chosenOption) {
        const options = toss.tossOptions?.length
          ? toss.tossOptions.join(", ")
          : "yes, no";
        return `Please specify your option: @toss join <option>\nAvailable options: ${options}`;
      }
      
      // Validate the option
      if (
        toss.tossOptions &&
        !toss.tossOptions.some(opt => opt.toLowerCase() === chosenOption.toLowerCase())
      ) {
        return `Invalid option: ${chosenOption}. Available options: ${toss.tossOptions.join(", ")}`;
      }
      
      // Try to join the toss
      const joinedToss = await tossManager.joinGame(tossId, inboxId);
      
      // Process payment
      const paymentSuccess = await tossManager.makePayment(inboxId, tossId, toss.tossAmount, chosenOption);
      if (!paymentSuccess) {
        return `Payment failed. Please ensure you have enough USDC and try again.`;
      }
      
      // Add player with chosen option
      const updatedToss = await tossManager.addPlayerToGame(tossId, inboxId, chosenOption, true);
      const playerId = `P${updatedToss.participants.findIndex(p => p === inboxId) + 1}`;
      
      let response = `Successfully joined toss! Payment of ${toss.tossAmount} USDC sent.\nYour Player ID: ${playerId}\nYour Choice: ${chosenOption}\nTotal players: ${updatedToss.participants.length}`;

      if (updatedToss.tossTopic) {
        response += `\nToss Topic: "${updatedToss.tossTopic}"`;
        if (updatedToss.tossOptions?.length === 2) {
          response += `\nOptions: ${updatedToss.tossOptions[0]} or ${updatedToss.tossOptions[1]}`;
        }
      }

      return response;
    }

    case "close": {
      // No conversationId means we're in a DM, which we don't support for toss
      if (!conversationId) {
        return "Tosses are only supported in group chats.";
      }
      
      // Get the active toss for this conversation
      const toss = await tossManager.getActiveTossForConversation(conversationId);
      if (!toss) {
        return "No active toss found in this group.";
      }
      
      const tossId = toss.id;
      const winningOption = args.length > 0 ? args.join(" ") : null;
      
      // Check if user is the creator
      if (inboxId !== toss.creator) {
        return "Only the toss creator can close the toss.";
      }
      
      // Check if force close is requested (no winning option provided)
      const isForceClose = !winningOption;
      
      // Check if there are enough players for a regular close
      if (toss.participants.length < 2 && !isForceClose) {
        return "Not enough participants to determine a winner. To force close and return funds, use '@toss close' without specifying an option.";
      }
      
      // Execute the toss with the specified winning option or force close
      try {
        let closedToss: GroupTossName;
        
        if (isForceClose) {
          // Force close and return funds to original participants
          closedToss = await tossManager.forceCloseToss(tossId);
          
          // Clear the group-to-toss mapping after the toss is closed
          await tossManager.clearActiveTossForConversation(conversationId);
          
          let response = `🚫 Toss force closed by creator!\n\n`;
          
          if (closedToss.paymentSuccess) {
            response += `All participants have been refunded their ${toss.tossAmount} USDC.\n`;
            
            if (closedToss.transactionLink) {
              response += `\nTransaction: ${closedToss.transactionLink}`;
            }
          } else {
            response += "⚠️ Refund distribution failed. Please contact support.";
          }
          
          return response;
        } else {
          // Regular close with a winning option
          closedToss = await tossManager.executeCoinToss(tossId, winningOption);
          
          // Clear the group-to-toss mapping after the toss is closed
          await tossManager.clearActiveTossForConversation(conversationId);
          
          // Format winners
          const winnerEntries = closedToss.participantOptions
            .filter((p: Participant) => p.option.toLowerCase() === winningOption.toLowerCase());
          
          const totalPot = parseFloat(closedToss.tossAmount) * closedToss.participants.length;
          const prizePerWinner = totalPot / winnerEntries.length;
          
          let response = `🏆 Toss closed! Result: "${winningOption}"\n\n`;
          
          if (closedToss.paymentSuccess) {
            response += `${winnerEntries.length} winner(s)${winnerEntries.length > 0 ? ` with option "${winningOption}"` : ""}\n`;
            response += `Prize per winner: ${prizePerWinner.toFixed(2)} USDC\n\n`;
            response += "Winners:\n";
            
            winnerEntries.forEach((winner: Participant) => {
              response += `P${closedToss.participants.findIndex(p => p === winner.inboxId) + 1}\n`;
            });
            
            if (closedToss.transactionLink) {
              response += `\nTransaction: ${closedToss.transactionLink}`;
            }
          } else {
            response += "⚠️ Payment distribution failed. Please contact support.";
          }
          
          return response;
        }
      } catch (error) {
        return `Error closing toss: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    case "help":
    default:
      return HELP_MESSAGE;
  }
}


