import * as fs from "fs/promises";
import { type createReactAgent } from "@langchain/langgraph/prebuilt";
import { WalletService } from "../helpers/walletService";
import { AgentConfig, GroupTossName, Participant, TossStatus } from "./types";
import { FileStorage } from "../helpers/localStorage";
import { parseNaturalLanguageToss } from "./index";
import { MAX_USDC_AMOUNT, HELP_MESSAGE } from "./constants";
import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { ContentTypeWalletSendCalls } from "@xmtp/content-type-wallet-send-calls";
import { checkTransactionWithRetries, createUSDCTransferCalls, extractERC20TransferData, sendTransactionReference } from "../helpers/transactions";


export function customJSONStringify(obj: any, space?: number | string): string {
 return JSON.stringify(obj, (key, value) => 
   typeof value === 'bigint' 
     ? value.toString() + 'n' // Append 'n' to distinguish from regular numbers
     : value
 , space);
}
/**
* Extract command from message content
*/
export function extractCommand(content: string): string | null {
 const botMentionRegex = /@toss\s+(.*)/i;
 const botMentionMatch = content.match(botMentionRegex);
 return botMentionMatch ? botMentionMatch[1].trim() : null;
}
// Storage categories
const STORAGE_CATEGORIES = {
  TOSS: "tosses"
};

export class TossManager {
  private walletService: WalletService;
  private storage: FileStorage;
  private client?: Client;

  constructor(walletService: WalletService, storage: FileStorage) {
    this.walletService = walletService;
    this.storage = storage;
  }

  async getBalance(userId: string): Promise<{ address?: string; balance: number }> {
    try {
      return await this.walletService.checkBalance(userId);
    } catch (error) {
      console.error("Error getting user balance:", error);
      return { balance: 0 };
    }
  }

  async getPlayerWalletAddress(userId: string): Promise<string | undefined> {
    try {
      return (await this.walletService.getWallet(userId))?.address;
    } catch (error) {
      console.error(`Error getting wallet address for ${userId}:`, error);
      return undefined;
    }
  }

  async createGame(creator: string, tossAmount: string, conversationId?: string): Promise<GroupTossName> {
    console.log(`🎮 CREATING NEW TOSS (Creator: ${creator}, Amount: ${tossAmount} USDC)`);
    
    // Validate toss amount
    const amount = parseFloat(tossAmount);
    if (isNaN(amount)) {
      throw new Error(`Invalid toss amount: ${tossAmount}`);
    }
    
    if (amount > MAX_USDC_AMOUNT) {
      throw new Error(`Toss amount ${amount} exceeds maximum limit of ${MAX_USDC_AMOUNT} USDC`);
    }

    const tossId = ((await this.getLastIdToss()) + 1).toString();
    const tossWallet = await this.walletService.createWallet(tossId);
    
    const toss: GroupTossName = {
      id: tossId,
      creator,
      tossAmount,
      status: TossStatus.CREATED,
      participants: [],
      participantOptions: [],
      walletAddress: tossWallet.address,
      createdAt: Date.now(),
      tossResult: "",
      paymentSuccess: false,
    };

    // If conversationId is provided, store it directly in toss object
    if (conversationId) {
      toss.conversationId = conversationId;
      console.log(`🎮 Toss ${tossId} created with wallet ${tossWallet.address} and linked to group ${conversationId}`);
    } else {
      console.log(`🎮 Toss ${tossId} created with wallet ${tossWallet.address}`);
    }

    await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
    
    return toss;
  }

  async addPlayerToGame(
    tossId: string,
    player: string,
    chosenOption: string,
    hasPaid: boolean
  ): Promise<GroupTossName> {
    const toss = await this.getToss(tossId);
    if (!toss) throw new Error("Toss not found");

    if (
      toss.status !== TossStatus.CREATED && 
      toss.status !== TossStatus.WAITING_FOR_PLAYER
    ) throw new Error("Toss is not accepting players");

    if (toss.participants.includes(player)) 
      throw new Error("You are already in this toss");

    if (!hasPaid) 
      throw new Error(`Please pay ${toss.tossAmount} USDC to join the toss`);

    // Validate chosen option
    if (toss.tossOptions?.length) {
      const normalizedOption = chosenOption.toLowerCase();
      const normalizedAvailableOptions = toss.tossOptions.map((opt: string) => opt.toLowerCase());

      if (!normalizedAvailableOptions.includes(normalizedOption)) {
        throw new Error(
          `Invalid option: ${chosenOption}. Available options: ${toss.tossOptions.join(", ")}`
        );
      }
    }

    // Add player
    toss.participants.push(player);
    toss.participantOptions.push({ inboxId: player, option: chosenOption });
    toss.status = TossStatus.WAITING_FOR_PLAYER;

    await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
    return toss;
  }

  async joinGame(tossId: string, player: string): Promise<GroupTossName> {
    const toss = await this.getToss(tossId);
    if (!toss) throw new Error("Toss not found");

    if (
      toss.status !== TossStatus.CREATED && 
      toss.status !== TossStatus.WAITING_FOR_PLAYER
    ) throw new Error("Toss is not accepting players");

    if (toss.participants.includes(player))
      throw new Error("You are already in this toss");

    // Add player to participants list without option selection
    toss.participants.push(player);
    toss.status = TossStatus.WAITING_FOR_PLAYER;
    
    // Persist changes to storage
    await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
    return toss;
  }

  async makePayment(
    userId: string,
    tossId: string,
    amount: string,
    chosenOption: string
  ): Promise<boolean> {
    console.log(`💸 Processing payment: User ${userId}, Toss ${tossId}, Amount ${amount}, Option ${chosenOption}`);

    try {
      const toss = await this.getToss(tossId);
      if (!toss) throw new Error("Toss not found");

      console.log(`✅ Recording direct transfer for user ${userId} with option ${chosenOption}`);
      
      // Create participant record
      const participant: Participant = {
        inboxId: userId,
        option: chosenOption,
      };

      // Update participants list if not already included
      if (!toss.participants.includes(userId)) {
        toss.participants.push(userId);
        toss.participantOptions.push(participant);
        await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
      }
      
      return true;
    } catch (error) {
      console.error(`❌ Payment error:`, error);
      return false;
    }
  }

  async executeToss(
    tossId: string,
    winningOption: string
  ): Promise<GroupTossName> {
    console.log(`🎲 Executing toss: ${tossId}, winning option: ${winningOption}`);

    const toss = await this.getToss(tossId);
    if (!toss) throw new Error("Toss not found");

    // Validate toss state
    if (toss.status !== TossStatus.WAITING_FOR_PLAYER)
      throw new Error(`Toss is not ready (status: ${toss.status})`);

    if (toss.participants.length < 1)
      throw new Error("Toss needs at least 1 player");

    if (!toss.participantOptions.length)
      throw new Error("No participant options found");

    // Get options
    const options = toss.tossOptions?.length
      ? toss.tossOptions
      : [...new Set(toss.participantOptions.map((p: Participant) => p.option))];

    if (options.length < 1)
      throw new Error("Not enough unique options");

    // Set toss in progress
    toss.status = TossStatus.IN_PROGRESS;
    await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);

    // Validate winning option
    const matchingOption = options.find(
      (option: string) => option.toLowerCase() === winningOption.toLowerCase()
    );

    if (!matchingOption) {
      toss.status = TossStatus.CANCELLED;
      toss.paymentSuccess = false;
      await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
      throw new Error(`Invalid winning option: ${winningOption}`);
    }

    // Set result and find winners
    toss.tossResult = matchingOption;
    const winners = toss.participantOptions.filter(
      (p: Participant) => p.option.toLowerCase() === matchingOption.toLowerCase()
    );

    if (!winners.length) {
      // No winners but complete the toss anyway
      toss.status = TossStatus.COMPLETED;
      toss.paymentSuccess = true; // No transfers needed
      toss.tossResult = matchingOption;
      await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
      return toss;
    }

    // Distribute prizes
    const tossWallet = await this.walletService.getWallet(tossId);
    if (!tossWallet) {
      toss.status = TossStatus.CANCELLED;
      toss.paymentSuccess = false;
      await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
      throw new Error("Toss wallet not found");
    }

    const totalPot = parseFloat(toss.tossAmount) * toss.participants.length;
    const prizePerWinner = totalPot / winners.length;
    const successfulTransfers: string[] = [];
    let transactionLink: string | undefined;
    let transactionHash: string | undefined;
    const failedWinners: string[] = [];

    // Make sure XMTP client is set before looking up addresses
    if (!this.client) {
      throw new Error("XMTP client not set, cannot lookup wallet addresses");
    }

    for (const winner of winners) {
      try {
        if (!winner.inboxId) {
          console.log("Skipping winner with null inboxId");
          continue;
        }

        // Get the winner's wallet address from XMTP
        let winnerAddress: string | undefined;
        try {
          const inboxState = await this.client.preferences.inboxStateFromInboxIds([winner.inboxId]);
          if (inboxState.length > 0 && inboxState[0].identifiers.length > 0) {
            winnerAddress = inboxState[0].identifiers[0].identifier;
          }
        } catch (lookupError) {
          console.log(`Error looking up address for winner ${winner.inboxId}: ${lookupError}`);
        }

        if (!winnerAddress) {
          console.log(`No address found for winner ${winner.inboxId}, skipping`);
          failedWinners.push(winner.inboxId);
          continue;
        }

        console.log(`Transferring ${prizePerWinner} USDC to winner ${winner.inboxId} at address ${winnerAddress}`);
        
        const transfer = await this.walletService.transfer(
          tossId, // Using tossId as userId for the wallet
          winnerAddress,
          prizePerWinner
        );

        if (transfer) {
          successfulTransfers.push(winner.inboxId);
          
          if (!transactionLink) {
            const transferData = transfer as any;
            // First check for our custom properties added in walletService.transfer
            if (transferData.transactionHash) {
              transactionHash = transferData.transactionHash;
              transactionLink = transferData.transactionLink;
              console.log(`📝 Using transaction hash directly from transfer object: ${transactionHash}`);
            } 
            // Fall back to the sponsored_send property
            else if (transferData.model?.sponsored_send?.transaction_hash) {
              transactionHash = transferData.model?.sponsored_send?.transaction_hash;
              transactionLink = transferData.model?.sponsored_send?.transaction_link;
              console.log(`📝 Using transaction hash from sponsored_send: ${transactionHash}`);
            }
          }
        } else {
          failedWinners.push(winner.inboxId);
        }
      } catch (error) {
        console.error(`Transfer error for ${winner.inboxId}:`, error);
        failedWinners.push(winner.inboxId);
      }
    }

    // Complete the toss, consider it successful even if some transfers failed
    toss.paymentSuccess = successfulTransfers.length > 0;
    toss.status = TossStatus.COMPLETED;
    
    if (transactionLink) {
      toss.transactionLink = transactionLink;
      toss.transactionHash = transactionHash;
    }
    
    if (failedWinners.length > 0) {
      toss.failedWinners = failedWinners;
    }
    
    await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
    return toss;
  }

  /**
   * Force close a toss and return funds to all participants
   * @param tossId The ID of the toss to force close
   * @returns The updated toss object
   */
  async forceCloseToss(tossId: string): Promise<GroupTossName> {
    console.log(`🚫 Force closing toss: ${tossId}`);

    const toss = await this.getToss(tossId);
    if (!toss) throw new Error("Toss not found");

    // Set toss in progress
    toss.status = TossStatus.IN_PROGRESS;
    await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);

    // If no participants, just mark as cancelled and return
    if (toss.participants.length === 0) {
      toss.status = TossStatus.CANCELLED;
      toss.paymentSuccess = true; // No transfers needed
      toss.tossResult = "FORCE_CLOSED";
      await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
      return toss;
    }

    // Get the toss wallet
    const tossWallet = await this.walletService.getWallet(tossId);
    if (!tossWallet) {
      toss.status = TossStatus.CANCELLED;
      toss.paymentSuccess = false;
      await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
      throw new Error("Toss wallet not found");
    }

    // Make sure XMTP client is set before looking up addresses
    if (!this.client) {
      throw new Error("XMTP client not set, cannot lookup wallet addresses");
    }

    // Track successful refunds
    const successfulTransfers: string[] = [];
    const failedRefunds: string[] = [];

    // Return funds to each participant
    for (const participant of toss.participants) {
      try {
        if (!participant) {
          console.log("Skipping null participant");
          continue;
        }

        // Get participant wallet address from XMTP
        let participantAddress: string | undefined;
        try {
          const inboxState = await this.client.preferences.inboxStateFromInboxIds([participant]);
          if (inboxState.length > 0 && inboxState[0].identifiers.length > 0) {
            participantAddress = inboxState[0].identifiers[0].identifier;
          }
        } catch (lookupError) {
          console.log(`Error looking up address for participant ${participant}: ${lookupError}`);
        }

        if (!participantAddress) {
          console.log(`No address found for participant ${participant}, skipping`);
          failedRefunds.push(participant);
          continue;
        }

        console.log(`Refunding ${toss.tossAmount} USDC to participant ${participant} at address ${participantAddress}`);
      
        // Return their original entry amount
        const transfer = await this.walletService.transfer(
          tossId, // Using tossId as userId for the wallet
          participantAddress,
          parseFloat(toss.tossAmount)
        );

        if (transfer) {
          successfulTransfers.push(participant);

          // Set transaction link from first successful transfer
          if (!toss.transactionLink) {
            const transferData = transfer as any;
            // First check for our custom properties added in walletService.transfer
            if (transferData.transactionHash) {
              toss.transactionHash = transferData.transactionHash;
              toss.transactionLink = transferData.transactionLink;
              console.log(`📝 Using transaction hash directly from transfer object: ${toss.transactionHash}`);
            } 
            // Fall back to the sponsored_send property
            else if (transferData.model?.sponsored_send?.transaction_hash) {
              toss.transactionHash = transferData.model?.sponsored_send?.transaction_hash;
              toss.transactionLink = transferData.model?.sponsored_send?.transaction_link;
              console.log(`📝 Using transaction hash from sponsored_send: ${toss.transactionHash}`);
            }
          }
        } else {
          failedRefunds.push(participant);
        }
      } catch (error) {
        console.error(`Refund error for ${participant}:`, error);
        failedRefunds.push(participant);
      }
    }

    // Mark toss as cancelled
    toss.paymentSuccess = true; // Consider it successful even if some refunds failed
    toss.status = TossStatus.CANCELLED;
    toss.tossResult = "FORCE_CLOSED";
    
    if (failedRefunds.length > 0) {
      toss.failedRefunds = failedRefunds;
    }
    
    await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
    return toss;
  }

  async getToss(tossId: string): Promise<GroupTossName | null> {
    return this.storage.getData<GroupTossName>(STORAGE_CATEGORIES.TOSS, tossId);
  }

  async getLastIdToss(): Promise<number> {
    try {
      const tossDir = `.data/${STORAGE_CATEGORIES.TOSS}`;
      const files = await fs.readdir(tossDir);
      const tossFiles = files.filter(file => file.endsWith(".json") && !isNaN(Number(file.split("-")[0])));

      if (tossFiles.length === 0) return 0;

      const lastId = Math.max(
        ...tossFiles.map(file => Number(file.split("-")[0]))
      );

      return lastId;
    } catch (error) {
      console.error("Error getting last toss ID:", error);
      return 0;
    }
  }

  async createGameFromPrompt(
    creator: string,
    prompt: string,
    agent: ReturnType<typeof createReactAgent>,
    agentConfig: AgentConfig,
    conversationId?: string
  ): Promise<GroupTossName> {
    // Generate toss details using LLM
    const parsedToss = await parseNaturalLanguageToss(agent, agentConfig, prompt);
    if (typeof parsedToss === "string") {
      throw new Error(parsedToss);
    }

    // Create base toss
    const toss = await this.createGame(creator, parsedToss.amount, conversationId);

    // Add topic and options
    toss.tossTopic = parsedToss.topic;
    toss.tossOptions = parsedToss.options;

    // Update storage
    await this.storage.saveData(STORAGE_CATEGORIES.TOSS, toss.id, toss);
    return toss;
  }

  /**
   * Get active toss ID for a conversation
   * @param conversationId The conversation ID
   * @returns The active toss ID or null if none exists
   */
  async getActiveTossForConversation(conversationId: string): Promise<GroupTossName | null> {
    // Read all tosses to find one with matching conversationId
    try {
      const tossDir = `.data/${STORAGE_CATEGORIES.TOSS}`;
      const files = await fs.readdir(tossDir);
      const tossFiles = files.filter(file => file.endsWith(".json") && !isNaN(Number(file.split("-")[0])));
      
      for (const file of tossFiles) {
        const tossId = file.split("-")[0];
        const toss = await this.getToss(tossId);
        
        if (toss && toss.conversationId === conversationId) {
          // If toss is completed or cancelled, consider it inactive
          if ([TossStatus.COMPLETED, TossStatus.CANCELLED].includes(toss.status)) {
            continue;
          }
          return toss;
        }
      }
      
      return null;
    } catch (error) {
      console.error("Error finding active toss for conversation:", error);
      return null;
    }
  }
  
  /**
   * Set the active toss for a conversation
   * @param conversationId The conversation ID
   * @param tossId The toss ID to set as active
   */
  async setActiveTossForConversation(conversationId: string, tossId: string): Promise<void> {
    const toss = await this.getToss(tossId);
    if (toss) {
      toss.conversationId = conversationId;
      await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
    }
  }
  
  /**
   * Remove the active toss mapping for a conversation
   * @param conversationId The conversation ID
   */
  async clearActiveTossForConversation(conversationId: string): Promise<void> {
    // Find the toss with this conversation ID and clear it
    const toss = await this.getActiveTossForConversation(conversationId);
    if (toss) {
      delete toss.conversationId;
      await this.storage.saveData(STORAGE_CATEGORIES.TOSS, toss.id, toss);
    }
  }

  /**
   * Main entry point for command processing
   */
  async handleCommand(
    client: Client,
    conversation: Conversation,
    message: DecodedMessage,
    isDm: boolean,
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
        return this.handleExplicitCommand(
          command, 
          commandParts.slice(1), 
          message.senderInboxId, 
          client,
          conversation,
          isDm
        );
      }
      
      // Check for existing active toss
      const existingToss = await this.getActiveTossForConversation(conversationId);
      if (existingToss) {
        return `There's already an active toss in this group. Please use or close the current toss before creating a new one.`;
      }

      console.log(`🧠 Processing prompt: "${commandContent}"`);
      await conversation.send("⏳ Thinking...");
      
      // Create toss from prompt
      const toss = await this.createGameFromPrompt(
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
        await this.sendJoinOptions(client, conversation, toss, message.senderInboxId);
      } else {
        await conversation.send("You can join by using the command: @toss join <option>");
      }
      
      return ""; // Empty string since we've sent responses directly
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Handle explicit commands (join, close, help, balance, status)
   */
  async handleExplicitCommand(
    command: string,
    args: string[],
    inboxId: string,
    client: Client,
    conversation: Conversation,
    isDm: boolean
  ): Promise<string> {
    const conversationId = conversation.id;
    
    switch (command) {
      case "balance": {
        if (!isDm) return "For checking your balance, please DM me.";
        const { balance, address } = await this.getBalance(inboxId);
        return `Your balance is ${balance} USDC. Your address is ${address}`;
      }
      
      case "status": {
        if (!conversationId) return "Tosses are only supported in group chats.";
        
        const toss = await this.getActiveTossForConversation(conversationId);
        if (!toss) return "No active toss found in this group.";
        
        return this.formatTossStatus(toss);
      }
      
      case "join": {
        if (!conversationId) return "Tosses are only supported in group chats.";
        
        const toss = await this.getActiveTossForConversation(conversationId);
        if (!toss) return "No active toss found in this group. Start one with '@toss <topic>'";
        
        if (!toss.tossOptions || toss.tossOptions.length !== 2) {
          return `This toss doesn't have exactly two options.`;
        }
        
        await conversation.send(`Join "${toss.tossTopic}" by selecting one of the options below:`);
        await this.sendJoinOptions(client, conversation, toss, inboxId);
        return "";
      }

      case "close": {
        if (!conversationId) return "Tosses are only supported in group chats.";
        
        const toss = await this.getActiveTossForConversation(conversationId);
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
            closedToss = await this.forceCloseToss(toss.id);
          } else {
            closedToss = await this.executeToss(toss.id, winningOption);
          }
          
          // Clear the group-to-toss mapping
          await this.clearActiveTossForConversation(conversationId);
          
          const response = this.formatTossResult(closedToss, winningOption, isForceClose);
          
          await conversation.send(response);
          if (closedToss.transactionHash) {
            await sendTransactionReference(conversation, closedToss.transactionHash);
          }
          
          return "";
        } catch (error) {
          return `Error closing toss: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      case "help":
      default:
        return HELP_MESSAGE;
    }
  }

  /**
   * Send join options as wallet send calls buttons
   */
  private async sendJoinOptions(
    client: Client,
    conversation: Conversation,
    toss: GroupTossName,
    senderInboxId: string
  ): Promise<void> {
    try {
      for (const option of toss.tossOptions || []) {
        const { walletSendCalls } = await this.createJoinTossWalletSendCalls(
          client, 
          toss.id, 
          toss.tossAmount, 
          toss.walletAddress, 
          senderInboxId,
          option
        );
        
        await conversation.send(walletSendCalls, ContentTypeWalletSendCalls);
      }
    } catch (error) {
      console.error("Error creating wallet send calls:", error);
      await conversation.send("Error creating join options. Please try again.");
    }
  }

  /**
   * Create wallet send calls buttons for joining a toss
   */
  private async createJoinTossWalletSendCalls(
    client: Client,
    tossId: string, 
    tossAmount: string, 
    walletAddress: string, 
    senderInboxId: string,
    option: string
  ): Promise<{ walletSendCalls: any, memberAddress: string }> {
    let amountInDecimals = Math.floor(parseFloat(tossAmount) * Math.pow(10, 6));
    
    // Get toss data and determine option position
    const toss = await this.getToss(tossId);
    const isFirstOption = toss?.tossOptions?.[0]?.toLowerCase() === option.toLowerCase();
    
    // Get the user's wallet address from inbox ID
    const inboxState = await client.preferences.inboxStateFromInboxIds([senderInboxId]);
    const memberAddress = inboxState[0].identifiers[0].identifier;
    
    if (!memberAddress) throw new Error("Unable to find member address");
    
    // Encode option selection in the amount
    if (toss?.tossOptions && option) {
      // Find option index
      const optionIndex = toss.tossOptions.findIndex(
        (opt: string) => opt.toLowerCase() === option.toLowerCase()
      );
      
      if (optionIndex !== -1) {
        // Encode option as remainder (add 1 or 2 to amount)
        amountInDecimals += (optionIndex + 1);
        console.log(`Encoding option "${option}" as option #${optionIndex + 1}, adjusted amount: ${amountInDecimals}`);
      }
    } else if (isFirstOption !== undefined) {
      // Direct encoding via isFirstOption flag
      amountInDecimals += isFirstOption ? 1 : 2;
    }
    
    console.log(`Sending ${amountInDecimals} to encode option "${option}" for toss ID ${tossId}`);
    
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

  setClient(client: Client): void {
    this.client = client;
  }

  /**
   * Process a transaction reference that might be related to a toss
   */
  async handleTransactionReference(
    client: Client,
    conversation: Conversation,
    message: DecodedMessage
  ): Promise<void> {
    try {
      // Make sure client is set for looking up addresses
      this.setClient(client);
      
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
      const tossData = await this.extractTossData(txDetails);
      if (!tossData.tossId) return;
      
      // Extract option from metadata fields
      let selectedOption = this.extractSelectedOption(txRef, txDetails, message);
      
      // If no option found in metadata, try amount-based extraction
      if (!selectedOption && transferData) {
        selectedOption = await this.extractOptionFromTransferAmount(transferData, tossData.tossId);
      }
      
      console.log(`Final extracted option: ${selectedOption || 'NONE FOUND'}`);
      
      // Verify this transaction is for the active toss in this conversation
      const activeToss = await this.getActiveTossForConversation(conversation.id);
      if (activeToss && activeToss.id !== tossData.tossId) {
        await conversation.send(`⚠️ This payment is for a different toss than the one active in this conversation.`);
        return;
      }
      
      // Process the join
      if (selectedOption) {
        await this.processTossJoin(client, conversation, message, tossData.tossId, selectedOption, txDetails);
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
   * Process a toss join after receiving transaction reference
   */
  async processTossJoin(
    client: Client,
    conversation: Conversation,
    message: DecodedMessage,
    tossId: string,
    selectedOption: string,
    txDetails: any
  ): Promise<void> {
    try {
      const toss = await this.getToss(tossId);
      if (!toss) {
        await conversation.send(`⚠️ Toss not found. Your payment might have been received but couldn't be associated with a valid toss.`);
        return;
      }
      
      // Associate toss with conversation if needed
      const activeToss = await this.getActiveTossForConversation(conversation.id);
      if (!activeToss) {
        await this.setActiveTossForConversation(conversation.id, tossId);
      }
      
      // Add player to game
      const updatedToss = await this.addPlayerToGame(
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

  /**
   * Extract toss data from transaction details
   */
  private async extractTossData(txDetails: any): Promise<{tossId: string | null, targetAddress: string | null}> {
    // Get recipient address
    const transferData = txDetails.data ? extractERC20TransferData(txDetails.data) : null;
    const targetAddress = transferData?.recipient || txDetails.to;
    
    if (!targetAddress) {
      console.log("Could not determine transaction recipient");
      return {tossId: null, targetAddress: null};
    }
    
    // Find toss ID by wallet address
    const walletByAddress = await this.storage.getWalletByAddress(targetAddress);
    const tossId = walletByAddress?.userId;
    
    if (tossId) {
      console.log(`📌 Address ${targetAddress} belongs to toss:${tossId}`);
    }
    
    return {tossId, targetAddress};
  }

  /**
   * Extract selected option from transaction data
   */
  private extractSelectedOption(txRef: any, txDetails: any, message: DecodedMessage): string | null {
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
  private async extractOptionFromTransferAmount(transferData: any, tossId: string): Promise<string | null> {
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
        const toss = await this.getToss(tossId);
        
        if (!toss) {
          console.log(`Could not find toss data for ID ${tossId}`);
          return null;
        }
        
        if (!toss.tossOptions || !Array.isArray(toss.tossOptions) || toss.tossOptions.length === 0) {
          console.log(`Toss ${tossId} has no options array`);
          return null;
        }
        
        // Option index is 1-based in this encoding (remainder 1 = first option)
        const optionIndex = remainder - 1;
        if (optionIndex >= 0 && optionIndex < toss.tossOptions.length) {
          const option = toss.tossOptions[optionIndex];
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
   * Format toss status information
   */
  private formatTossStatus(toss: GroupTossName): string {
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
  private formatTossResult(toss: GroupTossName, winningOption: string | null, isForceClose: boolean): string {
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
} 