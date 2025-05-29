import { Client, Conversation, DecodedMessage } from "@xmtp/node-sdk";
import { initializeAgent } from "@helpers/walletService";
import { AgentOptions, initializeClient, MessageContext } from "@helpers/xmtp-handler";
import { AGENT_INSTRUCTIONS, DEFAULT_AMOUNT, DEFAULT_OPTIONS, MAX_USDC_AMOUNT } from "./constants";
import {  ParsedToss, StreamChunk, TossJsonResponse } from "./types";
import { TossManager } from "./toss-manager";     
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import { TransactionReferenceCodec } from "@xmtp/content-type-transaction-reference";
import { WalletService } from "../helpers/walletService";
import {  storage } from "../helpers/localStorage";  
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AgentConfig } from "./types";
import { HumanMessage } from "@langchain/core/messages";


// Initialize wallet service and toss manager with proper dependencies
const walletService = new WalletService(storage, 100); // 100 is the max transfer amount
const tossManager = new TossManager(walletService, storage);


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
  let parsedJson: TossJsonResponse | null = null;
  try {
    const json = response.match(/\{[\s\S]*\}/);
    if (json) { 
      parsedJson = JSON.parse(json[0]) as TossJsonResponse;
    }
  } catch (error) {
    console.error("Error parsing JSON from agent response:", error);
      return "Invalid toss request: No JSON found in response";
  }

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
 * Message handler function
 */
async function processMessage(
  client: Client,
  conversation: Conversation,
  message: DecodedMessage,
  messageContext: MessageContext
): Promise<void> {
  try {
    // Set the client for direct transfers
    tossManager.setClient(client);
    
    const inboxId = message.senderInboxId;
    
    // Handle transaction references
    if (messageContext.isTransaction) {
      await conversation.send("⏳ Fetching transaction details...");
      await tossManager.handleTransactionReference(client, conversation, message);
      return;
    }
    
    // Handle text commands
    if (messageContext.hasCommand && messageContext.command) {
      // Initialize agent
      const { agent, config } = await initializeAgent(
        inboxId,
        AGENT_INSTRUCTIONS
      );

      // Process command
      const response = await tossManager.handleCommand(
        client, 
        conversation, 
        message, 
        messageContext, 
        agent, 
        config,
      );
      
      response.length > 0 && await conversation.send(response);
      
      return;
    }
    
    // No command or transaction found - nothing to process
    console.debug(`No command or transaction found in message: ${message.content}`);
    
  } catch (error) {
    console.error("Error:", error);
  }
}


// Initialize client
const options: AgentOptions = { 
  walletKey: process.env.WALLET_KEY as string,
  acceptGroups: true,
  acceptTypes: ["text", "transactionReference"],
  networks: process.env.XMTP_NETWORKS?.split(",") ?? ["dev"],
  welcomeMessage: "Welcome to the Group Toss Game! \nAdd this bot to a group and @toss help to get started",
  groupWelcomeMessage: "Hi! I'm cointoss, a bot that allows you to toss with your friends. Send @toss help to get started",
  codecs: [new WalletSendCallsCodec(), new TransactionReferenceCodec()],
  commandPrefix: "@toss",
  allowedCommands: ["help", "join", "close", "balance", "status", "refresh", "create", "monitor"], // All commands this bot should handle
}
await initializeClient(processMessage, [options]);

