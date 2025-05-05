import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { initializeAgent } from "@helpers/cdp";
import { initializeClient } from "@helpers/xmtp-handler";
import { validateEnvironment } from "@helpers/client";
import { AGENT_INSTRUCTIONS, HELP_MESSAGE } from "./constants";
import { extractCommand } from "./utils";
import { TossManager } from "./toss-manager";
import { handleCommand } from "./commands";
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import { TransactionReferenceCodec } from "@xmtp/content-type-transaction-reference";
import {  checkTransactionWithRetries, extractERC20TransferData } from   "./transactions";


/**
 * Custom JSON stringifier that can handle BigInt values
 */
function customJSONStringify(obj: any, space?: number | string): string {
  return JSON.stringify(obj, (key, value) => 
    typeof value === 'bigint' 
      ? value.toString() + 'n' // Append 'n' to distinguish from regular numbers
      : value
  , space);
}

/**
 * Process a transaction reference that might be related to a toss
 */
async function handleTransactionReference(
  client: Client,
  conversation: Conversation,
  message: DecodedMessage,
  tossManager: TossManager
): Promise<void> {
  try {
    console.log(`📝 Processing transaction reference:`, message.content);
    console.log(`Transaction reference full structure: ${JSON.stringify(message.content, null, 2)}`);
    
    // Get the transaction reference content
    const txRef = message.content as any;
    
    // Extract transaction hash from the reference
    const txHash = txRef?.reference;
    if (!txHash) {
      console.log("No transaction hash found in reference");
      return;
    }
    
    console.log(`🔍 Verifying transaction: ${txHash}`);
    
    // Verify the transaction on the blockchain with retries
    const txDetails = await checkTransactionWithRetries(txHash);
    if (!txDetails) {
      console.log("Transaction not found or verification failed after retries");
      await conversation.send("⚠️ Could not verify the transaction. It may be pending or not yet indexed.");
      return;
    }
    
    // Log full transaction details for debugging
    console.log(`Complete transaction details: ${customJSONStringify(txDetails, 2)}`);
    
    // Check if transaction was successful
    if (txDetails.status !== 'success') {
      console.log(`Transaction failed with status: ${txDetails.status}`);
      await conversation.send(`⚠️ Transaction ${txHash} failed or is still pending.`);
      return;
    }
    
    console.log(`✅ Transaction verified: From ${txDetails.from} to ${txDetails.to}`);
    
    // Try to get metadata from various sources
    let selectedOption = null;
    
    // 1. Try to get from transaction metadata
    if ('metadata' in txDetails && txDetails.metadata) {
      const meta = txDetails.metadata as { selectedOption?: string };
      if (meta.selectedOption) {
        console.log(`Found option in transaction metadata: ${meta.selectedOption}`);
        selectedOption = meta.selectedOption;
      }
    }
    
    // 2. Check in the transaction reference itself
    if (!selectedOption) {
      // Try the call data from the transaction reference
      if (txRef.calls && txRef.calls.length > 0) {
        const callMetadata = txRef.calls[0]?.metadata;
        if (callMetadata?.selectedOption) {
          selectedOption = callMetadata.selectedOption;
          console.log(`Found option in transaction reference call metadata: ${selectedOption}`);
        }
      }
      
      // Try the direct metadata
      if (!selectedOption && txRef.metadata?.selectedOption) {
        selectedOption = txRef.metadata.selectedOption;
        console.log(`Found option in transaction reference metadata: ${selectedOption}`);
      }
    }
    
    // 3. Check the message for contextual data 
    if (!selectedOption) {
      // Look for option info in the message context
      const messageContext = message.content as any;
      if (messageContext?.metadata?.selectedOption) {
        selectedOption = messageContext.metadata.selectedOption;
        console.log(`Found option in message context: ${selectedOption}`);
      }
      
      // Check in message extras or any other properties that might contain the data
      if (!selectedOption && messageContext?.extras?.option) {
        selectedOption = messageContext.extras.option;
        console.log(`Found option in message extras: ${selectedOption}`);
      }
    }
    
    // Check if this is an ERC20 token transfer
    const transferData = txDetails.data ? extractERC20TransferData(txDetails.data) : null;
    
    // Get the transaction target (either direct recipient or token transfer recipient)
    const targetAddress = transferData?.recipient || txDetails.to;
    if (!targetAddress) {
      console.log("Could not determine transaction recipient");
      return;
    }
    
    // Try to match the recipient address with a toss wallet
    const tossId = await tossManager.walletServiceInstance.getTossIdFromAddress(targetAddress);
    if (!tossId) {
      console.log(`No toss found for address: ${targetAddress}`);
      return;
    }
    
    // Log the target address for debugging
    console.log(`📌 Address ${targetAddress} belongs to toss:${tossId}`);
    
    console.log(`✅ Found toss ID ${tossId} for transaction to ${targetAddress}`);
    
    // Check if this toss is associated with this conversation
    const activeToss = await tossManager.getActiveTossForConversation(conversation.id);
    if (activeToss && activeToss.id !== tossId) {
      console.log(`Transaction is for toss ${tossId} but the active toss for this conversation is ${activeToss.id}`);
      // Only proceed if this transaction is for the active toss in this conversation
      await conversation.send(`⚠️ This payment is for a different toss than the one active in this conversation.`);
      return;
    }
    
    // 4. Try to infer option from prior choices in the toss
    if (!selectedOption) {
      // Get the toss for checking options or prior choices
      const toss = await tossManager.getToss(tossId);
      if (toss) {
        // Try to extract the option from transaction data or existing choices
        
        // 4.1 Check if sender has previously joined this toss with an option
        if (toss.participantOptions) {
          const existingChoice = toss.participantOptions.find(
            (pc) => pc.inboxId.toLowerCase() === message.senderInboxId.toLowerCase()
          );
          
          if (existingChoice?.option) {
            selectedOption = existingChoice.option;
            console.log(`Found option from existing choice: ${selectedOption}`);
          }
        }
        
        // 4.2 If there are only two options, try to check the transaction amount to determine which option
        if (!selectedOption && toss.tossOptions && toss.tossOptions.length > 0 && transferData) {
          // Calculate the base expected amount (before option encoding)
          const baseAmount = Math.floor(parseFloat(toss.tossAmount) * Math.pow(10, 6));
          
          // Get the actual amount from the transaction
          const actualAmount = Number(transferData.amount);
          
          // Calculate the difference to determine which option was chosen
          const amountDiff = actualAmount - baseAmount;
          
          if (amountDiff > 0 && amountDiff <= toss.tossOptions.length) {
            // Option is encoded as a 1-based index in the amount
            // Option 1: baseAmount + 1, Option 2: baseAmount + 2, etc.
            const optionIndex = amountDiff - 1;
            if (optionIndex >= 0 && optionIndex < toss.tossOptions.length) {
              selectedOption = toss.tossOptions[optionIndex];
              console.log(`Extracted option from transaction amount: option #${optionIndex + 1} = "${selectedOption}"`);
              console.log(`Transaction amount: ${actualAmount}, Base amount: ${baseAmount}, Diff: ${amountDiff}`);
            }
          }
        }
      }
    }
    
    // Log the selected option if found
    if (selectedOption) {
      console.log(`🎮 Selected option for toss ${tossId}: ${selectedOption}`);
    }
    
    // If we still don't have an option, request it from the user
    if (!selectedOption) {
      // Get the toss details to show available options
      const toss = await tossManager.getToss(tossId);
      if (!toss) {
        console.log(`Toss ${tossId} not found`);
        return;
      }
      
      // Determine available options
      const options = toss.tossOptions && toss.tossOptions.length > 0 
        ? toss.tossOptions 
        : ["heads", "tails"]; // Default options
      
      // Ask user to select an option
      await conversation.send(
        `✅ Payment received! Please choose one of the following options: ${options.join(", ")}\n` +
        `Reply with "@toss join <your choice>" to confirm your selection.`
      );
      return;
    }
    
    console.log(`🎮 Detected toss payment for Toss #${tossId}, Option: ${selectedOption}`);
    
    // Process the toss join
    await processTossJoin(client, conversation, message, tossManager, tossId, selectedOption, txDetails);
    
  } catch (error) {
    console.error("Error handling transaction reference:", error);
    try {
      await conversation.send("⚠️ An error occurred while processing your transaction.");
    } catch (sendError) {
      console.error("Failed to send error message:", sendError);
    }
  }
}

/**
 * Helper function to process a toss join after receiving transaction reference
 */
async function processTossJoin(
  client: Client,
  conversation: Conversation,
  message: DecodedMessage,
  tossManager: TossManager,
  tossId: string,
  selectedOption: string,
  txDetails: any
): Promise<void> {
  try {
    // Get the toss details
    const toss = await tossManager.getToss(tossId);
    if (!toss) {
      console.log(`Toss ${tossId} not found`);
      await conversation.send(`⚠️ Toss not found. Your payment might have been received but couldn't be associated with a valid toss.`);
      return;
    }
    
    // Associate this toss with the conversation if not already associated
    const activeToss = await tossManager.getActiveTossForConversation(conversation.id);
    if (!activeToss) {
      await tossManager.setActiveTossForConversation(conversation.id, tossId);
      console.log(`Associated toss ${tossId} with conversation ${conversation.id}`);
    }
    
    // Process the join
    try {
      // Add player with selected option
      const updatedToss = await tossManager.addPlayerToGame(
        tossId, 
        message.senderInboxId, 
        selectedOption, 
        true // Mark as paid since we verified the transaction
      );
      
      // Calculate player ID
      const playerId = `P${updatedToss.participants.findIndex(p => p === message.senderInboxId) + 1}`;
      
      // Send confirmation
      let response = `✅ Successfully joined!\nYour Player ID: ${playerId}\nYour Choice: ${selectedOption}\nTotal players: ${updatedToss.participants.length}`;
      
      if (updatedToss.tossTopic) {
        response += `\nToss Topic: "${updatedToss.tossTopic}"`;
      }
      
      await conversation.send(response);
      
      console.log(`👍 User ${message.senderInboxId} successfully joined toss #${tossId} with option "${selectedOption}"`);
    } catch (error) {
      console.error("Error processing toss join:", error);
      await conversation.send(`⚠️ Error joining toss: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    console.error("Error processing toss join:", error);
    await conversation.send(`⚠️ Error joining toss: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Message handler function
 */
async function processMessage(
  client: Client,
  conversation: Conversation,
  message: DecodedMessage,
  isDm: boolean,
): Promise<void> {
  try {
    if(isDm) {
      console.log("Not a group, skipping");
      return;
    }
    // Initialize toss manager
    const tossManager = new TossManager();
    const inboxId = message.senderInboxId;
    // Handle transaction references
    if (message.contentType?.typeId === "transactionReference") {
      await handleTransactionReference(client, conversation, message, tossManager);
      return;
    }
    
    
    // Handle text commands
    const command = extractCommand(message.content as string);
    if (!command) {
      return;
    }

    // Initialize agent
    const { agent, config } = await initializeAgent(
      inboxId,
      AGENT_INSTRUCTIONS
    );

    // Process command
    const response = await handleCommand(
      client,
      conversation,
      message,
      isDm,
      tossManager,
      agent,
      config
    );
    if (response) {
      await conversation.send(response);
      console.log(`✅ Response sent: ${response.substring(0, 50)}...`);
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

const {WALLET_KEY, ENCRYPTION_KEY} = validateEnvironment(["WALLET_KEY", "ENCRYPTION_KEY"]);
// Initialize client
await initializeClient(processMessage, [
  {
    walletKey: WALLET_KEY,
    encryptionKey: ENCRYPTION_KEY,
    acceptGroups: true,
    acceptTypes: ["text", "transactionReference"],
    networks: process.env.XMTP_ENV === "local" ? ["local"] : ["dev", "production"],
    welcomeMessage: "Welcome to the Group Toss Game! \nAdd this bot to a group and @toss help to get started",
    codecs: [new WalletSendCallsCodec(), new TransactionReferenceCodec()],
  },
]);

