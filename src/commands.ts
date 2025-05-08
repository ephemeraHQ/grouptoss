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

    if (["join", "close", "help", "balance","status"].includes(command)) {
      return handleExplicitCommand(
        command, 
        commandParts.slice(1), 
        message.senderInboxId, 
        tossManager, 
        conversationId,
        client,
        conversation,
        isDm
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
  conversationId?: string,
  client?: Client,
  conversation?: Conversation,
  isDm: boolean
): Promise<string> {
  switch (command) {
    case "balance": {
      if(!isDm) {
        return "For checking your balance, please DM me.";
      }
      const { balance, address } = await tossManager.getBalance(inboxId);
      return `Your balance is ${balance} USDC. Your address is ${address}`;
    }
    
    case "status": {
      // No conversationId means we're in a DM, which we don't support for toss
      if (!conversationId) {
        return "Tosses are only supported in group chats.";
      }
      
      // Get the active toss for this conversation
      const toss = await tossManager.getActiveTossForConversation(conversationId);
      if (!toss) {
        return "No active toss found in this group.";
      }
      
      // Calculate total pot
      const totalPot = parseFloat(toss.tossAmount) * toss.participants.length;
      
      // Count votes for each option
      const optionVotes: Record<string, number> = {};
      
      // Initialize vote counts for all options
      if (toss.tossOptions && toss.tossOptions.length > 0) {
        toss.tossOptions.forEach(option => {
          optionVotes[option] = 0;
        });
      } else {
        // Default to heads/tails if no options
        optionVotes["heads"] = 0;
        optionVotes["tails"] = 0;
      }
      
      // Count votes by option
      if (toss.participantOptions && toss.participantOptions.length > 0) {
        toss.participantOptions.forEach(participant => {
          const option = participant.option;
          optionVotes[option] = (optionVotes[option] || 0) + 1;
        });
      }
      
      // Build response
      let response = `📊 Toss Status 📊\n\n`;
      response += `Topic: "${toss.tossTopic}"\n`;
      response += `Total Players: ${toss.participants.length}\n`;
      response += `Toss Amount: ${toss.tossAmount} USDC per player\n`;
      response += `Total Pot: ${totalPot.toFixed(2)} USDC\n\n`;
      
      // Vote distribution
      response += "Vote Distribution:\n";
      for (const [option, count] of Object.entries(optionVotes)) {
        if (count > 0) {
          // Calculate potential winnings if this option wins
          const winnersCount = count;
          const winningsPerPerson = winnersCount > 0 ? totalPot / winnersCount : 0;
          
          response += `${option}: ${count} vote${count !== 1 ? 's' : ''}\n`;
          if (winnersCount > 0) {
            response += `   If "${option}" wins: ${winningsPerPerson.toFixed(2)} USDC per winner\n`;
          }
        }
      }
      
      return response;
    }
    
    case "join": {
      // No conversationId means we're in a DM, which we don't support for toss
      if (!conversationId || !client || !conversation) {
        return "Tosses are only supported in group chats.";
      }
      
      // Get the active toss for this conversation
      const toss = await tossManager.getActiveTossForConversation(conversationId);
      if (!toss) {
        return "No active toss found in this group. Start one with '@toss <topic>'";
      }
      
      const tossId = toss.id;
      
      // Require two options
      if (!toss.tossOptions || toss.tossOptions.length !== 2) {
        return `This toss doesn't have exactly two options.`;
      }
      
      try {
        // Send a message first
        await conversation.send(`Join Toss #${tossId} by selecting one of the options below:`);
        
        // Create and send wallet send call for option 1
        const option1 = toss.tossOptions[0];
        const { walletSendCalls: option1SendCall } = await createJoinTossWalletSendCalls(
          client, 
          tossId, 
          toss.tossAmount, 
          toss.walletAddress, 
          inboxId,
          option1,
          tossManager
        );
        
        await conversation.send(option1SendCall, ContentTypeWalletSendCalls);
        
        // Create and send wallet send call for option 2
        const option2 = toss.tossOptions[1];
        const { walletSendCalls: option2SendCall } = await createJoinTossWalletSendCalls(
          client, 
          tossId, 
          toss.tossAmount, 
          toss.walletAddress, 
          inboxId,
          option2,
          tossManager
        );
        
        await conversation.send(option2SendCall, ContentTypeWalletSendCalls);
        
        // Return empty string since we've already sent all responses directly
        return "";
      } catch (error) {
        console.error("Error creating wallet send calls:", error);
        return `Error creating payment options. Please try again.`;
      }
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


