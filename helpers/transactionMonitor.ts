import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { base, baseSepolia } from "viem/chains";
import { networks } from "../src/constants";
import { validateEnvironment } from "./client";
import type { FileStorage } from "./localStorage";

// Get network configuration
const { NETWORK_ID } = validateEnvironment(["NETWORK_ID"]);
const networkConfigResult = networks.find(
  (network) => network.networkId === NETWORK_ID,
);
if (!networkConfigResult) {
  throw new Error(`Network ID ${NETWORK_ID} not found`);
}
// Use a non-null assertion since we've verified it exists
const networkConfig = networkConfigResult;

// Create public client for monitoring
const publicClient = createPublicClient({
  chain: NETWORK_ID === "base-mainnet" ? base : baseSepolia,
  transport: http(),
});

// ERC20 Transfer event ABI
const erc20Abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export interface TransactionEvent {
  hash: string;
  from: string;
  to: string;
  value: bigint;
  blockNumber: bigint;
  timestamp?: bigint;
}

export interface MonitoredWallet {
  address: string;
  tossId: string;
  lastCheckedBlock?: bigint;
}

export class TransactionMonitor {
  private storage: FileStorage;
  private monitoredWallets: Map<string, MonitoredWallet> = new Map();
  private isMonitoring = false;
  private monitoringInterval?: NodeJS.Timeout;
  private onTransactionCallback?: (
    event: TransactionEvent,
    wallet: MonitoredWallet,
  ) => Promise<void>;

  constructor(storage: FileStorage) {
    this.storage = storage;
  }

  /**
   * Add a wallet address to monitor
   */
  async addWalletToMonitor(address: string, tossId: string): Promise<void> {
    const lowerAddress = address.toLowerCase();
    console.log(
      `📍 Adding wallet ${lowerAddress} (toss: ${tossId}) to monitoring`,
    );

    // Get current block number as starting point
    const currentBlock = await publicClient.getBlockNumber();

    this.monitoredWallets.set(lowerAddress, {
      address: lowerAddress,
      tossId,
      lastCheckedBlock: currentBlock,
    });

    console.log(`✅ Now monitoring ${this.monitoredWallets.size} wallets`);
  }

  /**
   * Remove a wallet from monitoring
   */
  removeWalletFromMonitor(address: string): void {
    const lowerAddress = address.toLowerCase();
    this.monitoredWallets.delete(lowerAddress);
    console.log(`🗑️ Removed wallet ${lowerAddress} from monitoring`);
  }

  /**
   * Set callback function for when transactions are detected
   */
  onTransaction(
    callback: (
      event: TransactionEvent,
      wallet: MonitoredWallet,
    ) => Promise<void>,
  ): void {
    this.onTransactionCallback = callback;
  }

  /**
   * Start monitoring for transactions
   */
  async startMonitoring(intervalMs: number = 30000): Promise<void> {
    if (this.isMonitoring) {
      console.log("⚠️ Transaction monitoring is already running");
      return;
    }

    this.isMonitoring = true;
    console.log(
      `🔍 Starting transaction monitoring (checking every ${intervalMs / 1000}s)`,
    );

    // Initial check
    await this.checkForNewTransactions();

    // Set up periodic monitoring
    this.monitoringInterval = setInterval(() => {
      void (async () => {
        try {
          await this.checkForNewTransactions();
        } catch (error) {
          console.error("Error during transaction monitoring:", error);
        }
      })();
    }, intervalMs);

    console.log("✅ Transaction monitoring started");
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    this.isMonitoring = false;
    console.log("🛑 Transaction monitoring stopped");
  }

  /**
   * Check for new transactions to monitored wallets
   */
  private async checkForNewTransactions(): Promise<void> {
    if (this.monitoredWallets.size === 0) {
      return;
    }

    console.debug(
      `🔍 Checking transactions for ${this.monitoredWallets.size} monitored wallets...`,
    );

    try {
      const currentBlock = await publicClient.getBlockNumber();

      for (const [, wallet] of this.monitoredWallets) {
        await this.checkWalletTransactions(wallet, currentBlock);
      }
    } catch (error) {
      console.error("Error checking for new transactions:", error);
    }
  }

  /**
   * Check transactions for a specific wallet
   */
  private async checkWalletTransactions(
    wallet: MonitoredWallet,
    currentBlock: bigint,
  ): Promise<void> {
    try {
      const fromBlock = wallet.lastCheckedBlock || currentBlock - 100n; // Check last 100 blocks if no last checked block

      console.debug(
        `Checking wallet ${wallet.address} from block ${fromBlock} to ${currentBlock}`,
      );

      // Get USDC transfer events to this wallet
      const logs = await publicClient.getLogs({
        address: networkConfig.tokenAddress as `0x${string}`,
        event: erc20Abi[0], // Transfer event
        args: {
          to: wallet.address as `0x${string}`,
        },
        fromBlock: fromBlock + 1n, // +1 to avoid checking same block twice
        toBlock: currentBlock,
      });

      console.debug(
        `Found ${logs.length} potential transactions for wallet ${wallet.address}`,
      );

      for (const log of logs) {
        const event: TransactionEvent = {
          hash: log.transactionHash,
          from: log.args.from as string,
          to: log.args.to as string,
          value: log.args.value as bigint,
          blockNumber: log.blockNumber || 0n,
        };

        console.log(`🔔 New transaction detected: ${event.hash}`);
        console.log(`  From: ${event.from}`);
        console.log(`  To: ${event.to}`);
        console.log(
          `  Amount: ${formatUnits(event.value, networkConfig.decimals)} USDC`,
        );

        // Call the callback if set
        if (this.onTransactionCallback) {
          try {
            await this.onTransactionCallback(event, wallet);
          } catch (callbackError) {
            console.error("Error in transaction callback:", callbackError);
          }
        }
      }

      // Update last checked block for this wallet
      wallet.lastCheckedBlock = currentBlock;
    } catch (error) {
      console.error(
        `Error checking transactions for wallet ${wallet.address}:`,
        error,
      );
    }
  }

  /**
   * Get current wallet balance
   */
  async getWalletBalance(address: string): Promise<string> {
    try {
      const balance = await publicClient.readContract({
        address: networkConfig.tokenAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
      });
      return formatUnits(balance, networkConfig.decimals);
    } catch (error) {
      console.error(`Error getting balance for ${address}:`, error);
      return "0";
    }
  }

  /**
   * Check if monitoring is active
   */
  isActive(): boolean {
    return this.isMonitoring;
  }

  /**
   * Get list of monitored wallets
   */
  getMonitoredWallets(): MonitoredWallet[] {
    return Array.from(this.monitoredWallets.values());
  }

  /**
   * Manual balance check for discrepancies
   */
  async performBalanceAudit(): Promise<void> {
    console.log("🔍 Performing balance audit for monitored wallets...");

    for (const [address, wallet] of this.monitoredWallets) {
      try {
        const balance = await this.getWalletBalance(address);
        console.log(
          `💰 Wallet ${address} (toss: ${wallet.tossId}): ${balance} USDC`,
        );
      } catch (error) {
        console.error(`Error checking balance for ${address}:`, error);
      }
    }
  }
}
