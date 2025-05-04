import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { initializeAgent } from "@helpers/cdp";
import { initializeClient } from "@helpers/xmtp-handler";
import { validateEnvironment } from "@helpers/client";
import { AGENT_INSTRUCTIONS } from "./constants";
import { extractCommand } from "./utils";
import { TossManager } from "./toss-manager";
import { handleCommand } from "./commands";

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
    // Only process transaction references
    if (message.contentType?.typeId !== "transaction-reference") {
      return;
    }
    
    console.log(`📝 Processing transaction reference:`, message.content);
    
    // Get the transaction reference content
    const txRef = message.content as any;
    
    // Check if this transaction is a toss payment
    // The metadata is nested in the transaction object in content
    const metadata = txRef?.metadata || {};
    const tossId = metadata.tossId;
    const selectedOption = metadata.selectedOption;
    
    // Log metadata for debugging
    console.log("Transaction metadata:", metadata);
    
    if (!tossId || !selectedOption) {
      console.log("Transaction reference doesn't contain toss metadata");
      return;
    }
    
    console.log(`🎮 Detected toss payment: Toss #${tossId}, Option: ${selectedOption}`);
    
    // Get the toss details
    const toss = await tossManager.getToss(tossId);
    if (!toss) {
      console.log(`Toss ${tossId} not found`);
      await conversation.send(`⚠️ Toss #${tossId} not found. Your payment might have been received but couldn't be associated with a valid toss.`);
      return;
    }
    
    // Check if payment was successful by verifying transaction recipient
    // The 'to' field should match the toss wallet address
    const transactionTo = txRef?.to?.toLowerCase();
    const tossWalletAddress = toss.walletAddress.toLowerCase();
    
    if (transactionTo && transactionTo !== tossWalletAddress) {
      console.log(`Payment sent to wrong address: ${transactionTo}, expected: ${tossWalletAddress}`);
      await conversation.send(`⚠️ Payment was sent to ${transactionTo}, but toss wallet is ${tossWalletAddress}.`);
      return;
    }
    
    // Process the join
    try {
      // First join the game
      const joinedToss = await tossManager.joinGame(tossId, message.senderInboxId);
      
      // Then add player with selected option
      const updatedToss = await tossManager.addPlayerToGame(
        tossId, 
        message.senderInboxId, 
        selectedOption, 
        true // Mark as paid since we received the transaction reference
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
    console.error("Error handling transaction reference:", error);
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
    // Initialize toss manager
    const tossManager = new TossManager();
    const inboxId = message.senderInboxId;
    
    // Handle transaction references
    if (message.contentType?.typeId === "transaction-reference") {
      await handleTransactionReference(client, conversation, message, tossManager);
      return;
    }
    
    // Handle wallet send calls
    if (message.contentType?.typeId === "wallet-send-calls") {
      // Just acknowledge receipt
      console.log("Received wallet send calls message", message.content);
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

/**
 * Main entry point
 */
async function main() {
  // Validate environment
  const { WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV } = validateEnvironment([
    "WALLET_KEY",
    "ENCRYPTION_KEY",
    "XMTP_ENV"
  ]);

  // Initialize client
  await initializeClient(processMessage, [
    {
      walletKey: WALLET_KEY,
      encryptionKey: ENCRYPTION_KEY,
      acceptGroups: true,
      acceptTypes: ["text", "transaction-reference", "wallet-send-calls"],
      networks: XMTP_ENV === "local" ? ["local"] : ["dev", "production"],
    },
  ]);
}

main().catch(console.error);

