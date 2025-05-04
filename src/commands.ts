import { type createReactAgent } from "@langchain/langgraph/prebuilt";
import { AgentConfig } from "./types";
import { HELP_MESSAGE } from "./constants";
import { TossManager } from "./toss-manager";
import { createUSDCTransferCalls } from "@helpers/usdc";
import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { parseNaturalLanguageToss } from "./utils";

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

    const commandContent = (message.content as string).replace(/^@toss\s+/i, "").trim();
    const commandParts = commandContent.split(" ");
    const command = commandParts[0].toLowerCase();

    if (["join", "close", "help","balance"].includes(command)) {
      return handleExplicitCommand(command, commandParts.slice(1), message.senderInboxId, tossManager);
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
  
  // Create toss
  const toss = await tossManager.createGameFromPrompt(message.senderInboxId, commandContent, agent, agentConfig);
  
  // Return concise response
  return `🎲 Toss Created! 🎲\n\nToss ID: ${toss.id}\nTopic: "${toss.tossTopic}"\n${
    toss.tossOptions?.length === 2 ? `Options: ${toss.tossOptions[0]} or ${toss.tossOptions[1]}\n` : ''
  }Toss Amount: ${toss.tossAmount} USDC\n\nOthers can join: join ${toss.id} <option>\nClose toss: close ${toss.id} <option>`;

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
  tossManager: TossManager
): Promise<string> {
  switch (command) {
    case "balance": {
      const { balance, address } = await tossManager.getBalance(inboxId);
      return `Your balance is ${balance} USDC. Your address is ${address}`;
    }
    case "join": {
      const [tossId, chosenOption] = args;
      
      if (!tossId) return "Please specify a toss ID: join <tossId> <option>";
      
      const toss = await tossManager.getToss(tossId);
      if (!toss) return `Toss ${tossId} not found.`;
      
      const joinedToss = await tossManager.joinGame(tossId, inboxId);
      
      if (!chosenOption) {
        const options = joinedToss.tossOptions?.length
          ? joinedToss.tossOptions.join(", ")
          : "yes, no";
        return `Please specify your option: join ${tossId} <option>\nAvailable options: ${options}`;
      }
      
      if (
        joinedToss.tossOptions &&
        !joinedToss.tossOptions.some(opt => opt.toLowerCase() === chosenOption.toLowerCase())
      ) {
        return `Invalid option: ${chosenOption}. Available options: ${joinedToss.tossOptions.join(", ")}`;
      }
      
      const paymentSuccess = await tossManager.makePayment(inboxId, tossId, toss.tossAmount, chosenOption);
      if (!paymentSuccess) return `Payment failed. Please ensure you have enough USDC and try again.`;
      
      const updatedToss = await tossManager.addPlayerToGame(tossId, inboxId, chosenOption, true);
      const playerId = `P${updatedToss.participants.findIndex(p => p === inboxId) + 1}`;
      
      let response = `Successfully joined toss ${tossId}! Payment of ${toss.tossAmount} USDC sent.\nYour Player ID: ${playerId}\nYour Choice: ${chosenOption}\nTotal players: ${updatedToss.participants.length}`;

      if (updatedToss.tossTopic) {
        response += `\nToss Topic: "${updatedToss.tossTopic}"`;
        if (updatedToss.tossOptions?.length === 2) {
          response += `\nOptions: ${updatedToss.tossOptions[0]} or ${updatedToss.tossOptions[1]}`;
        }
      }

      response += inboxId === toss.creator
        ? `\n\nAs the creator, you can close the toss with: close ${tossId} <option>`
        : `\n\nWaiting for the toss creator to close the toss.`;

      return response;
    }

    case "close": {
      const [tossId, winningOption] = args;
      
      if (!tossId) return "Please specify a toss ID: close <tossId> <option>";
      if (!winningOption) return "Please specify the winning option: close <tossId> <option>";
      
      const toss = await tossManager.getToss(tossId);
      if (!toss) return `Toss ${tossId} not found.`;
      if (inboxId !== toss.creator) return "Only the toss creator can close the toss.";
      if (toss.participants.length < 2) return "At least 2 players are needed to close the toss.";
      
      if (
        toss.tossOptions &&
        !toss.tossOptions.some(opt => opt.toLowerCase() === winningOption.toLowerCase())
      ) {
        return `Invalid option. Please choose one of: ${toss.tossOptions.join(", ")}`;
      }
      
      let result;
      try {
        result = await tossManager.executeCoinToss(tossId, winningOption);
        if (!result.winner) return "The toss failed to determine a winner. Please try again.";
      } catch (error) {
        return `Error closing toss: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
      
      // Generate player IDs and map
      const playerMap = await Promise.all(
        result.participants.map(async (player, index) => {
          const walletAddress = await tossManager.getPlayerWalletAddress(player) || player;
          return {
            id: `P${index + 1}${player === result.creator ? " (Creator)" : ""}`,
            address: player,
            walletAddress,
          };
        })
      );
      
      // Build result message
      let resultMessage = `🎲 TOSS RESULTS FOR TOSS #${tossId} 🎲\n\n`;
      
      if (result.tossTopic) {
        resultMessage += `📝 Toss: "${result.tossTopic}"\n`;
        if (result.tossOptions?.length === 2) {
          resultMessage += `🎯 Options: ${result.tossOptions[0]} or ${result.tossOptions[1]}\n\n`;
        }
      }
      
      resultMessage += `Players (${result.participants.length}):\n`;
      
      // List players with their choices
      playerMap.forEach(p => {
        const displayAddress = `${p.walletAddress.substring(0, 10)}...${p.walletAddress.substring(p.walletAddress.length - 6)}`;
        const playerOption = result.participantOptions.find(opt => opt.inboxId === p.address)?.option || "Unknown";
        resultMessage += `${p.id}: ${displayAddress} (Chose: ${playerOption})\n`;
      });
      
      // Total pot and winning info
      const totalPot = parseFloat(result.tossAmount) * result.participants.length;
      resultMessage += `\n💰 Total Pot: ${totalPot} USDC\n`;
      resultMessage += `🎯 Winning Option: ${result.tossResult || "Unknown"}\n\n`;
      
      // Winners section
      const winnerIds = result.winner ? result.winner.split(",") : [];
      const winningPlayers = playerMap.filter(p => winnerIds.includes(p.address));
      
      if (winningPlayers.length > 0) {
        const prizePerWinner = totalPot / winningPlayers.length;
        
        resultMessage += `🏆 WINNERS (${winningPlayers.length}):\n`;
        winningPlayers.forEach(winner => {
          const displayAddress = `${winner.walletAddress.substring(0, 10)}...${winner.walletAddress.substring(winner.walletAddress.length - 6)}`;
          resultMessage += `${winner.id}: ${displayAddress}\n`;
        });
        
        resultMessage += `\n💸 Prize per winner: ${prizePerWinner.toFixed(6)} USDC\n\n`;
      } else {
        resultMessage += "No winners found.\n\n";
      }
      
      if (result.paymentSuccess) {
        resultMessage += `✅ Winnings have been transferred to the winners' wallets.`;
        if (result.transactionLink) {
          resultMessage += `\n🔗 Transaction: ${result.transactionLink}`;
        }
      } else {
        resultMessage += `⚠️ Automatic transfer of winnings failed. Please contact support.`;
      }
      
      return resultMessage;
    }

    case "help":
      return HELP_MESSAGE;

    default:
      return "Unknown command. Type help to see available commands.";
  }
}


