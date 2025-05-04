import * as fs from "fs/promises";
import { type createReactAgent } from "@langchain/langgraph/prebuilt";
import { WalletService } from "@helpers/cdp";
import { AgentConfig, GroupTossName, Participant, ParsedToss, TossStatus, Transfer } from "./types";
import { storage } from "./storage";
import { parseNaturalLanguageToss } from "./utils";

export class TossManager {
  private walletService: WalletService;

  constructor() {
    this.walletService = new WalletService();
  }

  async getBalance(
    inboxId: string
  ): Promise<{ address: string | undefined; balance: number }> {
    try {
      const balance = await this.walletService.checkBalance(inboxId);
      return { address: balance.address, balance: balance.balance };
    } catch (error) {
      console.error("Error getting user balance:", error);
      return { address: undefined, balance: 0 };
    }
  }

  async getPlayerWalletAddress(inboxId: string): Promise<string | undefined> {
    try {
      const walletData = await this.walletService.getWallet(inboxId);
      return walletData?.agent_address;
    } catch (error) {
      console.error(`Error getting wallet address for ${inboxId}:`, error);
      return undefined;
    }
  }

  async createGame(
    creator: string,
    tossAmount: string
  ): Promise<GroupTossName> {
    console.log(
      `🎮 CREATING NEW TOSS (Creator: ${creator}, Amount: ${tossAmount} USDC)`
    );

    // Get the next toss ID
    const lastIdToss = await this.getLastIdToss();
    const tossId = (lastIdToss + 1).toString();

    // Create a wallet for this toss
    const tossWallet = await this.walletService.createWallet(tossId);
    console.log(`✅ Toss wallet created: ${tossWallet.agent_address}`);

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
    console.log(
      `🎮 Toss ${tossId} created successfully with wallet ${tossWallet.agent_address}`
    );

    return toss;
  }

  async addPlayerToGame(
    tossId: string,
    player: string,
    chosenOption: string,
    hasPaid: boolean
  ): Promise<GroupTossName> {
    const toss = await storage.getToss(tossId);
    if (!toss) {
      throw new Error("Toss not found");
    }

    if (
      toss.status !== TossStatus.CREATED &&
      toss.status !== TossStatus.WAITING_FOR_PLAYER
    ) {
      throw new Error("Toss is not accepting players");
    }

    if (toss.participants.includes(player)) {
      throw new Error("You are already in this toss");
    }

    if (!hasPaid) {
      throw new Error(`Please pay ${toss.tossAmount} USDC to join the toss`);
    }

    // Validate the chosen option
    if (toss.tossOptions?.length) {
      const normalizedOption = chosenOption.toLowerCase();
      const normalizedAvailableOptions = toss.tossOptions.map((opt: string) =>
        opt.toLowerCase()
      );

      if (!normalizedAvailableOptions.includes(normalizedOption)) {
        throw new Error(
          `Invalid option: ${chosenOption}. Available options: ${toss.tossOptions.join(
            ", "
          )}`
        );
      }
    }

    // Add player to participants
    toss.participants.push(player);
    toss.participantOptions.push({ inboxId: player, option: chosenOption });

    // Update toss status
    toss.status = TossStatus.WAITING_FOR_PLAYER;

    await storage.updateToss(toss);
    return toss;
  }

  async joinGame(tossId: string, player: string): Promise<GroupTossName> {
    const toss = await storage.getToss(tossId);
    if (!toss) {
      throw new Error("Toss not found");
    }

    if (
      toss.status !== TossStatus.CREATED &&
      toss.status !== TossStatus.WAITING_FOR_PLAYER
    ) {
      throw new Error("Toss is not accepting players");
    }

    if (toss.participants.includes(player)) {
      throw new Error("You are already in this toss");
    }

    // Return toss info without adding player yet
    return toss;
  }

  async makePayment(
    inboxId: string,
    tossId: string,
    amount: string,
    chosenOption: string
  ): Promise<boolean> {
    console.log(
      `💸 Processing payment: User ${inboxId}, Toss ${tossId}, Amount ${amount}, Option ${chosenOption}`
    );

    try {
      // Get toss wallet
      const toss = await storage.getToss(tossId);
      if (!toss) {
        throw new Error("Toss not found");
      }

      // Transfer funds
      const transfer = await this.walletService.transfer(
        inboxId,
        toss.walletAddress,
        parseFloat(amount)
      );

      return !!transfer;
    } catch (error) {
      console.error(`❌ Payment error:`, error);
      return false;
    }
  }

  async executeCoinToss(
    tossId: string,
    winningOption: string
  ): Promise<GroupTossName> {
    console.log(
      `🎲 Executing toss: ${tossId}, winning option: ${winningOption}`
    );

    const toss = await storage.getToss(tossId);
    if (!toss) {
      throw new Error("Toss not found");
    }

    // Validate toss state
    if (toss.status !== TossStatus.WAITING_FOR_PLAYER) {
      throw new Error(`Toss is not ready (status: ${toss.status})`);
    }

    if (toss.participants.length < 2) {
      throw new Error("Toss needs at least 2 players");
    }

    if (!toss.participantOptions.length) {
      throw new Error("No participant options found");
    }

    // Get options from toss or participant choices
    const options = toss.tossOptions?.length
      ? toss.tossOptions
      : [...new Set(toss.participantOptions.map((p: Participant) => p.option))];

    if (options.length < 2) {
      throw new Error("Not enough unique options");
    }

    // Set toss in progress
    toss.status = TossStatus.IN_PROGRESS;
    await storage.updateToss(toss);

    // Validate winning option
    const matchingOption = options.find(
        (option: string) => option.toLowerCase() === winningOption.toLowerCase()
    );

    if (!matchingOption) {
      toss.status = TossStatus.CANCELLED;
      toss.paymentSuccess = false;
      await storage.updateToss(toss);
      throw new Error(`Invalid winning option: ${winningOption}`);
    }

    // Set the result
    toss.tossResult = matchingOption;

    // Find winners
    const winners = toss.participantOptions.filter(
      (p: Participant) => p.option.toLowerCase() === matchingOption.toLowerCase()
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

        const winnerWalletData = await this.walletService.getWallet(
          winner.inboxId
        );
        if (!winnerWalletData) continue;

        const transfer = await this.walletService.transfer(
          tossWallet.inboxId,
          winnerWalletData.agent_address,
          prizePerWinner
        );

        if (transfer) {
          successfulTransfers.push(winner.inboxId);

          // Set transaction link from first successful transfer
          if (!toss.transactionLink) {
            const transferData = transfer as unknown as Transfer;
            toss.transactionLink =
              transferData.model?.sponsored_send?.transaction_link;
          }
        }
      } catch (error) {
        console.error(`Transfer error for ${winner.inboxId}:`, error);
      }
    }

    // Complete the toss
    toss.status = TossStatus.COMPLETED;
    toss.winner = winners.map((w: Participant) => w.inboxId).join(",");
    toss.paymentSuccess = successfulTransfers.length === winners.length;

    await storage.updateToss(toss);
    return toss;
  }

  async getToss(tossId: string): Promise<GroupTossName | null> {
    return storage.getToss(tossId);
  }

  async getLastIdToss(): Promise<number> {
    try {
      const tossesDir = storage.getTossStorageDir();
      const files = await fs.readdir(tossesDir);

      // Extract numeric IDs from filenames (like "1-base-sepolia.json")
      const tossIds = files
        .filter((file) => file.endsWith(".json"))
        .map((file) => {
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
    console.log(
      `🎲 Creating toss from prompt: "${prompt}" (Creator: ${creator})`
    );

    // Parse the natural language prompt
    const parsedToss = await parseNaturalLanguageToss(
      agent,
      agentConfig,
      prompt
    );

    if (typeof parsedToss === "string") {
      throw new Error(parsedToss);
    }

    // Create the toss
    const toss = await this.createGame(creator, parsedToss.amount);

    // Add parsed information
    toss.tossTopic = parsedToss.topic;
    toss.tossOptions = parsedToss.options;
    await storage.updateToss(toss);

    return toss;
  }
} 