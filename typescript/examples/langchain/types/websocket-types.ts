import { CompiledStateGraph, StateGraph } from '@langchain/langgraph';
import { BaseCheckpointSaver, MemorySaver } from '@langchain/langgraph';
import WebSocket from 'ws';

// WebSocket message types
export interface BaseMessage {
  id?: string;
  timestamp: number;
}

export interface UserMessage extends BaseMessage {
  type: 'USER_MESSAGE';
  message: string;
  userAccountId?: string;
}

export interface AgentResponse extends BaseMessage {
  type: 'AGENT_RESPONSE';
  message: string;
  hasTransaction?: boolean;
}

export interface TransactionToSign extends BaseMessage {
  type: 'TRANSACTION_TO_SIGN';
  transactionBytes: number[];
  originalQuery: string;
}

export interface TransactionResult extends BaseMessage {
  type: 'TRANSACTION_RESULT';
  success: boolean;
  transactionId?: string;
  status?: string;
  error?: string;
}

export interface SystemMessage extends BaseMessage {
  type: 'SYSTEM_MESSAGE';
  message: string;
  level: 'info' | 'error' | 'warning';
}

export interface ConnectionAuth extends BaseMessage {
  type: 'CONNECTION_AUTH';
  userAccountId: string;
}

export interface TokenInfo {
  token: string;
  tokenId: string;
  amount: string;
  formatted: string;
}

export interface SwapQuote extends BaseMessage {
  type: 'SWAP_QUOTE';
  quote: {
    operation: string;
    network: string;
    input: TokenInfo;
    output: TokenInfo;
    path: string[];
    fees: number[];
    exchangeRate: string;
    gasEstimate?: string;
  };
  originalMessage: string;
}

export type WSMessage = UserMessage | AgentResponse | TransactionToSign | TransactionResult | SystemMessage | ConnectionAuth | SwapQuote;

// Extended interface to support multi-step flows
export interface PendingStep {
  tool: string;
  operation: string;
  step: string;
  originalParams: any;
  nextStepInstructions?: string;
}

export interface UserConnection {
  ws: WebSocket;
  userAccountId: string;
  agent: CompiledStateGraph<any, any, any>;
  checkpointer: BaseCheckpointSaver;
  threadId: string;
  pendingStep?: PendingStep; // Track multi-step flows
  // Track the last prepared operation context to emit a final summary upon confirmation
  lastPreparedOperation?: {
    tool?: string;
    protocol?: string;
    operation?: string;
    step?: string;
    originalParams?: any;
    amountLabel?: string; // e.g. "5000 SAUCE"
    tokenIds?: string[];
  };
}

// Constants
export const TOKEN_MAPPINGS = {
  mainnet: { SAUCE: '0.0.731861', WHBAR: '0.0.1456986', HBAR: 'HBAR' },
  testnet: { SAUCE: '0.0.1183558', WHBAR: '0.0.15058', HBAR: 'HBAR' }
} as const;

export const TOKEN_NAMES: Record<string, string> = {
  'HBAR': 'HBAR', '0.0.731861': 'SAUCE', '0.0.1183558': 'SAUCE',
  '0.0.1456986': 'WHBAR', '0.0.15058': 'WHBAR'
};