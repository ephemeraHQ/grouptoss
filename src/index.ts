import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { initializeAgent } from "@helpers/cdp";
import { initializeClient } from "@helpers/xmtp-handler";
import { validateEnvironment } from "@helpers/client";
import { AGENT_INSTRUCTIONS } from "./constants";
import { extractCommand } from "./utils";
import { TossManager } from "./toss-manager";
import { handleCommand } from "./commands";

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
    const command = extractCommand(message.content as string);
    if (!command) {
      return;
    }
    const tossManager = new TossManager();
    const commandContent = command.replace(/^@toss\s+/i, "").trim();
    const inboxId = message.senderInboxId;

    // Initialize agent
    const { agent, config } = await initializeAgent(
      inboxId,
      AGENT_INSTRUCTIONS
    );

    // Process command
    const response = await handleCommand(
      commandContent,
      inboxId,
      tossManager,
      agent,
      config
    );

    await conversation.send(response);
    console.log(`✅ Response sent: ${response.substring(0, 50)}...`);
  } catch (error) {
    console.error("Error:", error);
  }
}

const { WALLET_KEY, ENCRYPTION_KEY } = validateEnvironment([
  "WALLET_KEY",
  "ENCRYPTION_KEY",
]);

await initializeClient(processMessage, [
  {
    walletKey: WALLET_KEY,
    encryptionKey: ENCRYPTION_KEY,
    acceptGroups: true,
  },
]);

