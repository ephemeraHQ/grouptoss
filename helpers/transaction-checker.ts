import { verifyTransaction } from "./usdc";

/**
 * Sleep for a specified number of milliseconds
 * @param ms Number of milliseconds to sleep
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Check a transaction with retries and delays
 * @param txHash Transaction hash to verify
 * @param maxRetries Maximum number of retry attempts
 * @param initialDelay Initial delay in milliseconds
 * @param backoffFactor Factor to increase delay on each retry
 * @returns The transaction details if found, or null if not found after retries
 */
export async function checkTransactionWithRetries(
  txHash: string,
  maxRetries = 5,
  initialDelay = 5000, // 5 seconds initial delay
  backoffFactor = 1.5, // Increase delay by 50% each retry
): Promise<{
  status: 'success' | 'failed' | 'pending';
  to: string | null;
  from: string | null;
  data: string | null;
  value: bigint | null;
  logs?: any[];
  metadata?: any;
} | null> {
  let currentDelay = initialDelay;
  
  // Wait before the first check to give the transaction time to be processed
  console.log(`Waiting ${Math.round(currentDelay / 1000)}s before checking transaction ${txHash}...`);
  await sleep(currentDelay);
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Checking transaction ${txHash}, attempt ${attempt + 1}/${maxRetries + 1}`);
      
      // Try to verify the transaction
      const txDetails = await verifyTransaction(txHash);
      
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
      await sleep(currentDelay);
      
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
      await sleep(currentDelay);
      
      // Increase delay for next attempt
      currentDelay = currentDelay * backoffFactor;
    }
  }
  
  // Should not reach here due to the return in the loop
  return null;
} 