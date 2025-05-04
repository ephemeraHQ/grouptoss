import { HumanMessage } from "@langchain/core/messages";
import { type createReactAgent } from "@langchain/langgraph/prebuilt";
import { AgentConfig, ParsedToss, StreamChunk, TossJsonResponse } from "./types";
import { DEFAULT_AMOUNT, DEFAULT_OPTIONS } from "./constants";

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
 * Extract command from message content
 */
export function extractCommand(content: string): string | null {
  const botMentionRegex = /@toss\s+(.*)/i;
  const botMentionMatch = content.match(botMentionRegex);
  return botMentionMatch ? botMentionMatch[1].trim() : null;
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

  // Combine parsed data with defaults
  return {
    topic: parsedJson.topic ?? prompt,
    options:
      Array.isArray(parsedJson.options) && parsedJson.options.length >= 2
        ? [parsedJson.options[0], parsedJson.options[1]]
        : DEFAULT_OPTIONS,
    amount: extractedAmount || parsedJson.amount || DEFAULT_AMOUNT,
  };
} 