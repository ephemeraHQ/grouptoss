import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { initializeAgent } from "@helpers/cdp";
import { initializeClient } from "@helpers/xmtp-handler";
import { validateEnvironment } from "@helpers/client";
import { AGENT_INSTRUCTIONS } from "./constants";
import { extractCommand } from "./utils";
import { TossManager } from "./toss-manager";
import { handleCommand } from "./commands";
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import { TransactionReferenceCodec } from "@xmtp/content-type-transaction-reference";

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
    
    // Check if this transaction is a toss payment
    // The metadata is nested in the transaction object in content
    const metadata = txRef?.metadata || {};
    console.log("Transaction metadata:", metadata);
    
    // Try to extract metadata from other possible locations
    const calls = txRef?.calls || [];
    if (calls.length > 0) {
      console.log("Transaction calls:", calls);
      // Check if metadata is in the first call
      const callMetadata = calls[0]?.metadata || {};
      console.log("First call metadata:", callMetadata);
      
      // If we found metadata in the call, use it
      if (callMetadata.tossId && callMetadata.selectedOption) {
        console.log("Found toss metadata in call metadata");
        const tossId = callMetadata.tossId;
        const selectedOption = callMetadata.selectedOption;
        
        console.log(`🎮 Detected toss payment from call: Toss #${tossId}, Option: ${selectedOption}`);
        
        // Process the toss join with this metadata
        await processTossJoin(client, conversation, message, tossManager, tossId, selectedOption, txRef);
        return;
      }
    }
    
    // Continue with normal flow
    const tossId = metadata.tossId;
    const selectedOption = metadata.selectedOption;
    
    if (!tossId || !selectedOption) {
      console.log("Transaction reference doesn't contain toss metadata");
      return;
    }
    
    console.log(`🎮 Detected toss payment: Toss #${tossId}, Option: ${selectedOption}`);
    
    // Process the toss join
    await processTossJoin(client, conversation, message, tossManager, tossId, selectedOption, txRef);
    
  } catch (error) {
    console.error("Error handling transaction reference:", error);
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
  txRef: any
): Promise<void> {
  try {
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

/**
 * Main entry point
 */
async function main() {
  // Validate environment
  const { WALLET_KEY, ENCRYPTION_KEY } = validateEnvironment([
    "WALLET_KEY",
    "ENCRYPTION_KEY",
  ]);

  // For debugging: Create a test transaction reference handler
  if (process.argv.includes("--test-transaction")) {
    console.log("🧪 Testing transaction reference processing...");
    const tossManager = new TossManager();
    const clients = await initializeClient(processMessage, [
      {
        walletKey: WALLET_KEY,
        encryptionKey: ENCRYPTION_KEY,
        acceptGroups: true,
        acceptTypes: ["text", "transactionReference"],
        networks: process.env.XMTP_ENV === "local" ? ["local"] : ["dev", "production"],
        welcomeMessage: "Welcome to the Toss game! Use /toss to create a new toss or /join to join an existing toss. Use /help for more information.",
        codecs: [new WalletSendCallsCodec(), new TransactionReferenceCodec()],
      },
    ]);
    
    // Get the first client
    const client = clients[0];
    
    const testReference = {
      networkId: "0x14a34", // This is the same as in the user's example
      reference: "0x03bd02d9e6a285e31a3a9f2fc36fcfc5075999d9c98219e4f20890c40bec54e2",
      // Add custom metadata for testing
      metadata: {
        tossId: "1",
        selectedOption: "heads",
      }
    };
    
    const testReferenceWithCalls = {
      networkId: "0x14a34",
      reference: "0x03bd02d9e6a285e31a3a9f2fc36fcfc5075999d9c98219e4f20890c40bec54e2",
      calls: [
        {
          to: "0xCeC31BE083C9214D1340e224EBc22E327c587b2d",
          metadata: {
            tossId: "1",
            selectedOption: "tails",
            transactionType: "transfer",
            currency: "USDC"
          }
        }
      ]
    };
    
    // Create a mock message for testing
    const mockMessage = {
      content: testReference,
      contentType: { typeId: "transactionReference" },
      senderInboxId: "830d9926b1758299ee1279853c2edc387ebd18ca22ef6bea5d2a74dcbbf0e8ac",
      conversationId: "test",
    };
    
    // Create a mock conversation for testing
    const mockConversation = {
      id: "test",
      send: async (content: any) => {
        console.log("Mock conversation response:", content);
        return "message-id";
      }
    };
    
    console.log("🧪 Testing with direct metadata");
    await handleTransactionReference(client, mockConversation as any, mockMessage as any, tossManager);
    
    // Modify the mock message to test calls-based metadata
    const mockMessageWithCalls = {
      ...mockMessage,
      content: testReferenceWithCalls
    };
    
    console.log("\n🧪 Testing with calls-based metadata");
    await handleTransactionReference(client, mockConversation as any, mockMessageWithCalls as any, tossManager);
    
    return;
  }

  // Initialize client
  await initializeClient(processMessage, [
    {
      walletKey: WALLET_KEY,
      encryptionKey: ENCRYPTION_KEY,
      acceptGroups: true,
      acceptTypes: ["text", "transactionReference"],
      networks: process.env.XMTP_ENV === "local" ? ["local"] : ["dev", "production"],
      welcomeMessage: "Welcome to the Toss game! Use /toss to create a new toss or /join to join an existing toss. Use /help for more information.",
      codecs: [new WalletSendCallsCodec(), new TransactionReferenceCodec()],
    },
  ]);
}

main().catch(console.error);

