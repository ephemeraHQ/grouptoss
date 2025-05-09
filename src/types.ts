import { type Conversation, type DecodedMessage } from "@xmtp/node-sdk";

export interface NetworkConfig {
  tokenAddress: string;
  chainId: `0x${string}`;
  decimals: number;
  networkName: string;
  networkId: string;
}

export interface TransactionDetails {
  status: 'success' | 'failed' | 'pending';
  to: string | null;
  from: string | null;
  data: string | null;
  value: bigint | null;
  logs?: any[];
  metadata?: {
    selectedOption?: string;
    tossId?: string;
    [key: string]: any;
  };
}

export interface ERC20TransferData {
  recipient: string;
  amount: bigint;
  metadata?: {
    selectedOption?: string;
    tossId?: string;
    [key: string]: any;
  };
}


// Interface for parsed JSON response
export interface TossJsonResponse {
  topic?: string;
  options?: string[];
  amount?: string;
  valid?: boolean;
  reason?: string;
}

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
  participants: string[];
  participantOptions: Participant[];
  tossOptions?: string[];
  tossTopic?: string;
  walletAddress: string;
  createdAt: number;
  tossResult: string;
  paymentSuccess: boolean;
  transactionLink?: string;
  transactionHash?: string;
  failedWinners?: string[];
  failedRefunds?: string[];
  conversationId?: string;
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

// Interface for transfer response
export interface Transfer {
  model?: {
    sponsored_send?: {
      transaction_link?: string;
      transaction_hash?: string;
    };
  };
  transactionHash?: string;
  transactionLink?: string;
}

