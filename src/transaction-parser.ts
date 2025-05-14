import { GroupTossName } from "./types";
import { customJSONStringify } from "./toss-manager";
import { extractERC20TransferData } from "../helpers/transactions";
import { FileStorage } from "../helpers/localStorage";

/**
 * Extract toss data from transaction details
 */
export async function extractTossData(
  txDetails: any, 
  storage: FileStorage
): Promise<{tossId: string | null, targetAddress: string | null}> {
  // Get recipient address
  const transferData = txDetails.data ? extractERC20TransferData(txDetails.data) : null;
  const targetAddress = transferData?.recipient || txDetails.to;
  
  if (!targetAddress) {
    console.log("Could not determine transaction recipient");
    return {tossId: null, targetAddress: null};
  }
  
  // Find toss ID by wallet address
  const walletByAddress = await storage.getWalletByAddress(targetAddress);
  const tossId = walletByAddress?.userId;
  
  if (tossId) {
    console.log(`📌 Address ${targetAddress} belongs to toss:${tossId}`);
  }
  
  return {tossId, targetAddress};
}

/**
 * Extract selected option from transaction data
 */
export function extractSelectedOption(txRef: any, txDetails: any, message: any): string | null {
  console.log("Attempting to extract selected option from transaction data...");
  
  // 1. Try to find option in transaction metadata
  if (txDetails.metadata?.selectedOption) {
    console.log(`Found option in txDetails.metadata: ${txDetails.metadata.selectedOption}`);
    return txDetails.metadata.selectedOption;
  }
  
  // 2. Try transaction reference call metadata
  if (txRef.calls?.[0]?.metadata?.selectedOption) {
    console.log(`Found option in txRef.calls[0].metadata: ${txRef.calls[0].metadata.selectedOption}`);
    return txRef.calls[0].metadata.selectedOption;
  }
  
  // 3. Try direct metadata
  if (txRef.metadata?.selectedOption) {
    console.log(`Found option in txRef.metadata: ${txRef.metadata.selectedOption}`);
    return txRef.metadata.selectedOption;
  }
  
  // 4. Try call data from ALL calls
  if (txRef.calls && txRef.calls.length > 0) {
    for (let i = 0; i < txRef.calls.length; i++) {
      // Check different metadata property names that might contain the option
      const callData = txRef.calls[i];
      
      if (callData.metadata?.option) {
        console.log(`Found option in txRef.calls[${i}].metadata.option: ${callData.metadata.option}`);
        return callData.metadata.option;
      }
      
      if (callData.metadata?.choice) {
        console.log(`Found option in txRef.calls[${i}].metadata.choice: ${callData.metadata.choice}`);
        return callData.metadata.choice;
      }
      
      // Check if option is in deeper structures
      if (callData.metadata?.extras?.option) {
        console.log(`Found option in txRef.calls[${i}].metadata.extras.option: ${callData.metadata.extras.option}`);
        return callData.metadata.extras.option;
      }
    }
  }
  
  // 5. Try message context (expanded checks)
  const messageContext = message.content;
  
  if (messageContext?.metadata?.selectedOption) {
    console.log(`Found option in messageContext.metadata.selectedOption: ${messageContext.metadata.selectedOption}`);
    return messageContext.metadata.selectedOption;
  }
  
  if (messageContext?.metadata?.option) {
    console.log(`Found option in messageContext.metadata.option: ${messageContext.metadata.option}`);
    return messageContext.metadata.option;
  }
  
  if (messageContext?.extras?.option) {
    console.log(`Found option in messageContext.extras.option: ${messageContext.extras.option}`);
    return messageContext.extras.option;
  }
  
  // 6. Check input data if it's a token transfer
  const transferData = txDetails.data ? extractERC20TransferData(txDetails.data) : null;
  if (transferData) {
    console.log(`Transfer data found: ${customJSONStringify(transferData, 2)}`);
    
    // Simple check for amount encoding (remainder approach)
    if (transferData.amount) {
      try {
        // Convert BigInt to number (safe for USDC amounts)
        const amount = Number(transferData.amount);
        const baseAmount = Math.floor(amount / 10) * 10; // Round to nearest 10
        const remainder = amount - baseAmount;
        
        if (remainder >= 1 && remainder <= 5) {
          console.log(`Detected option encoding in amount: base=${baseAmount}, remainder=${remainder}`);
          console.log(`Option likely encoded in amount as option #${remainder}`);
        }
      } catch (error) {
        console.error("Error checking amount encoding:", error);
      }
    }
  }
  
  // 7. Look for option in any arbitrary field in the transaction reference
  const searchForOption = (obj: any, path = ''): string | null => {
    if (!obj || typeof obj !== 'object') return null;
    
    for (const key in obj) {
      const currentPath = path ? `${path}.${key}` : key;
      
      // Check if this key might contain option information
      if (['option', 'selectedOption', 'choice'].includes(key.toLowerCase())) {
        if (typeof obj[key] === 'string') {
          console.log(`Found option in arbitrary field ${currentPath}: ${obj[key]}`);
          return obj[key];
        }
      }
      
      // If the value is an object or array, search recursively
      if (obj[key] && typeof obj[key] === 'object') {
        const nestedResult = searchForOption(obj[key], currentPath);
        if (nestedResult) return nestedResult;
      }
    }
    
    return null;
  };
  
  // Try recursive search in both txDetails and txRef
  const optionInDetails = searchForOption(txDetails);
  if (optionInDetails) return optionInDetails;
  
  const optionInRef = searchForOption(txRef);
  if (optionInRef) return optionInRef;
  
  console.log("No option found in any field of the transaction data");
  return null;
}

/**
 * Extract option from transfer amount - common pattern is to add 1 or 2 to the base amount
 * to indicate the option (option 1 or option 2)
 */
export async function extractOptionFromTransferAmount(
  transferData: any, 
  tossId: string, 
  getToss: (id: string) => Promise<GroupTossName | null>
): Promise<string | null> {
  try {
    if (!transferData || !transferData.amount) {
      return null;
    }
    
    // Convert BigInt to number (safe for USDC amounts)
    const amount = Number(transferData.amount);
    
    // Check for amount-based encoding (increment indicates option)
    // Common pattern: 100000 (0.1 USDC) + 1 for option 1, + 2 for option 2
    const baseAmount = Math.floor(amount / 10) * 10; // Round to nearest 10
    const remainder = amount - baseAmount;
    
    // If remainder is 1 or 2, it likely indicates option 1 or 2
    if (remainder >= 1 && remainder <= 5) {
      console.log(`Detected option encoding in amount: base=${baseAmount}, remainder=${remainder}`);
      
      // Get toss details directly using the tossId that was already found
      const toss = await getToss(tossId);
      
      if (!toss) {
        console.log(`Could not find toss data for ID ${tossId}`);
        return null;
      }
      
      if (!toss.tossOptions || !Array.isArray(toss.tossOptions) || toss.tossOptions.length === 0) {
        console.log(`Toss ${tossId} has no options array`);
        return null;
      }
      
      // Option index is 1-based in this encoding (remainder 1 = first option)
      const optionIndex = remainder - 1;
      if (optionIndex >= 0 && optionIndex < toss.tossOptions.length) {
        const option = toss.tossOptions[optionIndex];
        console.log(`Extracted option "${option}" (index ${optionIndex}) from amount remainder ${remainder}`);
        return option;
      }
    }
    
    return null;
  } catch (error) {
    console.error("Error extracting option from transfer amount:", error);
    return null;
  }
} 