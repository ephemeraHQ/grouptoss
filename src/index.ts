import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { initializeAgent } from "@helpers/walletService";
import { initializeClient } from "@helpers/xmtp-handler";
import { AGENT_INSTRUCTIONS, DEFAULT_AMOUNT, DEFAULT_OPTIONS, MAX_USDC_AMOUNT } from "./constants";
import {  ParsedToss, StreamChunk, TossJsonResponse } from "./types";
import { extractCommand, TossManager } from "./toss-manager";     
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import { ContentTypeTransactionReference, TransactionReferenceCodec } from "@xmtp/content-type-transaction-reference";
import { WalletService } from "../helpers/walletService";
import {  storage } from "../helpers/localStorage";  
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { AgentConfig } from "./types";
import { HumanMessage } from "@langchain/core/messages";


/**
 * Extract JSON from agent response text
 * @param response The text response from agent
 * @returns Parsed JSON object or null if not found
 */
export function extractJsonFromResponse(
  response: string
): TossJsonResponse | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as TossJsonResponse;
    }
    return null;
  } catch (error) {
    console.error("Error parsing JSON from agent response:", error);
    return null;
  }
}
/**
 * Process a message with the agent
 */
export async function processAgentMessage(
  agent: ReturnType<typeof createReactAgent>,
  config: AgentConfig,
  message: string
): Promise<string> {
  try {
    const stream = await agent.stream(
      { messages: [new HumanMessage(message)] },
      config
    );

    let response = "";
    for await (const chunk of stream as AsyncIterable<StreamChunk>) {
      if ("agent" in chunk) {
        const content = chunk.agent.messages[0].content;
        if (typeof content === "string") {
          response += content + "\n";
        }
      } else if ("tools" in chunk) {
        const content = chunk.tools.messages[0].content;
        if (typeof content === "string") {
          response += content + "\n";
        }
      }
    }

    return response.trim();
  } catch (error) {
    console.error("Error processing message:", error);
    return "Sorry, I encountered an error while processing your request. Please try again.";
  }
}

/**
 * Parse a natural language toss prompt
 */
export async function parseNaturalLanguageToss(
  agent: ReturnType<typeof createReactAgent>,
  config: AgentConfig,
  prompt: string
): Promise<ParsedToss | string> {
  // Default values
  const defaultResult: ParsedToss = {
    topic: prompt,
    options: DEFAULT_OPTIONS,
    amount: DEFAULT_AMOUNT,
  };

  if (!prompt || prompt.length < 3) {
    return defaultResult;
  }

  // Direct amount extraction via regex (as fallback)
  const amountMatch = prompt.match(/for\s+(\d+(\.\d+)?)\s*$/i);
  const extractedAmount = amountMatch?.[1];

  // Format parsing request
  const parsingRequest = `
      Parse this toss request into structured format: "${prompt}"
      
      First, do a vibe check:
      1. Is this a genuine toss topic like "Will it rain tomorrow" or "Lakers vs Celtics"?
      2. Is it NOT a join attempt or command?
      3. Is it NOT inappropriate content?
      
      If it fails the vibe check, return:
      {
        "valid": false,
        "reason": "brief explanation why"
      }
      
      If it passes the vibe check, return only a valid JSON object with these fields:
      {
        "valid": true,
        "topic": "the tossing topic",
        "options": ["option1", "option2"],
        "amount": "toss amount"
      }
    `;

  // Process with agent
  const response = await processAgentMessage(agent, config, parsingRequest);
  const parsedJson = extractJsonFromResponse(response);

  if (!parsedJson) {
    return "Invalid toss request: No JSON found in response";
  }

  if (parsedJson.valid === false) {
    return `Invalid toss request: ${parsedJson.reason}`;
  }

  // Get the amount from extracted amount, parsed JSON, or default
  let amount = extractedAmount || parsedJson.amount || DEFAULT_AMOUNT;
  
  // Enforce maximum amount
  const numericAmount = parseFloat(amount);
  if (numericAmount > MAX_USDC_AMOUNT) {
    console.log(`Amount ${numericAmount} exceeds maximum ${MAX_USDC_AMOUNT} USDC, capping at maximum`);
    amount = MAX_USDC_AMOUNT.toString();
  }

  // Combine parsed data with defaults
  return {
    topic: parsedJson.topic ?? prompt,
    options:
      Array.isArray(parsedJson.options) && parsedJson.options.length >= 2
        ? [parsedJson.options[0], parsedJson.options[1]]
        : DEFAULT_OPTIONS,
    amount: amount,
  };
} 
/**
 * Main entry point for command processing
 */
export async function handleCommand(
  client: Client,
  conversation: Conversation,
  message: DecodedMessage,
  isDm: boolean,
  tossManager: TossManager,
  agent: ReturnType<typeof createReactAgent>,
  agentConfig: AgentConfig,
): Promise<string> {
  return tossManager.handleCommand(
    client, 
    conversation, 
    message, 
    isDm, 
    agent, 
    agentConfig
  );
}

/**
 * Handle explicit commands (join, close, help, balance, status)
 */
export async function handleExplicitCommand(
  command: string,
  args: string[],
  inboxId: string,
  tossManager: TossManager,
  client: Client,
  conversation: Conversation,
  isDm: boolean
): Promise<string> {
  return tossManager.handleExplicitCommand(
    command, 
    args, 
    inboxId, 
    client, 
    conversation, 
    isDm
  );
}

/**
 * Process a transaction reference that might be related to a toss
 */
export async function handleTransactionReference(
  client: Client,
  conversation: Conversation,
  message: DecodedMessage,
  tossManager: TossManager
): Promise<void> {
  await tossManager.handleTransactionReference(client, conversation, message);
}

/**
 * Checks if a message is a transaction reference
 */
export function isTransactionReference(message: DecodedMessage): boolean {
  return message.contentType?.typeId === ContentTypeTransactionReference.toString();
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

