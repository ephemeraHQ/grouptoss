import {
  AgentKit,
  cdpApiActionProvider,
  cdpWalletActionProvider,
  erc20ActionProvider,
  walletActionProvider,
} from "@coinbase/agentkit";
import "dotenv/config";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import {
  Coinbase,
  TimeoutError,
  Wallet,
  type Transfer as CoinbaseTransfer,
  type Trade,
  type WalletData,
} from "@coinbase/coinbase-sdk";
import { validateEnvironment } from "./client";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { isAddress } from "viem";

// Initialize the SDK when the module is loaded
let sdkInitialized = false;

// Wallet data interface
export type WalletInfo = {
  id: string;
  walletData: WalletData;
  address: string;
  userId: string;
  wallet?: Wallet;
};

// Storage interface for persisting wallet data
export interface WalletStorage {
  saveWallet(userId: string, walletData: string): Promise<void>;
  getWallet(userId: string): Promise<any | null>;
  getWalletByAddress(address: string): Promise<any | null>;
}

const { CDP_API_KEY_NAME, CDP_API_KEY_PRIVATE_KEY, NETWORK_ID } =
  validateEnvironment([
    "CDP_API_KEY_NAME",
    "CDP_API_KEY_PRIVATE_KEY",
    "NETWORK_ID",
  ]);

// Global stores for memory and agent instances
const memoryStore: Record<string, MemorySaver> = {};
const agentStore: Record<string, ReturnType<typeof createReactAgent>> = {};

export async function initializeAgent(userId: string, instruction: string) {
  try {
    // Check if we already have an agent for this user
    if (userId in agentStore) {
      console.log(`Using existing agent for user: ${userId}`);
      const agentConfig = {
        configurable: { thread_id: `Agent for ${userId}` },
      };
      return { agent: agentStore[userId], config: agentConfig };
    }

    console.log(`Initializing agent for user: ${userId}`);

    const llm = new ChatOpenAI({
      modelName: "gpt-4.1",
    });

    const agentkit = await AgentKit.from({
      cdpApiKeyName: CDP_API_KEY_NAME,
      cdpApiKeyPrivateKey: CDP_API_KEY_PRIVATE_KEY,
      actionProviders: [
        walletActionProvider(),
        erc20ActionProvider(),
        cdpApiActionProvider({
          apiKeyName: CDP_API_KEY_NAME,
          apiKeyPrivateKey: CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
        cdpWalletActionProvider({
          apiKeyName: CDP_API_KEY_NAME,
          apiKeyPrivateKey: CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      ],
    });

    console.log("AgentKit initialized successfully");

    const tools = await getLangChainTools(agentkit);

    // Get or create memory saver for this user
    if (!(userId in memoryStore)) {
      console.log(`Creating new memory store for user: ${userId}`);
      memoryStore[userId] = new MemorySaver();
    } else {
      console.log(`Using existing memory store for user: ${userId}`);
    }

    const agentConfig = {
      configurable: { thread_id: `Agent for ${userId}` },
    };

    const agent = createReactAgent({
      llm,
      tools,
      checkpointSaver: memoryStore[userId],
      messageModifier: instruction,
    });

    // Store the agent for future use
    agentStore[userId] = agent;

    console.log("Agent created successfully");
    return { agent, config: agentConfig };
  } catch (error) {
    console.error("Failed to initialize agent:", error);
    throw error;
  }
}

function initializeCoinbaseSDK(): boolean {
  try {
    Coinbase.configure({
      apiKeyName: CDP_API_KEY_NAME,
      privateKey: CDP_API_KEY_PRIVATE_KEY,
    });
    console.log("Coinbase SDK initialized successfully, network:", NETWORK_ID);
    return true;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Failed to initialize Coinbase SDK:", errorMessage);
    return false;
  }
}

export class WalletService {
  private storage: WalletStorage;
  private maxTransferAmount: number;

  constructor(storage: WalletStorage, maxTransferAmount = 100) {
    this.storage = storage;
    this.maxTransferAmount = maxTransferAmount;
    
    if (!sdkInitialized) {
      sdkInitialized = initializeCoinbaseSDK();
    }
  }

  async createWallet(userId: string): Promise<WalletInfo> {
    try {
      console.log(`Creating new wallet for user ${userId}...`);

      // Initialize SDK if not already done
      if (!sdkInitialized) {
        sdkInitialized = initializeCoinbaseSDK();
      }

      // Log the network we're using
      console.log(`Creating wallet on network: ${NETWORK_ID}`);

      // Create wallet
      const wallet = await Wallet.create({
        networkId: NETWORK_ID,
      }).catch((err: unknown) => {
        const errorDetails =
          typeof err === "object" ? JSON.stringify(err, null, 2) : err;
        console.error("Detailed wallet creation error:", errorDetails);
        throw err;
      });

      console.log("Wallet created successfully, exporting data...");
      const data = wallet.export();

      console.log("Getting default address...");
      const address = await wallet.getDefaultAddress();
      const walletAddress = address.getId();

      const walletInfo: WalletInfo = {
        id: walletAddress,
        wallet: wallet,
        walletData: data,
        address: walletAddress,
        userId: userId,
      };

      await this.storage.saveWallet(
        userId,
        JSON.stringify({
          id: walletInfo.id,
          walletData: walletInfo.walletData,
          address: walletInfo.address,
          userId: walletInfo.userId,
        })
      );
      console.log("Wallet created and saved successfully");
      return walletInfo;
    } catch (error: unknown) {
      console.error("Failed to create wallet:", error);

      // Provide more detailed error information
      if (error instanceof Error) {
        throw new Error(`Wallet creation failed: ${error.message}`);
      }

      throw new Error(`Failed to create wallet: ${String(error)}`);
    }
  }

  async getWallet(userId: string): Promise<WalletInfo | undefined> {
    const walletData = await this.storage.getWallet(userId);
    if (walletData === null) {
        console.log(`No wallet found ${userId}, creating new one`);
        return this.createWallet(userId);
    }

    const importedWallet = await Wallet.import(walletData.walletData);

    return {
      id: importedWallet.getId() ?? "",
      wallet: importedWallet,
      walletData: walletData.walletData,
      address: walletData.address,
      userId: walletData.userId,
    };
  }

  async getWalletByAddress(address: string): Promise<WalletInfo | null> {
    if (!isAddress(address)) return null;

    try {
      // Look for wallet with this address
      const walletData = await this.storage.getWalletByAddress(address);
      if (walletData) {
        const importedWallet = await Wallet.import(walletData.walletData);
        return {
          id: importedWallet.getId() ?? "",
          wallet: importedWallet,
          walletData: walletData.walletData,
          address: walletData.address,
          userId: walletData.userId,
        };
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`Error looking up wallet by address: ${errorMessage}`);
    }

    return null;
  }

  async transfer(
    fromUserId: string,
    toAddress: string,
    amount: number
  ): Promise<CoinbaseTransfer | undefined> {
    if (!toAddress) {
      console.error(`❌ Invalid destination address: null or undefined`);
      return undefined;
    }
    
    toAddress = toAddress.toLowerCase();

    console.log("📤 TRANSFER INITIATED");
    console.log(`💸 Amount: ${amount} USDC`);
    console.log(`🔍 From user: ${fromUserId}`);
    console.log(`🔍 To: ${toAddress}`);

    // Validate amount is not above the maximum limit
    if (amount > this.maxTransferAmount) {
      console.error(`❌ Amount ${amount} exceeds maximum limit of ${this.maxTransferAmount} USDC`);
      return undefined;
    }

    // Get the source wallet
    console.log(`🔑 Retrieving source wallet for user: ${fromUserId}...`);
    const from = await this.getWallet(fromUserId);
    if (!from) {
      console.error(`❌ No wallet found for sender: ${fromUserId}`);
      return undefined;
    }
    console.log(`✅ Source wallet found: ${from.address}`);

    if (!Number(amount)) {
      console.error(`❌ Invalid amount: ${amount}`);
      return undefined;
    }

    // Check balance
    console.log(`💰 Checking balance for source wallet: ${from.address}...`);
    const balance = await from.wallet?.getBalance(Coinbase.assets.Usdc);
    console.log(`💵 Available balance: ${Number(balance)} USDC`);

    if (Number(balance) < amount) {
      console.error(
        `❌ Insufficient balance. Required: ${amount} USDC, Available: ${Number(
          balance
        )} USDC`
      );
      return undefined;
    }

    if (!isAddress(toAddress) && !toAddress.includes(":")) {
      // If this is not an address, and not a user ID, we can't transfer
      console.error(`❌ Invalid destination address: ${toAddress}`);
      return undefined;
    }

    // Get or validate destination wallet
    let destinationAddress = toAddress;
    console.log(`🔑 Validating destination: ${toAddress}...`);

    // Check if this address belongs to a wallet in our system
    const existingWallet = await this.getWalletByAddress(toAddress);
    if (existingWallet) {
      // Use the address from our system
      console.log(`✅ Using existing wallet with address: ${existingWallet.address}`);
      destinationAddress = existingWallet.address;
    } else {
      console.log(`ℹ️ Using raw address as destination: ${destinationAddress}`);
    }

    try {
      console.log(
        `🚀 Executing transfer of ${amount} USDC from ${from.address} to ${destinationAddress}...`
      );
      const transfer = await from.wallet?.createTransfer({
        amount,
        assetId: Coinbase.assets.Usdc,
        destination: destinationAddress,
        gasless: true,
      });
      
      if (!transfer) {
        console.error(`❌ Failed to create transfer`);
        return undefined;
      }
      console.log(JSON.stringify(transfer, null, 2));
     
      console.log(`⚠️ Transfer initiated and processing on blockchain`);
      console.log(`ℹ️ Note: The transaction will continue processing on the blockchain even though we're not waiting for confirmation`);
      
      // Return the transfer object immediately
      return transfer;
      
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`❌ Transfer failed:`, errorMessage);
      throw error;
    }
  }

  async checkBalance(
    userId: string
  ): Promise<{ address: string | undefined; balance: number }> {
    // Check if this is an address
    if (isAddress(userId)) {
      const walletByAddress = await this.getWalletByAddress(userId);
      if (walletByAddress) {
        const balance = await walletByAddress.wallet?.getBalance(
          Coinbase.assets.Usdc
        );
        return {
          address: walletByAddress.address,
          balance: Number(balance),
        };
      }
    }

    // Normal wallet lookup by user ID
    const walletData = await this.getWallet(userId);

    if (!walletData) {
      return { address: undefined, balance: 0 };
    }

    const balance = await walletData.wallet?.getBalance(Coinbase.assets.Usdc);
    return {
      address: walletData.address,
      balance: Number(balance),
    };
  }

  async swap(
    userId: string,
    fromAssetId: string,
    toAssetId: string,
    amount: number
  ): Promise<Trade | undefined> {
    // Check if this is an address
    if (isAddress(userId)) {
      const walletByAddress = await this.getWalletByAddress(userId);
      if (walletByAddress) {
        const trade = await walletByAddress.wallet?.createTrade({
          amount,
          fromAssetId,
          toAssetId,
        });

        if (!trade) return undefined;

        try {
          await trade.wait();
        } catch (err) {
          if (!(err instanceof TimeoutError)) {
            console.error("Error while waiting for trade to complete: ", err);
          }
        }

        return trade;
      }
    }

    // Normal wallet lookup by user ID
    const walletData = await this.getWallet(userId);
    if (!walletData) return undefined;

    const trade = await walletData.wallet?.createTrade({
      amount,
      fromAssetId,
      toAssetId,
    });

    if (!trade) return undefined;

    try {
      await trade.wait();
    } catch (err) {
      if (!(err instanceof TimeoutError)) {
        console.error("Error while waiting for trade to complete: ", err);
      }
    }

    return trade;
  }
}
