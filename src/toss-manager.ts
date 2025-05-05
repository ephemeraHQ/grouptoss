import * as fs from "fs/promises";
import { type createReactAgent } from "@langchain/langgraph/prebuilt";
import { WalletService } from "@helpers/cdp";
import { AgentConfig, GroupTossName, Participant, TossStatus } from "./types";
import { storage } from "./storage";
import { parseNaturalLanguageToss } from "./utils";

export class TossManager {
  private walletService = new WalletService();

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

  async createGame(creator: string, tossAmount: string): Promise<GroupTossName> {
    console.log(`🎮 CREATING NEW TOSS (Creator: ${creator}, Amount: ${tossAmount} USDC)`);

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
    console.log(`🎮 Toss ${tossId} created with wallet ${tossWallet.agent_address}`);
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
    chosenOption: string
  ): Promise<boolean> {
    console.log(`💸 Processing payment: User ${inboxId}, Toss ${tossId}, Amount ${amount}, Option ${chosenOption}`);

    try {
      const toss = await storage.getToss(tossId);
      if (!toss) throw new Error("Toss not found");

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

    for (const winner of winners) {
      try {
        if (!winner.inboxId) continue;

        const winnerWallet = await this.walletService.getWallet(winner.inboxId);
        if (!winnerWallet) continue;

        const transfer = await this.walletService.transfer(
          tossWallet.inboxId,
          winnerWallet.agent_address,
          prizePerWinner
        );

        if (transfer) {
          successfulTransfers.push(winner.inboxId);

          // Set transaction link from first successful transfer
          if (!toss.transactionLink) {
            const transferData = transfer as any;
            toss.transactionLink = transferData.model?.sponsored_send?.transaction_link;
          }
        }
      } catch (error) {
        console.error(`Transfer error for ${winner.inboxId}:`, error);
      }
    }

    // Complete the toss
    toss.status = TossStatus.COMPLETED;
    toss.winner = winners.map(w => w.inboxId).join(",");
    toss.paymentSuccess = successfulTransfers.length === winners.length;

    await storage.updateToss(toss);
    return toss;
  }

  async getToss(tossId: string): Promise<GroupTossName | null> {
    return storage.getToss(tossId);
  }

  async getLastIdToss(): Promise<number> {
    try {
      const files = await fs.readdir(storage.getTossStorageDir());
      
      const tossIds = files
        .filter(file => file.endsWith(".json"))
        .map(file => {
          const match = file.match(/^(\d+)-/);
          return match ? parseInt(match[1], 10) : 0;
        });

      return tossIds.length > 0 ? Math.max(...tossIds) : 0;
    } catch (error) {
      console.error("Error counting tosses:", error);
      return 0;
    }
  }

  async createGameFromPrompt(
    creator: string,
    prompt: string,
    agent: ReturnType<typeof createReactAgent>,
    agentConfig: AgentConfig
  ): Promise<GroupTossName> {
    console.log(`🎲 Creating toss from prompt: "${prompt}" (Creator: ${creator})`);

    const parsedToss = await parseNaturalLanguageToss(agent, agentConfig, prompt);
    if (typeof parsedToss === "string") throw new Error(parsedToss);

    const toss = await this.createGame(creator, parsedToss.amount);
    toss.tossTopic = parsedToss.topic;
    toss.tossOptions = parsedToss.options;
    
    await storage.updateToss(toss);
    return toss;
  }
} 