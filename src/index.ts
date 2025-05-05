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
import { verifyTransaction, extractERC20TransferData } from "@helpers/usdc";
import { checkTransactionWithRetries } from "../helpers/transaction-checker";

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
    
    // Check if transaction was successful
    if (txDetails.status !== 'success') {
      console.log(`Transaction failed with status: ${txDetails.status}`);
      await conversation.send(`⚠️ Transaction ${txHash} failed or is still pending.`);
      return;
    }
    
    console.log(`✅ Transaction verified: From ${txDetails.from} to ${txDetails.to}`);
    
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
    
    console.log(`✅ Found toss ID ${tossId} for transaction to ${targetAddress}`);
    
    // Get metadata (if available) to determine the option selected
    // First try metadata from txRef
    let selectedOption = txRef?.metadata?.selectedOption;
    
    // Also check call metadata if available
    const calls = txRef?.calls || [];
    if (!selectedOption && calls.length > 0) {
      selectedOption = calls[0]?.metadata?.selectedOption;
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
        `✅ Payment for Toss #${tossId} received! Please choose one of the following options: ${options.join(", ")}\n` +
        `Reply with "@toss option <your choice>" to confirm your selection.`
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
      await conversation.send(`⚠️ Toss #${tossId} not found. Your payment might have been received but couldn't be associated with a valid toss.`);
      return;
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
      let response = `✅ Successfully joined toss #${tossId}!\nYour Player ID: ${playerId}\nYour Choice: ${selectedOption}\nTotal players: ${updatedToss.participants.length}`;
      
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

