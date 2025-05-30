import {
  ContentTypeTransactionReference,
  type TransactionReference,
} from "@xmtp/content-type-transaction-reference";
import type { WalletSendCallsParams } from "@xmtp/content-type-wallet-send-calls";
import type { Conversation } from "@xmtp/node-sdk";
import { createPublicClient, formatUnits, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { MAX_USDC_AMOUNT, networks } from "../src/constants";
import type { ERC20TransferData, TransactionDetails } from "../src/types";
import { validateEnvironment } from "./client";

// Get the network configuration based on environment
const { NETWORK_ID } = validateEnvironment(["NETWORK_ID"]);
const networkConfigResult = networks.find(
  (network) => network.networkId === NETWORK_ID,
);
if (!networkConfigResult) {
  throw new Error(`Network ID ${NETWORK_ID} not found`);
}
// Use a non-null assertion since we've verified it exists
const networkConfig = networkConfigResult;

// Create a public client for blockchain interactions
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
 * Get USDC balance for a wallet address
 */
export async function getUSDCBalance(address: string): Promise<string> {
  try {
    const balance = await publicClient.readContract({
      address: networkConfig.tokenAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    });
    return formatUnits(balance, networkConfig.decimals);
  } catch (error) {
    console.error("Error getting USDC balance:", error);
    return "0";
  }
}

/**
 * Verify transaction on the blockchain
 */
export async function verifyTransaction(
  txHash: string,
): Promise<TransactionDetails | null> {
  try {
    // Clean the transaction hash
    const cleanHash = txHash.startsWith("0x") ? txHash : `0x${txHash}`;

    // Get transaction receipt
    const receipt = await publicClient.getTransactionReceipt({
      hash: cleanHash as `0x${string}`,
    });

    // Get transaction details
    const transaction = await publicClient.getTransaction({
      hash: cleanHash as `0x${string}`,
    });

    // Check if transaction was successful
    const status = receipt.status === "success" ? "success" : "failed";

    return {
      status,
      to: transaction.to,
      from: transaction.from,
      data: transaction.input,
      value: transaction.value,
      logs: receipt.logs,
    };
  } catch (error) {
    console.error("Error verifying transaction:", error);
    return null;
  }
}

/**
 * Extract token transfer information from transaction data
 */
export function extractERC20TransferData(
  txData: string,
): ERC20TransferData | null {
  try {
    // Check if this is a standard ERC20 transfer method (0xa9059cbb)
    if (!txData || !txData.startsWith("0xa9059cbb")) {
      return null;
    }

    // Extract recipient address
    const recipientHex = `0x${txData.slice(10, 74)}`;
    const recipient = `0x${recipientHex.slice(-40)}`;

    // Extract amount
    const amountHex = `0x${txData.slice(74, 138)}`;
    const amount = BigInt(amountHex);

    return {
      recipient,
      amount,
      metadata: {},
    };
  } catch (error) {
    console.error("Error extracting ERC20 transfer data:", error);
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
  additionalMetadata?: Record<string, unknown>,
  description?: string,
): WalletSendCallsParams {
  const methodSignature = "0xa9059cbb"; // Function signature for ERC20 'transfer(address,uint256)'

  // Check if amount exceeds maximum limit
  const amountInUsdc = amount / Math.pow(10, networkConfig.decimals);
  if (amountInUsdc > MAX_USDC_AMOUNT) {
    throw new Error(
      `Transaction amount (${amountInUsdc} USDC) exceeds maximum limit of ${MAX_USDC_AMOUNT} USDC`,
    );
  }

  // Use the exact amount provided without any modifications
  const amountToSend = amount;

  // Format the transaction data following ERC20 transfer standard
  const transactionData = `${methodSignature}${recipientAddress
    .slice(2)
    .padStart(64, "0")}${BigInt(amountToSend).toString(16).padStart(64, "0")}`;

  // Create metadata with additional fields
  const callMetadata = {
    description:
      description ??
      `Transfer ${amountToSend / Math.pow(10, networkConfig.decimals)} USDC on ${networkConfig.networkName}`,
    transactionType: "transfer",
    currency: "USDC",
    amount: amountToSend,
    decimals: networkConfig.decimals,
    networkId: networkConfig.networkId,
    ...additionalMetadata,
  };

  return {
    version: "1.0",
    from: fromAddress as `0x${string}`,
    chainId: networkConfig.chainId,
    calls: [
      {
        to: networkConfig.tokenAddress as `0x${string}`,
        data: transactionData as `0x${string}`,
        metadata: callMetadata,
      },
    ],
  };
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check a transaction with retries and delays
 */
export async function checkTransactionWithRetries(
  txHash: string,
  maxRetries = 5,
  initialDelay = 5000,
  backoffFactor = 1.5,
): Promise<TransactionDetails | null> {
  let currentDelay = initialDelay;

  // Wait before the first check
  console.debug(
    `Waiting ${Math.round(currentDelay / 1000)}s before checking transaction ${txHash}...`,
  );
  await sleep(currentDelay);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.debug(
        `Checking transaction ${txHash}, attempt ${attempt + 1}/${maxRetries + 1}`,
      );

      // Try to verify the transaction
      const txDetails = await verifyTransaction(txHash);

      if (txDetails) {
        console.debug(
          `Transaction ${txHash} found with status: ${txDetails.status}`,
        );
        return txDetails;
      }

      if (attempt === maxRetries) {
        console.debug(
          `Transaction ${txHash} not found after ${maxRetries + 1} attempts`,
        );
        return null;
      }

      console.debug(
        `Transaction ${txHash} not found, retrying in ${Math.round(currentDelay / 1000)}s...`,
      );
      await sleep(currentDelay);

      // Increase delay for next attempt
      currentDelay = currentDelay * backoffFactor;
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }

      console.error(
        `Error checking transaction (attempt ${attempt + 1}/${maxRetries + 1}):`,
        error,
      );
      await sleep(currentDelay);
      currentDelay = currentDelay * backoffFactor;
    }
  }

  return null;
}

/**
 * Send a transaction reference in a conversation
 */
export async function sendTransactionReference(
  conversation: Conversation,
  transactionHash: string,
) {
  try {
    const transactionReference: TransactionReference = {
      networkId: networkConfig.chainId,
      reference: transactionHash,
    };
    console.debug(`Sending transaction reference: ${transactionHash}`);
    await conversation.send(
      transactionReference,
      ContentTypeTransactionReference,
    );
    return true;
  } catch (error) {
    console.error("Error sending transaction reference:", error);
    return false;
  }
}
