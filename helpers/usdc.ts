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
  metadata?: {
    selectedOption?: string;
    tossId?: string;
    [key: string]: any;
  };
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
    
    // Try to extract metadata from transaction logs
    let metadata: { selectedOption?: string; tossId?: string; [key: string]: any } = {};
    
    // Look for transaction message (may be added by wallet apps like Coinbase Wallet)
    // Transaction messages may be in logs or separate data field in some chains
    try {
      const messageData = (transaction as any).message || (receipt as any).message;
      if (messageData) {
        console.log(`Found transaction message: ${messageData}`);
        if (typeof messageData === 'string' && messageData.includes('{') && messageData.includes('}')) {
          try {
            const jsonData = JSON.parse(messageData);
            if (jsonData.option) {
              metadata.selectedOption = jsonData.option;
            }
            if (jsonData.tossId) {
              metadata.tossId = jsonData.tossId;
            }
            console.log(`Extracted metadata from transaction message: ${JSON.stringify(metadata)}`);
          } catch (jsonError) {
            // Ignore JSON parsing errors
          }
        }
      }
    } catch (error) {
      // Ignore any errors when accessing potential message fields
    }
    
    // Look for logs with data that might contain our metadata
    if (receipt.logs && receipt.logs.length > 0) {
      for (const log of receipt.logs) {
        try {
          if (log.data && log.data !== '0x') {
            // Try to decode any hex strings that might contain JSON
            const hexData = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
            const asciiData = Buffer.from(hexData, 'hex').toString('utf8');
            
            // Check if the data contains JSON
            if (asciiData.includes('{') && asciiData.includes('}')) {
              try {
                const jsonStartIndex = asciiData.indexOf('{');
                const jsonEndIndex = asciiData.lastIndexOf('}') + 1;
                const jsonString = asciiData.slice(jsonStartIndex, jsonEndIndex);
                const jsonData = JSON.parse(jsonString);
                
                // Look for metadata fields
                if (jsonData.selectedOption || jsonData.tossId || jsonData.option) {
                  if (jsonData.option && !metadata.selectedOption) {
                    metadata.selectedOption = jsonData.option;
                  }
                  if (jsonData.selectedOption && !metadata.selectedOption) {
                    metadata.selectedOption = jsonData.selectedOption;
                  }
                  if (jsonData.tossId && !metadata.tossId) {
                    metadata.tossId = jsonData.tossId;
                  }
                  console.log(`Found metadata in transaction log: ${JSON.stringify(metadata)}`);
                }
              } catch (jsonError) {
                // Ignore JSON parsing errors
              }
            }
          }
        } catch (logError) {
          // Skip any errors in individual log processing
        }
      }
    }
    
    // Check input data for metadata
    if (transaction.input && transaction.input.length > 0) {
      // Extract ERC20 transfer and check if there's any metadata encoded
      const transferData = extractERC20TransferData(transaction.input);
      if (transferData && transferData.metadata) {
        // Check if there's any metadata in the transfer data
        if (transferData.metadata.selectedOption && !metadata.selectedOption) {
          metadata.selectedOption = transferData.metadata.selectedOption;
        }
        if (transferData.metadata.tossId && !metadata.tossId) {
          metadata.tossId = transferData.metadata.tossId;
        }
      }
    }

    // Extract relevant information
    return {
      status,
      to: transaction.to,
      from: transaction.from,
      data: transaction.input,
      value: transaction.value,
      logs: receipt.logs,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined
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
  metadata?: {
    selectedOption?: string;
    tossId?: string;
    [key: string]: any;
  };
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

    // Try to extract any metadata from the remaining data
    // For standard ERC20 transfers there isn't any, but we return an empty object to satisfy typing
    return { 
      recipient, 
      amount,
      metadata: {}  // Default empty metadata
    };
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
  
  // Modify amount to encode option selection directly in the transaction value
  // This ensures we can always recover the option from the blockchain, even without metadata
  let amountToSend = amount;
  
  // If this is a toss with an option, encode it in the value
  if (additionalMetadata?.selectedOption) {
    const selectedOption = additionalMetadata.selectedOption;
    const tossId = additionalMetadata.tossId;
    
    // If we have toss options, use them to determine the encoding
    if (additionalMetadata.tossOptions && additionalMetadata.tossOptions.length > 0) {
      const options = additionalMetadata.tossOptions;
      const optionIndex = options.findIndex(
        (opt: string) => opt.toLowerCase() === selectedOption.toLowerCase()
      );
      
      if (optionIndex !== -1) {
        // Add option index + 1 to the amount to encode selection (1-based index)
        // For first option: add 1, second option: add 2, etc.
        amountToSend += (optionIndex + 1);
        console.log(`Encoding option "${selectedOption}" as option #${optionIndex + 1}, adjusted amount: ${amountToSend}`);
      }
    } else if (additionalMetadata.isFirstOption !== undefined) {
      // If isFirstOption is explicitly provided, use it
      amountToSend += additionalMetadata.isFirstOption ? 1 : 2;
      console.log(`Encoding explicit option choice (${additionalMetadata.isFirstOption ? 'first' : 'second'}), adjusted amount: ${amountToSend}`);
    }
    
    // Log that we're encoding the option
    console.log(`Sending ${amountToSend} to encode option "${selectedOption}" for toss ID ${tossId || "unknown"}`);
  }

  // Format the transaction data following ERC20 transfer standard
  const transactionData = `${methodSignature}${recipientAddress
    .slice(2)
    .padStart(64, "0")}${BigInt(amountToSend).toString(16).padStart(64, "0")}`;

  const config = networks.find((network) => network.networkId === NETWORK_ID);
  if (!config) {
    throw new Error("Network not found");
  }
  
  // Create a metadata object with the additional fields
  const metadata = {
    description: description ?? `Transfer ${amountToSend / Math.pow(10, config.decimals)} USDC on ${config.networkName}`,
    transactionType: "transfer",
    currency: "USDC",
    amount: amountToSend,
    decimals: config.decimals,
    networkId: config.networkId,
    ...additionalMetadata  // Merge additional metadata if provided
  };
  
  // Add metadata to the message field if selectedOption is present
  // This helps ensure the option is preserved in the transaction
  let messageData = null;
  if (additionalMetadata?.selectedOption) {
    messageData = {
      option: additionalMetadata.selectedOption,
      tossId: additionalMetadata.tossId || "",
    };
  }
  
  const walletSendCalls = {
    version: "1.0",
    from: fromAddress as `0x${string}`,
    chainId: config.chainId,
    calls: [
      {
        to: config.tokenAddress as `0x${string}`,
        data: transactionData as `0x${string}`,
        metadata,
      },
      /* add more calls here */
    ],
    metadata: additionalMetadata, // Also add at top level for redundancy
    message: messageData ? JSON.stringify(messageData) : undefined, // Add as custom message field
  };
  return walletSendCalls;
}
