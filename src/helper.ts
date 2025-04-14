import {
  Client,
  type Conversation,
  type DecodedMessage,
  type XmtpEnv,
} from "@xmtp/node-sdk";
import { getRandomValues } from "node:crypto";
import { IdentifierKind, type Signer } from "@xmtp/node-sdk";
import { fromString, toString } from "uint8arrays";
import { createWalletClient, toBytes } from "viem";
import type { WalletSendCallsParams } from "@xmtp/content-type-wallet-send-calls";
import { createPublicClient, formatUnits, http } from "viem";
import { baseSepolia } from "viem/chains";

import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { XMTP_STORAGE_DIR } from "./storage";

// Interface to track participant options
export interface Participant {
  inboxId: string;
  option: string;
}

export interface GroupTossName {
  id: string;
  creator: string;
  tossAmount: string;
  status: TossStatus;
  participants: string[]; // Maintaining for backward compatibility
  participantOptions: Participant[]; // New field to track participant options
  winner?: string;
  walletAddress: string;
  createdAt: number;
  tossResult?: string;
  paymentSuccess?: boolean;
  transactionLink?: string;
  tossTopic?: string;
  tossOptions?: string[];
}

export enum TossStatus {
  CREATED = "CREATED",
  WAITING_FOR_PLAYER = "WAITING_FOR_PLAYER",
  READY = "READY",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
}

export interface TransferResponse {
  model?: {
    sponsored_send?: {
      transaction_link?: string;
    };
  };
}

export interface AgentConfig {
  configurable: {
    thread_id: string;
  };
}

// Interface for parsed toss information
export interface ParsedToss {
  topic: string;
  options: string[];
  amount: string;
}

// Define stream chunk types
export interface AgentChunk {
  agent: {
    messages: Array<{
      content: string;
    }>;
  };
}

export interface ToolsChunk {
  tools: {
    messages: Array<{
      content: string;
    }>;
  };
}

export type StreamChunk = AgentChunk | ToolsChunk;

export type MessageHandler = (
  message: DecodedMessage,
  conversation: Conversation,
  command: string
) => Promise<void>;

const { WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV } = validateEnvironment([
  "WALLET_KEY",
  "ENCRYPTION_KEY",
  "XMTP_ENV",
]);

/**
 * Initialize the XMTP client
 */
export async function initializeXmtpClient() {
  // Create the signer using viem
  const signer = createSigner(WALLET_KEY);
  const encryptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);

  const identifier = await signer.getIdentifier();
  const address = identifier.identifier;

  const client = await Client.create(signer, encryptionKey, {
    env: XMTP_ENV as XmtpEnv,
    dbPath: XMTP_STORAGE_DIR + `/${XMTP_ENV}-${address}`,
  });

  logAgentDetails(address, client.inboxId, XMTP_ENV);

  /* Sync the conversations from the network to update the local db */
  console.log("✓ Syncing conversations...");
  await client.conversations.sync();

  return client;
}

// Interface for parsed JSON response
export interface TossJsonResponse {
  topic?: string;
  options?: string[];
  amount?: string;
  valid?: boolean;
  reason?: string;
}
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

interface User {
  key: `0x${string}`;
  account: ReturnType<typeof privateKeyToAccount>;
  wallet: ReturnType<typeof createWalletClient>;
}

export const createUser = (key: string): User => {
  const account = privateKeyToAccount(key as `0x${string}`);
  return {
    key: key as `0x${string}`,
    account,
    wallet: createWalletClient({
      account,
      chain: sepolia,
      transport: http(),
    }),
  };
};

export const createSigner = (key: string): Signer => {
  const sanitizedKey = key.startsWith("0x") ? key : `0x${key}`;
  const user = createUser(sanitizedKey);
  return {
    type: "EOA",
    getIdentifier: () => ({
      identifierKind: IdentifierKind.Ethereum,
      identifier: user.account.address.toLowerCase(),
    }),
    signMessage: async (message: string) => {
      const signature = await user.wallet.signMessage({
        message,
        account: user.account,
      });
      return toBytes(signature);
    },
  };
};

/**
 * Generate a random encryption key
 * @returns The encryption key
 */
export const generateEncryptionKeyHex = () => {
  /* Generate a random encryption key */
  const uint8Array = getRandomValues(new Uint8Array(32));
  /* Convert the encryption key to a hex string */
  return toString(uint8Array, "hex");
};

/**
 * Get the encryption key from a hex string
 * @param hex - The hex string
 * @returns The encryption key
 */
export const getEncryptionKeyFromHex = (hex: string) => {
  /* Convert the hex string to an encryption key */
  return fromString(hex, "hex");
};

// Configuration constants
export const USDC_CONFIG = {
  tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  chainId: "0x14A34", // Base Sepolia network ID (84532 in hex)
  decimals: 6,
  platform: "base",
} as const;

// Create a public client for reading from the blockchain
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

// ERC20 minimal ABI for balance checking
const erc20Abi = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * Get USDC balance for a given address
 */
export async function getUSDCBalance(address: string): Promise<string> {
  const balance = await publicClient.readContract({
    address: USDC_CONFIG.tokenAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  });

  return formatUnits(balance, USDC_CONFIG.decimals);
}

/**
 * Create wallet send calls parameters for USDC transfer
 */
export function createUSDCTransferCalls(
  fromAddress: string,
  recipientAddress: string,
  amount: number
): WalletSendCallsParams {
  const methodSignature = "0xa9059cbb"; // Function signature for ERC20 'transfer(address,uint256)'

  // Format the transaction data following ERC20 transfer standard
  const transactionData = `${methodSignature}${recipientAddress
    .slice(2)
    .padStart(64, "0")}${BigInt(amount).toString(16).padStart(64, "0")}`;

  return {
    version: "1.0",
    from: fromAddress as `0x${string}`,
    chainId: USDC_CONFIG.chainId as `0x${string}`,
    calls: [
      {
        to: USDC_CONFIG.tokenAddress as `0x${string}`,
        data: transactionData as `0x${string}`,
        metadata: {
          description: `Transfer ${
            amount / Math.pow(10, USDC_CONFIG.decimals)
          } USDC on Base Sepolia`,
          transactionType: "transfer",
          currency: "USDC",
          amount: amount,
          decimals: USDC_CONFIG.decimals,
          platform: USDC_CONFIG.platform,
        },
      },
      /* add more calls here */
    ],
  };
}
import "dotenv/config";

export const logAgentDetails = (
  address: string,
  inboxId: string,
  env: string
) => {
  const createLine = (length: number, char = "═"): string =>
    char.repeat(length - 2);
  const centerText = (text: string, width: number): string => {
    const padding = Math.max(0, width - text.length);
    const leftPadding = Math.floor(padding / 2);
    return " ".repeat(leftPadding) + text + " ".repeat(padding - leftPadding);
  };

  console.log(`\x1b[38;2;252;76;52m
    ██╗  ██╗███╗   ███╗████████╗██████╗ 
    ╚██╗██╔╝████╗ ████║╚══██╔══╝██╔══██╗
     ╚███╔╝ ██╔████╔██║   ██║   ██████╔╝
     ██╔██╗ ██║╚██╔╝██║   ██║   ██╔═══╝ 
    ██╔╝ ██╗██║ ╚═╝ ██║   ██║   ██║     
    ╚═╝  ╚═╝╚═╝     ╚═╝   ╚═╝   ╚═╝     
  \x1b[0m`);

  const url = `http://xmtp.chat/dm/${address}?env=${env}`;
  const maxLength = Math.max(url.length + 12, address.length + 15, 30);

  // Get the current folder name from the process working directory
  const currentFolder = process.cwd().split("/").pop() || "";
  const dbPath = `../${currentFolder}/xmtp-${env}-${address}.db3`;
  const maxLengthWithDbPath = Math.max(maxLength, dbPath.length + 15);

  const box = [
    `╔${createLine(maxLengthWithDbPath)}╗`,
    `║   ${centerText("Agent Details", maxLengthWithDbPath - 6)} ║`,
    `╟${createLine(maxLengthWithDbPath, "─")}╢`,
    `║ 📍 Address: ${address}${" ".repeat(
      maxLengthWithDbPath - address.length - 15
    )}║`,
    `║ 📍 inboxId: ${inboxId}${" ".repeat(
      maxLengthWithDbPath - inboxId.length - 15
    )}║`,
    `║ 📂 DB Path: ${dbPath}${" ".repeat(
      maxLengthWithDbPath - dbPath.length - 15
    )}║`,
    `║ 🛜  Network: ${env}${" ".repeat(maxLengthWithDbPath - env.length - 15)}║`,
    `║ 🔗 URL: ${url}${" ".repeat(maxLengthWithDbPath - url.length - 11)}║`,
    `╚${createLine(maxLengthWithDbPath)}╝`,
  ].join("\n");

  console.log(box);
};

export function validateEnvironment(vars: string[]): Record<string, string> {
  const requiredVars = vars;
  const missing = requiredVars.filter((v) => !process.env[v]);

  if (missing.length) {
    console.error("Missing env vars:", missing.join(", "));
    process.exit(1);
  }

  return requiredVars.reduce<Record<string, string>>((acc, key) => {
    acc[key] = process.env[key] as string;
    return acc;
  }, {});
}
