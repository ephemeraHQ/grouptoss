import { validateEnvironment } from "@helpers/client";
import type { WalletSendCallsParams } from "@xmtp/content-type-wallet-send-calls";
import { createPublicClient, formatUnits, http, toHex } from "viem";
import { base, baseSepolia } from "viem/chains";

const { NETWORK_ID } = validateEnvironment(["NETWORK_ID"]);

// Configuration constants
const networks = [
  {
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
    chainId: toHex(84532), // Base Sepolia network ID (84532 in hex)
    decimals: 6,
    networkName: "Base Sepolia",
    networkId: "base-sepolia",
  },
  {
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base Mainnet
    chainId: toHex(8453), // Base Mainnet network ID (8453 in hex)
    decimals: 6,
    networkName: "Base Mainnet",
    networkId: "base-mainnet",
  },
];

// Create a public client for reading from the blockchain
const publicClient = createPublicClient({
  chain: NETWORK_ID === "base-mainnet" ? base : baseSepolia,
  transport: http(),
});

// ERC20 minimal ABI for balance checking
const erc20Abi = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * Get USDC balance for a given address
 */
export async function getUSDCBalance(address: string): Promise<string> {
  const balance = await publicClient.readContract({
    address: networks.find((network) => network.networkId === NETWORK_ID)
      ?.tokenAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  });

  return formatUnits(
    balance,
    networks.find((network) => network.networkId === NETWORK_ID)?.decimals ?? 6,
  );
}

/**
 * Verify transaction on the blockchain and extract relevant details
 * @param txHash The transaction hash
 * @returns Transaction details if successful or null if transaction not found/failed
 */
export async function verifyTransaction(txHash: string): Promise<{
  status: 'success' | 'failed' | 'pending';
  to: string | null;
  from: string | null;
  data: string | null;
  value: bigint | null;
  logs?: any[];
} | null> {
  try {
    // Clean the transaction hash
    const cleanHash = txHash.startsWith('0x') ? txHash : `0x${txHash}`;
    
    // Get transaction receipt
    const receipt = await publicClient.getTransactionReceipt({
      hash: cleanHash as `0x${string}`,
    });

    // Get transaction details
    const transaction = await publicClient.getTransaction({
      hash: cleanHash as `0x${string}`,
    });

    // Check if transaction was successful
    const status = receipt.status === 'success' 
      ? 'success' 
      : receipt.status === 'reverted' 
        ? 'failed' 
        : 'pending';

    // Extract relevant information
    return {
      status,
      to: transaction.to,
      from: transaction.from,
      data: transaction.input,
      value: transaction.value,
      logs: receipt.logs,
    };
  } catch (error) {
    console.error('Error verifying transaction:', error);
    return null;
  }
}

/**
 * Extract token transfer information from transaction data
 * Specifically for ERC20 token transfers that use the transfer(address,uint256) function
 * @param txData Transaction input data
 * @returns Object with recipient address and amount, or null if not a valid transfer
 */
export function extractERC20TransferData(txData: string): { 
  recipient: string; 
  amount: bigint;
} | null {
  try {
    // Check if this is a standard ERC20 transfer method (0xa9059cbb)
    if (!txData || !txData.startsWith('0xa9059cbb')) {
      return null;
    }

    // Extract recipient address (32 bytes after the method signature)
    const recipientHex = `0x${txData.slice(10, 74)}`;
    // Convert to a proper address by taking only the last 40 characters
    const recipient = `0x${recipientHex.slice(-40)}`;

    // Extract amount (last 32 bytes)
    const amountHex = `0x${txData.slice(74, 138)}`;
    const amount = BigInt(amountHex);

    return { recipient, amount };
  } catch (error) {
    console.error('Error extracting ERC20 transfer data:', error);
    return null;
  }
}

/**
 * Create wallet send calls parameters for USDC transfer
 */
export function createUSDCTransferCalls(
  fromAddress: string,
  recipientAddress: string,
  amount: number,
  additionalMetadata?: Record<string, any>,
  description?: string,
): WalletSendCallsParams {
  const methodSignature = "0xa9059cbb"; // Function signature for ERC20 'transfer(address,uint256)'

  // Format the transaction data following ERC20 transfer standard
  const transactionData = `${methodSignature}${recipientAddress
    .slice(2)
    .padStart(64, "0")}${BigInt(amount).toString(16).padStart(64, "0")}`;

  const config = networks.find((network) => network.networkId === NETWORK_ID);
  if (!config) {
    throw new Error("Network not found");
  }
  const walletSendCalls = {
    version: "1.0",
    from: fromAddress as `0x${string}`,
    chainId: config.chainId,
    calls: [
      {
        to: config.tokenAddress as `0x${string}`,
        data: transactionData as `0x${string}`,
        metadata: {
          description: description ?? `Transfer ${amount / Math.pow(10, config.decimals)} USDC on ${config.networkName}`,
          transactionType: "transfer",
          currency: "USDC",
          amount: amount,
          decimals: config.decimals,
          networkId: config.networkId,
          ...additionalMetadata  // Merge additional metadata if provided
        },
      },
      /* add more calls here */
    ],
  };
  return walletSendCalls;
}
