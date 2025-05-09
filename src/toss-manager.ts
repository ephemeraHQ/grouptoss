import * as fs from "fs/promises";
import { type createReactAgent } from "@langchain/langgraph/prebuilt";
import { WalletService } from "@helpers/cdp";
import { AgentConfig, GroupTossName, Participant, TossStatus } from "./types";
import { storage } from "./storage";
import { parseNaturalLanguageToss } from "./utils";
import { MAX_USDC_AMOUNT } from "./constants";
import { Client } from "@xmtp/node-sdk";
import { createUSDCTransferCalls } from "./transactions";

export class TossManager {
  private walletService = new WalletService();
  private client?: Client;

  // Getter for walletService
  get walletServiceInstance(): WalletService {
    return this.walletService;
  }

  async getBalance(inboxId: string): Promise<{ address?: string; balance: number }> {
    try {
      return await this.walletService.checkBalance(inboxId);
    } catch (error) {
      console.error("Error getting user balance:", error);
      return { balance: 0 };
    }
  }

  async getPlayerWalletAddress(inboxId: string): Promise<string | undefined> {
    try {
      return (await this.walletService.getWallet(inboxId))?.agent_address;
    } catch (error) {
      console.error(`Error getting wallet address for ${inboxId}:`, error);
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
      walletAddress: tossWallet.agent_address,
      createdAt: Date.now(),
      tossResult: "",
      paymentSuccess: false,
    };

    await storage.saveToss(toss);
    
    // If conversationId is provided, associate this toss with the conversation
    if (conversationId) {
      await storage.saveGroupTossMapping(conversationId, tossId);
      console.log(`🎮 Toss ${tossId} created with wallet ${tossWallet.agent_address} and linked to group ${conversationId}`);
    } else {
      console.log(`🎮 Toss ${tossId} created with wallet ${tossWallet.agent_address}`);
    }
    
    return toss;
  }

  async addPlayerToGame(
    tossId: string,
    player: string,
    chosenOption: string,
    hasPaid: boolean
  ): Promise<GroupTossName> {
    const toss = await storage.getToss(tossId);
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
      const normalizedAvailableOptions = toss.tossOptions.map(opt => opt.toLowerCase());

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

    await storage.updateToss(toss);
    return toss;
  }

  async joinGame(tossId: string, player: string): Promise<GroupTossName> {
    const toss = await storage.getToss(tossId);
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
    await storage.updateToss(toss);
    return toss;
  }

  async makePayment(
    inboxId: string,
    tossId: string,
    amount: string,
    chosenOption: string,
    isDirectTransfer = false
  ): Promise<boolean> {
    console.log(`💸 Processing payment: User ${inboxId}, Toss ${tossId}, Amount ${amount}, Option ${chosenOption}`);

    try {
      const toss = await storage.getToss(tossId);
      if (!toss) throw new Error("Toss not found");

      // For direct transfers, we don't need to execute a transfer since it was already done
      // Just record the participant and their chosen option
      if (isDirectTransfer) {
        console.log(`✅ Recording direct transfer for user ${inboxId} with option ${chosenOption}`);
        
        // Create participant record
        const participant: Participant = {
          inboxId,
          option: chosenOption,
        };

        // Update participants list if not already included
        if (!toss.participants.includes(inboxId)) {
          toss.participants.push(inboxId);
          toss.participantOptions.push(participant);
          await storage.updateToss(toss);
        }
        
        return true;
      }

      // For regular transfers via the agent wallet
      return !!await this.walletService.transfer(
        inboxId,
        toss.walletAddress,
        parseFloat(amount)
      );
    } catch (error) {
      console.error(`❌ Payment error:`, error);
      return false;
    }
  }

  async executeCoinToss(
    tossId: string,
    winningOption: string
  ): Promise<GroupTossName> {
    console.log(`🎲 Executing toss: ${tossId}, winning option: ${winningOption}`);

    const toss = await storage.getToss(tossId);
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
      : [...new Set(toss.participantOptions.map(p => p.option))];

    if (options.length < 2)
      throw new Error("Not enough unique options");

    // Set toss in progress
    toss.status = TossStatus.IN_PROGRESS;
    await storage.updateToss(toss);

    // Validate winning option
    const matchingOption = options.find(
      option => option.toLowerCase() === winningOption.toLowerCase()
    );

    if (!matchingOption) {
      toss.status = TossStatus.CANCELLED;
      toss.paymentSuccess = false;
      await storage.updateToss(toss);
      throw new Error(`Invalid winning option: ${winningOption}`);
    }

    // Set result and find winners
    toss.tossResult = matchingOption;
    const winners = toss.participantOptions.filter(
      p => p.option.toLowerCase() === matchingOption.toLowerCase()
    );

    if (!winners.length) {
      toss.status = TossStatus.CANCELLED;
      toss.paymentSuccess = false;
      await storage.updateToss(toss);
      throw new Error(`No winners found for option: ${matchingOption}`);
    }

    // Distribute prizes
    const tossWallet = await this.walletService.getWallet(tossId);
    if (!tossWallet) {
      toss.status = TossStatus.CANCELLED;
      toss.paymentSuccess = false;
      await storage.updateToss(toss);
      throw new Error("Toss wallet not found");
    }

    const totalPot = parseFloat(toss.tossAmount) * toss.participants.length;
    const prizePerWinner = totalPot / winners.length;
    const successfulTransfers: string[] = [];
    let transactionLink: string | undefined;

    // Calculate prize amount in decimals (USDC has 6 decimals)
    const prizeAmountInDecimals = Math.floor(prizePerWinner * Math.pow(10, 6));

    for (const winner of winners) {
      try {
        if (!winner.inboxId) continue;

        if (!this.client) {
          console.log("No client available to get user addresses, falling back to wallet retrieval method");
          // Fall back to original method if client not available
          const winnerWallet = await this.walletService.getWallet(winner.inboxId);
          if (!winnerWallet) continue;

          const transfer = await this.walletService.transfer(
            tossWallet.inboxId,
            winnerWallet.agent_address,
            prizePerWinner
          );

          if (transfer) {
            successfulTransfers.push(winner.inboxId);
            
            if (!transactionLink) {
              const transferData = transfer as any;
              transactionLink = transferData.model?.sponsored_send?.transaction_link;
            }
          }
        } else {
          // Get winner's wallet address directly from their inboxId using XMTP client
          try {
            const inboxState = await this.client.preferences.inboxStateFromInboxIds([winner.inboxId]);
            if (!inboxState || !inboxState[0]?.identifiers[0]?.identifier) {
              console.log(`Could not find wallet address for winner ${winner.inboxId}`);
              continue;
            }
            
            const winnerAddress = inboxState[0].identifiers[0].identifier;
            console.log(`Found winner address ${winnerAddress} for ${winner.inboxId}`);
            
            // Mark as successful - the actual transfer will happen via wallet-send-calls
            successfulTransfers.push(winner.inboxId);
            
            // In a real implementation, you would record planned transfers here
            // and possibly send wallet-send-calls messages to the toss group
          } catch (error) {
            console.error(`Error getting wallet address for ${winner.inboxId}:`, error);
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
    }
    
    await storage.updateToss(toss);
    return toss;
  }

  /**
   * Force close a toss and return funds to all participants
   * @param tossId The ID of the toss to force close
   * @returns The updated toss object
   */
  async forceCloseToss(tossId: string): Promise<GroupTossName> {
    console.log(`🚫 Force closing toss: ${tossId}`);

    const toss = await storage.getToss(tossId);
    if (!toss) throw new Error("Toss not found");

    // Set toss in progress
    toss.status = TossStatus.IN_PROGRESS;
    await storage.updateToss(toss);

    // Get the toss wallet
    const tossWallet = await this.walletService.getWallet(tossId);
    if (!tossWallet) {
      toss.status = TossStatus.CANCELLED;
      toss.paymentSuccess = false;
      await storage.updateToss(toss);
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
          tossWallet.inboxId,
          participantWallet.agent_address,
          parseFloat(toss.tossAmount)
        );

        if (transfer) {
          successfulTransfers.push(participant);

          // Set transaction link from first successful transfer
          if (!toss.transactionLink) {
            const transferData = transfer as any;
            toss.transactionLink = transferData.model?.sponsored_send?.transaction_link;
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
    
    await storage.updateToss(toss);
    return toss;
  }

  async getToss(tossId: string): Promise<GroupTossName | null> {
    return storage.getToss(tossId);
  }

  async getLastIdToss(): Promise<number> {
    try {
      const files = await fs.readdir(storage.getTossStorageDir());
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
    await storage.updateToss(toss);
    return toss;
  }

  /**
   * Get active toss ID for a conversation
   * @param conversationId The conversation ID
   * @returns The active toss ID or null if none exists
   */
  async getActiveTossForConversation(conversationId: string): Promise<GroupTossName | null> {
    const tossId = await storage.getGroupTossMapping(conversationId);
    if (!tossId) return null;
    
    const toss = await this.getToss(tossId);
    
    // If toss is completed or cancelled, remove the mapping
    if (toss && [TossStatus.COMPLETED, TossStatus.CANCELLED].includes(toss.status)) {
      await storage.removeGroupTossMapping(conversationId);
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
    await storage.saveGroupTossMapping(conversationId, tossId);
  }
  
  /**
   * Remove the active toss mapping for a conversation
   * @param conversationId The conversation ID
   */
  async clearActiveTossForConversation(conversationId: string): Promise<void> {
    await storage.removeGroupTossMapping(conversationId);
  }

  setClient(client: Client): void {
    this.client = client;
  }

  /**
   * Generate wallet-send-calls parameters for distributing winnings
   * from a toss wallet to a winner
   */
  async createWinningsTransferCalls(
    tossId: string,
    winnerInboxId: string,
    amount: number
  ): Promise<any | null> {
    if (!this.client) {
      console.error("Client not available for wallet address resolution");
      return null;
    }

    try {
      // Get the toss details
      const toss = await this.getToss(tossId);
      if (!toss) {
        console.error(`Toss ${tossId} not found`);
        return null;
      }

      // Convert amount to decimals (6 for USDC)
      const amountInDecimals = Math.floor(amount * Math.pow(10, 6));
      
      // Get the toss wallet
      const tossWallet = await this.walletService.getWallet(tossId);
      if (!tossWallet) {
        console.error(`Toss wallet for ${tossId} not found`);
        return null;
      }
      
      // Get winner's wallet address
      const inboxState = await this.client.preferences.inboxStateFromInboxIds([winnerInboxId]);
      if (!inboxState || !inboxState[0]?.identifiers[0]?.identifier) {
        console.error(`Could not find wallet address for winner ${winnerInboxId}`);
        return null;
      }
      
      const winnerAddress = inboxState[0].identifiers[0].identifier;
      
      // Create the wallet send calls with metadata
      const description = `Winnings from Toss #${tossId} 🏆`;
      
      const walletSendCalls = createUSDCTransferCalls(
        tossWallet.agent_address,
        winnerAddress,
        amountInDecimals,
        {
          tossId,
          isWinnings: true,
          description: `Toss #${tossId} Winnings 🏆`,
        },
        description
      );
      
      return walletSendCalls;
    } catch (error) {
      console.error(`Error creating winnings transfer call: ${error}`);
      return null;
    }
  }
} 