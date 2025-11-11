import * as dotenv from 'dotenv';
dotenv.config();

import { ChatOpenAI } from '@langchain/openai';
import { Client } from '@hashgraph/sdk';
import WebSocket, { WebSocketServer } from 'ws';
import * as http from 'http';

// Import new modular components
import { WSMessage } from './types/websocket-types';
import { AgentResponseUtils } from './utils/agent-response-utils';
import { MessageHandlers } from './handlers/message-handlers';
import { ConnectionManager } from './handlers/connection-manager';

// Constants
const NETWORK = (process.env.HEDERA_NETWORK as 'mainnet' | 'testnet') || 'testnet';
const FORCE_CLEAR_MEMORY = process.env.FORCE_CLEAR_MEMORY === 'true';

// Enhanced LLM Configuration Constants
const MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '12000');
const MODEL_NAME = process.env.LLM_MODEL || 'gpt-5-mini';
// GPT-5 models only support temperature=1 (default), so we use 1 for GPT-5 models
const TEMPERATURE = MODEL_NAME.startsWith('gpt-5') ? 1 : parseFloat(process.env.LLM_TEMPERATURE || '0.7');

// Memory Configuration Constants
const MEMORY_MAX_TOKEN_LIMIT = parseInt(process.env.MEMORY_MAX_TOKEN_LIMIT || '8000');
const MEMORY_RETURN_MAX_TOKENS = parseInt(process.env.MEMORY_RETURN_MAX_TOKENS || '4000');

class HederaWebSocketAgent {
  private wss: WebSocketServer;
  private httpServer: http.Server;
  private llm!: ChatOpenAI;
  private agentClient!: Client;
  private connectionManager!: ConnectionManager;
  private messageHandlers!: MessageHandlers;

  constructor(port: number = 8080) {
    // Create HTTP server for health checks
    this.httpServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'healthy', 
          service: 'hedera-websocket-agent',
          timestamp: new Date().toISOString(),
          connections: this.connectionManager?.getConnectionCount() || 0
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('WebSocket Agent - Use WebSocket connection on port ' + port);
      }
    });

    // Create WebSocket server on the same HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.httpServer.listen(port);
    this.setupWebSocketServer();
  }

  async initialize(): Promise<void> {
    console.log('🚀 Initializing Hedera WebSocket Agent...');
    console.log(`🧠 MVP Memory Debug Mode: ${FORCE_CLEAR_MEMORY ? 'ENABLED' : 'DISABLED'}`);
    console.log(`📊 Memory will be cleared ${FORCE_CLEAR_MEMORY ? 'on every message' : 'only on new connections'}`);
    
    // Log enhanced configuration
    console.log(`🤖 LLM Configuration:`);
    console.log(`   - Model: ${MODEL_NAME}`);
    console.log(`   - Max Tokens: ${MAX_TOKENS}`);
    console.log(`   - Temperature: ${TEMPERATURE}${MODEL_NAME.startsWith('gpt-5') ? ' (auto-adjusted for GPT-5)' : ''}`);
    if (MODEL_NAME.startsWith('gpt-5')) {
      console.log(`   ⚠️  GPT-5 detected: Using simplified parameters (no top_p, frequency_penalty, presence_penalty)`);
    }
    console.log(`🧠 Memory Configuration:`);
    console.log(`   - Max Token Limit: ${MEMORY_MAX_TOKEN_LIMIT}`);
    console.log(`   - Return Max Tokens: ${MEMORY_RETURN_MAX_TOKENS}`);

    // Enhanced OpenAI Configuration with increased context
    // GPT-5 models have stricter parameter requirements
    const isGPT5 = MODEL_NAME.startsWith('gpt-5');
    
    this.llm = new ChatOpenAI({
      model: MODEL_NAME,
      temperature: TEMPERATURE,
      maxTokens: MAX_TOKENS,
      streaming: false, // Disable streaming for better token management
      // GPT-5 models don't support these additional parameters
      ...(isGPT5 ? {} : {
        modelKwargs: {
          // Additional model parameters for better context handling (not supported in GPT-5)
          top_p: 0.9,
          frequency_penalty: 0.1,
          presence_penalty: 0.1,
        },
      }),
    });

    // Hedera client for testnet (without operator, will be configured by user)
    this.agentClient = Client.forTestnet();

    // Initialize modular components with enhanced memory configuration
    this.connectionManager = new ConnectionManager(NETWORK, {
      maxTokenLimit: MEMORY_MAX_TOKEN_LIMIT,
      returnMaxTokens: MEMORY_RETURN_MAX_TOKENS,
    });
    this.messageHandlers = new MessageHandlers(
      this.connectionManager,
      this.llm,
      this.agentClient,
      FORCE_CLEAR_MEMORY
    );

    // Set network for agent response utils
    AgentResponseUtils.setNetwork(NETWORK);

    console.log('✅ Hedera WebSocket Agent initialized successfully');
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      console.log(`🔗 New WebSocket connection established (Total: ${this.connectionManager?.getConnectionCount() + 1 || 1})`);

      // Send welcome message
      this.sendSystemMessage(ws, `Connected to Hedera Agent. Please authenticate with your account ID first using CONNECTION_AUTH message.${FORCE_CLEAR_MEMORY ? ' [Debug: Memory cleared on each message]' : ''}`, 'info');

      // Handle incoming messages
        ws.on('message', async (data: Buffer) => {
        try {
          const message: WSMessage = JSON.parse(data.toString());
          await this.handleMessage(ws, message);
        } catch (error: any) {
          console.error('❌ Error processing message:', error);
          this.sendSystemMessage(ws, 'Error processing message. Invalid format.', 'error');
        }
      });

      // Handle disconnection
      ws.on('close', async () => {
        console.log('🔌 WebSocket connection closed');
        await this.connectionManager.cleanupConnection(ws);
      });

      // Handle errors
      ws.on('error', async (error: any) => {
        console.error('❌ WebSocket error:', error);
        await this.connectionManager.cleanupConnection(ws);
      });
    });

    console.log(`🌐 WebSocket Server started on port ${this.wss.options.port}`);
  }

  private async handleMessage(ws: WebSocket, message: WSMessage): Promise<void> {
    switch (message.type) {
      case 'CONNECTION_AUTH':
        await this.messageHandlers.handleConnectionAuth(ws, message);
        break;
      
      case 'USER_MESSAGE':
        await this.messageHandlers.handleUserMessage(ws, message);
        break;
      
      case 'TRANSACTION_RESULT':
        await this.messageHandlers.handleTransactionResult(ws, message);
        break;
      
      default:
        console.log('⚠️ Tipo de mensaje no reconocido:', message.type);
    }
  }

  private sendMessage(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private createMessage(type: WSMessage['type'], content: any): WSMessage {
    return { ...content, type, timestamp: Date.now() };
  }

  private sendSystemMessage(ws: WebSocket, message: string, level: 'info' | 'error' | 'warning' = 'info'): void {
    this.sendMessage(ws, this.createMessage('SYSTEM_MESSAGE', { message, level }));
  }

  public start(): void {
    const port = (this.httpServer.address() as any)?.port || 8080;
    console.log(`
::HEDERA:: Hedera WebSocket Agent running on:
🌐 HTTP Health Check: http://localhost:${port}/health
🔌 WebSocket Server: ws://localhost:${port}

🤖 Enhanced LLM Configuration:
   - Model: ${MODEL_NAME}
   - Max Tokens: ${MAX_TOKENS}
   - Temperature: ${TEMPERATURE}

🧠 Enhanced Memory Configuration:
   - Fresh memory per connection: ✅ ENABLED
   - Auto cleanup on disconnect: ✅ ENABLED
   - Force clear on each message: ${FORCE_CLEAR_MEMORY ? '✅ ENABLED' : '❌ DISABLED'}
   - Max Token Limit: ${MEMORY_MAX_TOKEN_LIMIT}
   - Return Max Tokens: ${MEMORY_RETURN_MAX_TOKENS}
   
📝 To enable debug mode: Set environment variable FORCE_CLEAR_MEMORY=true
📝 To customize token limits: Set LLM_MAX_TOKENS and MEMORY_MAX_TOKEN_LIMIT

📝 Supported message types:
   - CONNECTION_AUTH: Authenticate with account ID
   - USER_MESSAGE: Send queries to the agent
   - TRANSACTION_RESULT: Confirm signed transaction results

🔄 The agent will respond with:
   - AGENT_RESPONSE: Agent text responses
   - SWAP_QUOTE: Structured swap quote data (for trades)
   - TRANSACTION_TO_SIGN: Transactions that require signing
   - SYSTEM_MESSAGE: System messages

💱 SWAP_QUOTE Structure:
   

To exit, press Ctrl+C
    `);
  }

  public stop(): void {
    this.wss.close();
    this.httpServer.close();
    console.log('🛑 WebSocket Server and HTTP Server stopped');
  }
}

// Initialize and run the agent
async function main(): Promise<void> {
  const agent = new HederaWebSocketAgent(8080);
  
  try {
    await agent.initialize();
    agent.start();

    // Handle process shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Stopping WebSocket Agent...');
      agent.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 Stopping WebSocket Agent...');
      agent.stop();
      process.exit(0);
    });

  } catch (error: any) {
    console.error('❌ Fatal error initializing the agent:', error);
    process.exit(1);
  }
}

main().catch(console.error); 