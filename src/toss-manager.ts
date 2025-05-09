import * as fs from "fs/promises";
import { type createReactAgent } from "@langchain/langgraph/prebuilt";
import { WalletService } from "../helpers/walletService";
import { AgentConfig, GroupTossName, Participant, TossStatus } from "./types";
import { FileStorage } from "../helpers/storage";
import { parseNaturalLanguageToss } from "./utils";
import { MAX_USDC_AMOUNT } from "./constants";
import { Client } from "@xmtp/node-sdk";

// Storage categories
const STORAGE_CATEGORIES = {
  TOSS: "tosses",
  GROUP_MAPPING: "tosses/group_mapping"
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

    await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
    
    // If conversationId is provided, associate this toss with the conversation
    if (conversationId) {
      await this.storage.saveData(STORAGE_CATEGORIES.GROUP_MAPPING, conversationId, { tossId });
      console.log(`🎮 Toss ${tossId} created with wallet ${tossWallet.address} and linked to group ${conversationId}`);
    } else {
      console.log(`🎮 Toss ${tossId} created with wallet ${tossWallet.address}`);
    }
    
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

    if (toss.participants.length < 2)
      throw new Error("Toss needs at least 2 players");

    if (!toss.participantOptions.length)
      throw new Error("No participant options found");

    // Get options
    const options = toss.tossOptions?.length
      ? toss.tossOptions
      : [...new Set(toss.participantOptions.map((p: Participant) => p.option))];

    if (options.length < 2)
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
      toss.status = TossStatus.CANCELLED;
      toss.paymentSuccess = false;
      await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
      throw new Error(`No winners found for option: ${matchingOption}`);
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

    for (const winner of winners) {
      try {
        if (!winner.inboxId) continue;

        const winnerWallet = await this.walletService.getWallet(winner.inboxId);
        if (!winnerWallet) continue;

        
        const transfer = await this.walletService.transfer(
          tossId, // Using tossId as userId for the wallet
          winnerWallet.address,
          prizePerWinner
        );

        if (transfer) {
          successfulTransfers.push(winner.inboxId);
          
          if (!transactionLink) {
            const transferData = transfer as any;
            transactionLink = transferData.model?.sponsored_send?.transaction_link;
            transactionHash = transferData.model?.sponsored_send?.transaction_hash;
          }
        }
      } catch (error) {
        console.error(`Transfer error for ${winner.inboxId}:`, error);
      }
    }

    // Complete the toss
    toss.paymentSuccess = successfulTransfers.length > 0;
    toss.status = successfulTransfers.length > 0 
      ? TossStatus.COMPLETED 
      : TossStatus.CANCELLED;
    
    if (transactionLink) {
      toss.transactionLink = transactionLink;
      toss.transactionHash = transactionHash;
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

    // Get the toss wallet
    const tossWallet = await this.walletService.getWallet(tossId);
    if (!tossWallet) {
      toss.status = TossStatus.CANCELLED;
      toss.paymentSuccess = false;
      await this.storage.saveData(STORAGE_CATEGORIES.TOSS, tossId, toss);
      throw new Error("Toss wallet not found");
    }

    // Track successful refunds
    const successfulTransfers: string[] = [];

    // Return funds to each participant
    for (const participant of toss.participants) {
      try {
        if (!participant) continue;

        // Get participant wallet
        const participantWallet = await this.walletService.getWallet(participant);
        if (!participantWallet) continue;

      
        // Return their original entry amount
        const transfer = await this.walletService.transfer(
          tossId, // Using tossId as userId for the wallet
          participantWallet.address,
          parseFloat(toss.tossAmount)
        );

        if (transfer) {
          successfulTransfers.push(participant);

          // Set transaction link from first successful transfer
          if (!toss.transactionLink) {
            const transferData = transfer as any;
            toss.transactionLink = transferData.model?.sponsored_send?.transaction_link;
            toss.transactionHash = transferData.model?.sponsored_send?.transaction_hash;
          }
        }
      } catch (error) {
        console.error(`Refund error for ${participant}:`, error);
      }
    }

    // Mark toss as cancelled
    toss.paymentSuccess = successfulTransfers.length > 0;
    toss.status = TossStatus.CANCELLED;
    toss.tossResult = "FORCE_CLOSED";
    
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
    const mapping = await this.storage.getData<{ tossId: string }>(STORAGE_CATEGORIES.GROUP_MAPPING, conversationId);
    if (!mapping) return null;
    
    const toss = await this.getToss(mapping.tossId);
    
    // If toss is completed or cancelled, remove the mapping
    if (toss && [TossStatus.COMPLETED, TossStatus.CANCELLED].includes(toss.status)) {
      await this.storage.deleteData(STORAGE_CATEGORIES.GROUP_MAPPING, conversationId);
      return null;
    }
    
    return toss;
  }
  
  /**
   * Set the active toss for a conversation
   * @param conversationId The conversation ID
   * @param tossId The toss ID to set as active
   */
  async setActiveTossForConversation(conversationId: string, tossId: string): Promise<void> {
    await this.storage.saveData(STORAGE_CATEGORIES.GROUP_MAPPING, conversationId, { tossId });
  }
  
  /**
   * Remove the active toss mapping for a conversation
   * @param conversationId The conversation ID
   */
  async clearActiveTossForConversation(conversationId: string): Promise<void> {
    await this.storage.deleteData(STORAGE_CATEGORIES.GROUP_MAPPING, conversationId);
  }

  setClient(client: Client): void {
    this.client = client;
  }
} 