import { type createReactAgent } from "@langchain/langgraph/prebuilt";
import { AgentConfig } from "./types";
import { HELP_MESSAGE } from "./constants";
import { TossManager } from "./toss-manager";

/**
 * Entry point for command processing
 */
export async function handleCommand(
  content: string,
  inboxId: string,
  tossManager: TossManager,
  agent: ReturnType<typeof createReactAgent>,
  agentConfig: AgentConfig
): Promise<string> {
  try {
    const commandParts = content.split(" ");
    const firstWord = commandParts[0].toLowerCase();

    if (["join", "close", "help"].includes(firstWord)) {
      const [command, ...args] = commandParts;
      return await handleExplicitCommand(command, args, inboxId, tossManager);
    } else {
      return await handleNaturalLanguageCommand(
        content,
        inboxId,
        tossManager,
        agent,
        agentConfig
      );
    }
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
  switch (command.toLowerCase()) {
    case "join": {
      // Validate arguments
      if (args.length < 1) {
        return "Please specify: join <tossId> <option>";
      }

      const tossId = args[0];
      const chosenOption = args.length >= 2 ? args[1] : null;

      if (!tossId) {
        return "Please specify a toss ID: join <tossId> <option>";
      }

      // Check if toss exists
      const toss = await tossManager.getToss(tossId);
      if (!toss) {
        return `Toss ${tossId} not found.`;
      }

      // Join the game
      const joinedToss = await tossManager.joinGame(tossId, inboxId);

      // Check if option was provided
      if (!chosenOption) {
        const availableOptions = joinedToss.tossOptions?.length
          ? joinedToss.tossOptions.join(", ")
          : "yes, no";

        return `Please specify your option: join ${tossId} <option>\nAvailable options: ${availableOptions}`;
      }

      // Validate option
      if (
        joinedToss.tossOptions &&
        !joinedToss.tossOptions.some(
          (option) => option.toLowerCase() === chosenOption.toLowerCase()
        )
      ) {
        return `Invalid option: ${chosenOption}. Available options: ${joinedToss.tossOptions.join(
          ", "
        )}`;
      }

      // Make payment
      const paymentSuccess = await tossManager.makePayment(
        inboxId,
        tossId,
        toss.tossAmount,
        chosenOption
      );

      if (!paymentSuccess) {
        return `Payment failed. Please ensure you have enough USDC and try again.`;
      }

      // Add player after payment confirmed
      const updatedToss = await tossManager.addPlayerToGame(
        tossId,
        inboxId,
        chosenOption,
        true
      );

      // Generate player ID
      const playerPosition =
        updatedToss.participants.findIndex((p) => p === inboxId) + 1;
      const playerId = `P${playerPosition}`;

      // Create response
      let response = `Successfully joined toss ${tossId}! Payment of ${toss.tossAmount} USDC sent.
Your Player ID: ${playerId}
Your Choice: ${chosenOption}
Total players: ${updatedToss.participants.length}`;

      if (updatedToss.tossTopic) {
        response += `\nToss Topic: "${updatedToss.tossTopic}"`;

        if (updatedToss.tossOptions?.length === 2) {
          response += `\nOptions: ${updatedToss.tossOptions[0]} or ${updatedToss.tossOptions[1]}`;
        }
      }

      response +=
        inboxId === toss.creator
          ? `\n\nAs the creator, you can close the toss with: close ${tossId} <option>`
          : `\n\nWaiting for the toss creator to close the toss.`;

      return response;
    }

    case "close": {
      const tossId = args[0];
      const winningOption = args[1];

      if (!tossId) {
        return "Please specify a toss ID: close <tossId> <option>";
      }

      if (!winningOption) {
        return "Please specify the winning option: close <tossId> <option>";
      }

      // Validate toss and permissions
      const toss = await tossManager.getToss(tossId);
      if (!toss) {
        return `Toss ${tossId} not found.`;
      }

      if (inboxId !== toss.creator) {
        return "Only the toss creator can close the toss.";
      }

      if (toss.participants.length < 2) {
        return "At least 2 players are needed to close the toss.";
      }

      // Validate winning option
      if (
        toss.tossOptions &&
        !toss.tossOptions.some(
          (option) => option.toLowerCase() === winningOption.toLowerCase()
        )
      ) {
        return `Invalid option. Please choose one of: ${toss.tossOptions.join(
          ", "
        )}`;
      }

      // Execute toss
      let result;
      try {
        result = await tossManager.executeCoinToss(tossId, winningOption);
        if (!result.winner) {
          return "The toss failed to determine a winner. Please try again.";
        }
      } catch (error) {
        return `Error closing toss: ${
          error instanceof Error ? error.message : "Unknown error"
        }`;
      }

      // Generate player IDs
      const playerMap = await Promise.all(
        result.participants.map(async (player, index) => {
          const walletAddress =
            (await tossManager.getPlayerWalletAddress(player)) || player;
          return {
            id: `P${index + 1}${player === result.creator ? " (Creator)" : ""}`,
            address: player,
            walletAddress,
          };
        })
      );

      // Create result message
      let resultMessage = `🎲 TOSS RESULTS FOR TOSS #${tossId} 🎲\n\n`;

      if (result.tossTopic) {
        resultMessage += `📝 Toss: "${result.tossTopic}"\n`;
        if (result.tossOptions?.length === 2) {
          resultMessage += `🎯 Options: ${result.tossOptions[0]} or ${result.tossOptions[1]}\n\n`;
        }
      }

      resultMessage += `Players (${result.participants.length}):\n`;

      // List players
      playerMap.forEach((p) => {
        const displayAddress = `${p.walletAddress.substring(
          0,
          10
        )}...${p.walletAddress.substring(p.walletAddress.length - 6)}`;
        const playerOption =
          result.participantOptions.find((opt) => opt.inboxId === p.address)
            ?.option || "Unknown";
        resultMessage += `${p.id}: ${displayAddress} (Chose: ${playerOption})\n`;
      });

      // Total pot
      const totalPot =
        parseFloat(result.tossAmount) * result.participants.length;
      resultMessage += `\n💰 Total Pot: ${totalPot} USDC\n`;
      resultMessage += `🎯 Winning Option: ${
        result.tossResult || "Unknown"
      }\n\n`;

      // Winners
      const winnerIds = result.winner ? result.winner.split(",") : [];
      const winningPlayers = playerMap.filter((p) =>
        winnerIds.includes(p.address)
      );

      if (winningPlayers.length > 0) {
        const prizePerWinner = totalPot / winningPlayers.length;

        resultMessage += `🏆 WINNERS (${winningPlayers.length}):\n`;
        winningPlayers.forEach((winner) => {
          const displayAddress = `${winner.walletAddress.substring(
            0,
            10
          )}...${winner.walletAddress.substring(
            winner.walletAddress.length - 6
          )}`;
          resultMessage += `${winner.id}: ${displayAddress}\n`;
        });

        resultMessage += `\n💸 Prize per winner: ${prizePerWinner.toFixed(
          6
        )} USDC\n\n`;
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

/**
 * Handle natural language toss commands
 */
export async function handleNaturalLanguageCommand(
  prompt: string,
  inboxId: string,
  tossManager: TossManager,
  agent: ReturnType<typeof createReactAgent>,
  agentConfig: AgentConfig
): Promise<string> {
  console.log(`🧠 Processing prompt: "${prompt}"`);

  // Check balance
  const { balance, address } = await tossManager.getBalance(inboxId);
  if (balance < 0.01) {
    return `Insufficient USDC balance. You need at least 0.01 USDC to create a toss. Your balance: ${balance} USDC\nTransfer USDC to your wallet address: ${address}`;
  }

  // Create toss
  const toss = await tossManager.createGameFromPrompt(
    inboxId,
    prompt,
    agent,
    agentConfig
  );

  // Create response
  let response = `🎲 Toss Created! 🎲\n\n`;
  response += `Toss ID: ${toss.id}\n`;
  response += `Topic: "${toss.tossTopic}"\n`;

  if (toss.tossOptions?.length === 2) {
    response += `Options: ${toss.tossOptions[0]} or ${toss.tossOptions[1]}\n`;
  }

  response += `Toss Amount: ${toss.tossAmount} USDC\n\n`;
  response += `Other players can join with: join ${toss.id} <option>\n`;
  response += `When everyone has joined, you can close the toss with: close ${toss.id} <option>`;

  return response;
} 