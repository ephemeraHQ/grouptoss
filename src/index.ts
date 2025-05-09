import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { initializeAgent } from "@helpers/walletService";
import { initializeClient } from "@helpers/xmtp-handler";
import { AGENT_INSTRUCTIONS } from "./constants";
import { extractCommand } from "./utils";
import { TossManager } from "./toss-manager";
import { handleCommand } from "./commands";
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import { TransactionReferenceCodec } from "@xmtp/content-type-transaction-reference";
import { WalletService } from "../helpers/walletService";
import {  storage } from "../helpers/localStorage";  
import { handleTransactionReference } from "./commands";

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
    
    // Initialize wallet service and toss manager with proper dependencies
    const walletService = new WalletService(storage, 100); // 100 is the max transfer amount
    const tossManager = new TossManager(walletService, storage);
    // Set the client for direct transfers
    tossManager.setClient(client);
    
    const inboxId = message.senderInboxId;
    // Handle transaction references
    if (message.contentType?.typeId === "transactionReference") {
      await conversation.send("⏳ Fetching transaction details...");
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

// Initialize client
await initializeClient(processMessage, [
  {
    walletKey: process.env.WALLET_KEY as string,
    acceptGroups: true,
    acceptTypes: ["text", "transactionReference"],
    networks: process.env.XMTP_ENV === "local" ? ["local"] : ["dev", "production"],
    welcomeMessage: "Welcome to the Group Toss Game! \nAdd this bot to a group and @toss help to get started",
    groupWelcomeMessage: "Hi! I'm cointoss, a bot that allows you to toss with your friends. Send @toss help to get started",
    codecs: [new WalletSendCallsCodec(), new TransactionReferenceCodec()],
  },
]);

