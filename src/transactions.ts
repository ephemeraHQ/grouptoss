import { validateEnvironment } from "@helpers/client";
import type { WalletSendCallsParams } from "@xmtp/content-type-wallet-send-calls";
import { createPublicClient, formatUnits, http, toHex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { MAX_USDC_AMOUNT, networks } from "./constants";
import { Conversation } from "@xmtp/node-sdk";
import { ContentTypeTransactionReference, TransactionReference } from "@xmtp/content-type-transaction-reference";
import { NetworkConfig, TransactionDetails, ERC20TransferData } from "./types";



export class TransactionService {
  private readonly publicClient;
  private readonly networkConfig: NetworkConfig;
  
  // ERC20 minimal ABI for balance checking
  private readonly erc20Abi = [
    {
      inputs: [{ name: "account", type: "address" }],
      name: "balanceOf",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
  ] as const;
  
  /**
   * Creates a new instance of the TransactionService
   */
  constructor() {
    const { NETWORK_ID } = validateEnvironment(["NETWORK_ID"]);
    
    // Get network configuration
    const networkConfig = networks.find(
      (network) => network.networkId === NETWORK_ID
    );
    
    if (!networkConfig) {
      throw new Error(`Network ID ${NETWORK_ID} not found`);
    }
    
    this.networkConfig = networkConfig;
    
    // Create a public client for reading from the blockchain
    this.publicClient = createPublicClient({
      chain: NETWORK_ID === "base-mainnet" ? base : baseSepolia,
      transport: http(),
    });
  }
  
  /**
   * Get USDC balance for a given address
   * @param address Wallet address to check balance for
   * @returns Formatted USDC balance as a string
   */
  public async getUSDCBalance(address: string): Promise<string> {
    const balance = await this.publicClient.readContract({
      address: this.networkConfig.tokenAddress as `0x${string}`,
      abi: this.erc20Abi,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    });

    return formatUnits(balance, this.networkConfig.decimals);
  }
  
  /**
   * Verify transaction on the blockchain and extract relevant details
   * @param txHash The transaction hash
   * @returns Transaction details if successful or null if transaction not found/failed
   */
  public async verifyTransaction(txHash: string): Promise<TransactionDetails | null> {
    try {
      // Clean the transaction hash
      const cleanHash = txHash.startsWith('0x') ? txHash : `0x${txHash}`;
      
      // Get transaction receipt
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: cleanHash as `0x${string}`,
      });

      // Get transaction details
      const transaction = await this.publicClient.getTransaction({
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
      
      // Look for transaction message
      this.extractMessageMetadata(transaction, receipt, metadata);
      
      // Look for logs with data that might contain our metadata
      this.extractLogMetadata(receipt, metadata);
      
      // Check input data for metadata
      if (transaction.input && transaction.input.length > 0) {
        // Extract ERC20 transfer and check if there's any metadata encoded
        const transferData = this.extractERC20TransferData(transaction.input);
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
   * Extract transaction message metadata
   */
  private extractMessageMetadata(
    transaction: any, 
    receipt: any, 
    metadata: { selectedOption?: string; tossId?: string; [key: string]: any }
  ): void {
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
  }
  
  /**
   * Extract metadata from transaction logs
   */
  private extractLogMetadata(
    receipt: any,
    metadata: { selectedOption?: string; tossId?: string; [key: string]: any }
  ): void {
    if (!receipt.logs || receipt.logs.length === 0) return;
    
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

  /**
   * Extract token transfer information from transaction data
   * Specifically for ERC20 token transfers that use the transfer(address,uint256) function
   * @param txData Transaction input data
   * @returns Object with recipient address and amount, or null if not a valid transfer
   */
  public extractERC20TransferData(txData: string): ERC20TransferData | null {
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
  public createUSDCTransferCalls(
    fromAddress: string,
    recipientAddress: string,
    amount: number,
    additionalMetadata?: Record<string, any>,
    description?: string,
  ): WalletSendCallsParams {
    const methodSignature = "0xa9059cbb"; // Function signature for ERC20 'transfer(address,uint256)'
    
    // Check if amount exceeds maximum limit (convert from decimals to USDC units)
    const amountInUsdc = amount / Math.pow(10, this.networkConfig.decimals);
    if (amountInUsdc > MAX_USDC_AMOUNT) {
      throw new Error(`Transaction amount (${amountInUsdc} USDC) exceeds maximum limit of ${MAX_USDC_AMOUNT} USDC`);
    }
    
    // Modify amount to encode option selection directly in the transaction value
    // This ensures we can always recover the option from the blockchain, even without metadata
    let amountToSend = amount;
    
    // If this is a toss with an option, encode it in the value
    if (additionalMetadata?.selectedOption) {
      amountToSend = this.encodeOptionInAmount(amountToSend, additionalMetadata);
    }

    // Format the transaction data following ERC20 transfer standard
    const transactionData = `${methodSignature}${recipientAddress
      .slice(2)
      .padStart(64, "0")}${BigInt(amountToSend).toString(16).padStart(64, "0")}`;
    
    // Create a metadata object with the additional fields
    const metadata = {
      description: description ?? `Transfer ${amountToSend / Math.pow(10, this.networkConfig.decimals)} USDC on ${this.networkConfig.networkName}`,
      transactionType: "transfer",
      currency: "USDC",
      amount: amountToSend,
      decimals: this.networkConfig.decimals,
      networkId: this.networkConfig.networkId,
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
      chainId: this.networkConfig.chainId,
      calls: [
        {
          to: this.networkConfig.tokenAddress as `0x${string}`,
          data: transactionData as `0x${string}`,
          metadata,
        },
      ],
      metadata: additionalMetadata, // Also add at top level for redundancy
      message: messageData ? JSON.stringify(messageData) : undefined, // Add as custom message field
    };
    return walletSendCalls;
  }
  
  /**
   * Encode option selection into the transaction amount
   */
  private encodeOptionInAmount(amount: number, metadata: Record<string, any>): number {
    const selectedOption = metadata.selectedOption;
    const tossId = metadata.tossId;
    
    let amountToSend = amount;
    
    // If we have toss options, use them to determine the encoding
    if (metadata.tossOptions && metadata.tossOptions.length > 0) {
      const options = metadata.tossOptions;
      const optionIndex = options.findIndex(
        (opt: string) => opt.toLowerCase() === selectedOption.toLowerCase()
      );
      
      if (optionIndex !== -1) {
        // Add option index + 1 to the amount to encode selection (1-based index)
        // For first option: add 1, second option: add 2, etc.
        amountToSend += (optionIndex + 1);
        console.log(`Encoding option "${selectedOption}" as option #${optionIndex + 1}, adjusted amount: ${amountToSend}`);
      }
    } else if (metadata.isFirstOption !== undefined) {
      // If isFirstOption is explicitly provided, use it
      amountToSend += metadata.isFirstOption ? 1 : 2;
      console.log(`Encoding explicit option choice (${metadata.isFirstOption ? 'first' : 'second'}), adjusted amount: ${amountToSend}`);
    }
    
    // Log that we're encoding the option
    console.log(`Sending ${amountToSend} to encode option "${selectedOption}" for toss ID ${tossId || "unknown"}`);
    
    return amountToSend;
  }

  /**
   * Sleep for a specified number of milliseconds
   * @param ms Number of milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check a transaction with retries and delays
   * @param txHash Transaction hash to verify
   * @param maxRetries Maximum number of retry attempts
   * @param initialDelay Initial delay in milliseconds
   * @param backoffFactor Factor to increase delay on each retry
   * @returns The transaction details if found, or null if not found after retries
   */
  public async checkTransactionWithRetries(
    txHash: string,
    maxRetries = 5,
    initialDelay = 5000, // 5 seconds initial delay
    backoffFactor = 1.5, // Increase delay by 50% each retry
  ): Promise<TransactionDetails | null> {
    let currentDelay = initialDelay;
    
    // Wait before the first check to give the transaction time to be processed
    console.log(`Waiting ${Math.round(currentDelay / 1000)}s before checking transaction ${txHash}...`);
    await this.sleep(currentDelay);
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Checking transaction ${txHash}, attempt ${attempt + 1}/${maxRetries + 1}`);
        
        // Try to verify the transaction
        const txDetails = await this.verifyTransaction(txHash);
        
        // If we found the transaction, return it immediately
        if (txDetails) {
          console.log(`Transaction ${txHash} found with status: ${txDetails.status}`);
          return txDetails;
        }
        
        // If this was the last attempt, return null
        if (attempt === maxRetries) {
          console.log(`Transaction ${txHash} not found after ${maxRetries + 1} attempts`);
          return null;
        }
        
        // If transaction not found, wait before retrying
        console.log(`Transaction ${txHash} not found, retrying in ${Math.round(currentDelay / 1000)}s...`);
        await this.sleep(currentDelay);
        
        // Increase delay for next attempt
        currentDelay = currentDelay * backoffFactor;
      } catch (error) {
        // If this is the last attempt, rethrow
        if (attempt === maxRetries) {
          throw error;
        }
        
        console.error(`Error checking transaction (attempt ${attempt + 1}/${maxRetries + 1}):`, error);
        
        // Wait before retrying
        console.log(`Retrying in ${Math.round(currentDelay / 1000)}s...`);
        await this.sleep(currentDelay);
        
        // Increase delay for next attempt
        currentDelay = currentDelay * backoffFactor;
      }
    }
    
    // Should not reach here due to the return in the loop
    return null;
  }
}

// Export standalone functions for backward compatibility
export const getUSDCBalance = async (address: string): Promise<string> => {
  const service = new TransactionService();
  return service.getUSDCBalance(address);
};

export const verifyTransaction = async (txHash: string): Promise<TransactionDetails | null> => {
  const service = new TransactionService();
  return service.verifyTransaction(txHash);
};

export const extractERC20TransferData = (txData: string): ERC20TransferData | null => {
  const service = new TransactionService();
  return service.extractERC20TransferData(txData);
};

export const createUSDCTransferCalls = (
  fromAddress: string,
  recipientAddress: string,
  amount: number,
  additionalMetadata?: Record<string, any>,
  description?: string,
): WalletSendCallsParams => {
  const service = new TransactionService();
  return service.createUSDCTransferCalls(
    fromAddress,
    recipientAddress,
    amount,
    additionalMetadata,
    description
  );
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const checkTransactionWithRetries = async (
  txHash: string,
  maxRetries = 5,
  initialDelay = 5000,
  backoffFactor = 1.5
): Promise<TransactionDetails | null> => {
  const service = new TransactionService();
  return service.checkTransactionWithRetries(
    txHash,
    maxRetries,
    initialDelay,
    backoffFactor
  );
}; 


export async function sendTransactionReference(
  conversation: Conversation,
  transactionLink: string,
) { 
  const networkConfig = networks.find(
    (network) => network.networkId === process.env.NETWORK_ID
  );
  if (!networkConfig) {
    throw new Error(`Network ID ${process.env.NETWORK_ID} not found`);
  }
  const transactionReference : TransactionReference = {
    networkId: networkConfig.chainId,
    reference: transactionLink,
  };
  console.log(`Transaction link: ${transactionLink}`);
  console.log(`Sending transaction reference: ${JSON.stringify(transactionReference)}`);
  await conversation.send(transactionReference, ContentTypeTransactionReference);
  return true;
}
