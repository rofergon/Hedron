import WebSocket from 'ws';
import { Client } from '@hashgraph/sdk';
import { ChatOpenAI } from '@langchain/openai';
import { 
  WSMessage, 
  UserMessage, 
  ConnectionAuth, 
  TransactionResult, 
  UserConnection,
  PendingStep 
} from '../types/websocket-types';
import { AgentResponseUtils } from '../utils/agent-response-utils';
import { ConnectionManager } from './connection-manager';

/**
 * Handles different types of WebSocket messages
 */
export class MessageHandlers {
  private connectionManager: ConnectionManager;
  private llm: ChatOpenAI;
  private agentClient: Client;
  private forceClearMemory: boolean;

  constructor(
    connectionManager: ConnectionManager,
    llm: ChatOpenAI,
    agentClient: Client,
    forceClearMemory: boolean = false
  ) {
    this.connectionManager = connectionManager;
    this.llm = llm;
    this.agentClient = agentClient;
    this.forceClearMemory = forceClearMemory;
  }

  /**
   * Handle user authentication
   */
  async handleConnectionAuth(ws: WebSocket, message: ConnectionAuth): Promise<void> {
    try {
      console.log('🔐 User authentication:', message.userAccountId);
      
      // Create user connection with their own toolkit
      const userConnection = await this.connectionManager.createUserConnection(
        ws, 
        message.userAccountId,
        this.llm,
        this.agentClient
      );
      this.connectionManager.addConnection(ws, userConnection);
      
      this.sendSystemMessage(ws, `✅ Authenticated successfully with account ${message.userAccountId}. You can now start asking questions!`, 'info');
    } catch (error: any) {
      console.error('❌ Error during authentication:', error);
      this.sendSystemMessage(ws, `Authentication failed: ${error.message}`, 'error');
    }
  }

  /**
   * Handle user messages
   */
  async handleUserMessage(ws: WebSocket, message: UserMessage): Promise<void> {
    try {
      const userConnection = this.connectionManager.getConnection(ws);
      
      if (!userConnection) {
        this.sendSystemMessage(ws, 'Please authenticate first using CONNECTION_AUTH message.', 'error');
        return;
      }

      console.log(`👤 User (${userConnection.userAccountId}):`, message.message);

      // If the message includes a different userAccountId, recreate the connection
      if (message.userAccountId && message.userAccountId !== userConnection.userAccountId) {
        console.log('🔄 Switching to different account:', message.userAccountId);
        // First cleanup the old connection
        await this.connectionManager.cleanupConnection(ws);
        // Then create new connection
        const newUserConnection = await this.connectionManager.createUserConnection(
          ws, 
          message.userAccountId,
          this.llm,
          this.agentClient
        );
        this.connectionManager.addConnection(ws, newUserConnection);
        
        this.sendSystemMessage(ws, `Switched to account ${message.userAccountId}`, 'info');
      }

      const currentConnection = this.connectionManager.getConnection(ws)!;
      
      // 🧠 LangGraph: Memory is handled automatically through checkpointer
      console.log(`🧠 Processing message for user: ${currentConnection.userAccountId}`);
      console.log(`🔗 Using thread ID: ${currentConnection.threadId}`);
      
      // 🧠 MVP: Force clear memory on each message if flag is set (for debugging memory issues)
      // Note: With LangGraph, we would need to clear the entire thread, which we skip for now
      if (this.forceClearMemory) {
        console.log('🧹 FORCE_CLEAR_MEMORY enabled - Note: Full thread clearing not implemented yet');
      }
      
      // Pre-route: detect limit order intent to avoid swap tools misuse
      const routedInput = this.applyLimitOrderRoutingHints(message.message);

      // Process message with LangGraph agent
      // Pass the thread ID for conversation continuity
      const response = await currentConnection.agent.invoke(
        { messages: [{ role: 'user', content: routedInput }] },
        { configurable: { thread_id: currentConnection.threadId } }
      );
      
      // Extract the final AI message
      const messages = (response.messages || []) as any[];
      const lastMessage = messages[messages.length - 1];
      const outputText = lastMessage?.content || JSON.stringify(response);
      
      console.log('🤖 Agent:', outputText);

      // Extract transaction bytes if they exist
      const bytes = AgentResponseUtils.extractBytesFromAgentResponse(response);
      const nextStep = AgentResponseUtils.extractNextStepFromAgentResponse(response);
      const swapQuote = AgentResponseUtils.extractSwapQuoteFromAgentResponse(response);
      const opCtx = AgentResponseUtils.extractOperationContext(response);
      const preparedTxInfo = AgentResponseUtils.extractPreparedTxInfo(response);
      
      // Check if this is a swap quote and send structured data first
      if (swapQuote) {
        console.log('💱 Sending structured swap quote to frontend');
        this.sendMessage(ws, swapQuote);
      }
      
      if (bytes !== undefined) {
        // There is a transaction to sign
        // If multiple prepared transactions exist, enforce priority: association -> approval -> others
        const selectedBytes = preparedTxInfo?.bytes || bytes;
        const realBytes = Buffer.isBuffer(selectedBytes) ? selectedBytes : Buffer.from(selectedBytes.data);
        
        // Store pending step information for multi-step flows
        if (nextStep) {
          console.log(`📝 Storing pending step: ${nextStep.step} for ${nextStep.tool}`);
          console.log(`📝 Storing pending step details:`, {
            tool: nextStep.tool,
            operation: nextStep.operation,
            step: nextStep.step,
            originalParams: nextStep.originalParams,
            nextStepInstructions: nextStep.nextStepInstructions
          });
          currentConnection.pendingStep = nextStep;
        } else {
          console.log('📝 No next step detected from agent response');
        }

        // Store last prepared operation context for final summary on confirmation
        if (opCtx) {
          currentConnection.lastPreparedOperation = opCtx;
        }
        
        // Send agent response and transaction
        this.sendMessage(ws, this.createMessage('AGENT_RESPONSE', {
          message: outputText,
          hasTransaction: true
        }));
        this.sendMessage(ws, this.createMessage('TRANSACTION_TO_SIGN', {
          transactionBytes: Array.from(realBytes),
          originalQuery: message.message
        }));
      } else {
        // Only agent response, no transaction
        this.sendMessage(ws, this.createMessage('AGENT_RESPONSE', {
          message: outputText,
          hasTransaction: false
        }));
      }
    } catch (error: any) {
      console.error('❌ Error processing user message:', error);
      this.sendSystemMessage(ws, `Error processing your request: ${error.message}`, 'error');
    }
  }

  /**
   * Add strong hints to force AutoSwapLimit tool when user intent looks like a limit order
   */
  private applyLimitOrderRoutingHints(original: string): string {
    const text = (original || '').toLowerCase();
    const hasPriceWord = /(target\s*price|precio\s*objetivo|precio\s*meta|when\s+price|cuando\s+el\s+precio|al\s+precio|\$|usdc|usd|udc)/i.test(original);
    const hasOrderWord = /(limit\s*order|orden\s*l[ií]mite|program(ar)?\s*orden|set\s*limit)/i.test(original);
    const hasAtWord = /(at\s+|a\s+\$?\d)/i.test(original);

    if (hasPriceWord || hasOrderWord || hasAtWord) {
      const hint = `CRITICAL: This is a LIMIT ORDER request. Do NOT use swap quote or swap execution tools. Use ONLY autoswap_limit_tool with operation "create_swap_order". If any parameter is missing (tokenOut, amountIn, minAmountOut, triggerPrice), ask briefly for the missing piece or use minimal safe defaults (minAmountOut="1"). Then return a single transaction for signing if needed.`;
      return `${hint}\n\nUser: ${original}`;
    }
    return original;
  }

  /**
   * Handle transaction results
   */
  async handleTransactionResult(ws: WebSocket, message: TransactionResult): Promise<void> {
    const userConnection = this.connectionManager.getConnection(ws);
    
    if (message.success) {
      console.log('✅ Transaction confirmed:', message.transactionId);
      console.log('📊 Status:', message.status);
      
      this.sendSystemMessage(ws, `✅ Transaction executed successfully!\nID: ${message.transactionId}\nStatus: ${message.status}`, 'info');

      // Check if there's a pending next step to execute
      if (userConnection?.pendingStep) {
        console.log('🔄 Executing next step automatically:', userConnection.pendingStep.step);
        console.log('🔄 Pending step details before execution:', {
          tool: userConnection.pendingStep.tool,
          operation: userConnection.pendingStep.operation,
          step: userConnection.pendingStep.step,
          originalParams: userConnection.pendingStep.originalParams
        });
        await this.executeNextStep(ws, userConnection);
      } else {
        console.log('🔄 No pending step to execute after transaction confirmation');
        // When there is no next step, emit a concise final summary as confirmation
        if (userConnection?.lastPreparedOperation) {
          const final = userConnection.lastPreparedOperation;
          // Build short confirmation message per operation
          let summary = '';
          if (final.protocol === 'saucerswap') {
            if (final.operation === 'associate_tokens') {
              summary = `✅ Tokens associated successfully${final.tokenIds ? `: ${final.tokenIds.join(', ')}` : ''}.`;
            } else if (final.operation === 'approve_sauce') {
              summary = `✅ SAUCE approval confirmed${final.amountLabel ? ` (${final.amountLabel})` : ''}.`;
            } else if (final.operation === 'stake_sauce') {
              summary = `✅ Staking completed${final.amountLabel ? `: ${final.amountLabel} staked into Infinity Pool` : ''}.`;
            } else if (final.operation === 'unstake_xsauce') {
              summary = `✅ Unstaking completed.`;
            }
          }

          if (summary) {
            this.sendMessage(ws, this.createMessage('AGENT_RESPONSE', {
              message: `# ✅ Operación completada\n\n${summary}`,
              hasTransaction: false,
            }));
          }
          // Clear the stored context after summarizing
          userConnection.lastPreparedOperation = undefined;
        }
      }
    } else {
      console.log('❌ Transaction failed:', message.error);
      
      // Clear pending step on failure
      if (userConnection?.pendingStep) {
        console.log('🚫 Clearing pending step due to transaction failure');
        userConnection.pendingStep = undefined;
      }
      
      this.sendSystemMessage(ws, `❌ Transaction error: ${message.error}`, 'error');
    }
  }

  /**
   * Execute the next step in a multi-step flow
   */
  private async executeNextStep(ws: WebSocket, userConnection: UserConnection): Promise<void> {
    if (!userConnection.pendingStep) {
      console.log('⚠️ No pending step to execute');
      return;
    }

    const pendingStep = userConnection.pendingStep;
    console.log(`🚀 Executing next step: ${pendingStep.step} for ${pendingStep.tool}`);
    console.log(`🔍 Pending step details:`, {
      tool: pendingStep.tool,
      operation: pendingStep.operation,
      step: pendingStep.step,
      originalParams: pendingStep.originalParams,
      nextStepInstructions: pendingStep.nextStepInstructions
    });

    try {
      // Create the message for the next step based on the tool and operation
      let nextStepMessage = '';
      
      if (pendingStep.tool === 'bonzo_deposit_tool' && pendingStep.step === 'approval') {
        // For Bonzo deposit flow, trigger the approval step after token association
        const params = pendingStep.originalParams;
        const token = params.token || 'hbar';
        const amount = params.amount || params.hbarAmount || 0;
        nextStepMessage = `Use bonzo_approve_step_tool to approve ${amount} ${token.toUpperCase()} for Bonzo Finance LendingPool with token "${token}", amount ${amount}, userAccountId "${userConnection.userAccountId}"`;
      } else if (pendingStep.tool === 'bonzo_deposit_tool' && pendingStep.step === 'deposit') {
        // For Bonzo deposit flow, trigger the deposit step only (after approval or for HBAR)
        const params = pendingStep.originalParams;
        const token = params.token || 'hbar';
        const amount = params.amount || params.hbarAmount || 0; // Support both new and old format
        nextStepMessage = `Use bonzo_deposit_step_tool to deposit ${amount} ${token.toUpperCase()} for account ${userConnection.userAccountId} with token "${token}", amount ${amount}, and referral code ${params.referralCode || 0}`;
      } else if (pendingStep.tool === 'saucerswap_infinity_pool_tool' && pendingStep.step === 'approval') {
        // For Infinity Pool flow, trigger the approval step after token association
        const params = pendingStep.originalParams;
        nextStepMessage = `Execute SAUCE approval for staking: Use saucerswap_infinity_pool_tool with operation "approve_sauce", sauceAmount ${params.sauceAmount || 100}, userAccountId "${userConnection.userAccountId}", originalParams as provided in the flow context`;
      } else if (pendingStep.tool === 'saucerswap_infinity_pool_tool' && pendingStep.step === 'stake') {
        // For Infinity Pool flow, trigger the staking step after approval
        const params = pendingStep.originalParams;
        nextStepMessage = `Use saucerswap_infinity_pool_step_tool to stake ${params.sauceAmount} SAUCE for account ${userConnection.userAccountId} with originalParams ${JSON.stringify(params)}`;
      } else {
        // Generic next step execution
        nextStepMessage = `Execute ${pendingStep.step} step for ${pendingStep.tool}`;
      }

      console.log(`📝 Triggering next step with message: ${nextStepMessage}`);

      // Clear the pending step before execution to avoid loops
      userConnection.pendingStep = undefined;

      // Execute the next step through the agent with LangGraph
      const response = await userConnection.agent.invoke(
        { messages: [{ role: 'user', content: nextStepMessage }] },
        { configurable: { thread_id: userConnection.threadId } }
      );

      // Extract the final AI message
      const messages = (response.messages || []) as any[];
      const lastMessage = messages[messages.length - 1];
      const outputText = lastMessage?.content || JSON.stringify(response);
      
      console.log('🤖 Agent (Next Step):', outputText);

      // Extract transaction bytes for the next step
      const bytes = AgentResponseUtils.extractBytesFromAgentResponse(response);
      const nextStep = AgentResponseUtils.extractNextStepFromAgentResponse(response);

      if (bytes !== undefined) {
        // There is another transaction to sign
        const realBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.data);
        
        // Store any additional pending steps
        if (nextStep) {
          console.log(`📝 Storing additional pending step: ${nextStep.step} for ${nextStep.tool}`);
          userConnection.pendingStep = nextStep;
        }

        // Send agent response and transaction
        this.sendMessage(ws, this.createMessage('AGENT_RESPONSE', {
          message: outputText,
          hasTransaction: true
        }));
        this.sendMessage(ws, this.createMessage('TRANSACTION_TO_SIGN', {
          transactionBytes: Array.from(realBytes),
          originalQuery: `Next step: ${pendingStep.step}`
        }));
      } else {
        // Only agent response, flow completed
        this.sendMessage(ws, this.createMessage('AGENT_RESPONSE', {
          message: outputText,
          hasTransaction: false
        }));
      }

    } catch (error: any) {
      console.error('❌ Error executing next step:', error);
      
      this.sendSystemMessage(ws, `❌ Error executing next step: ${error.message}`, 'error');
      
      // Clear pending step on error
      userConnection.pendingStep = undefined;
    }
  }

  /**
   * Send a WebSocket message
   */
  private sendMessage(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Create a WebSocket message with timestamp
   */
  private createMessage(type: WSMessage['type'], content: any): WSMessage {
    return { ...content, type, timestamp: Date.now() };
  }

  /**
   * Send a system message
   */
  private sendSystemMessage(ws: WebSocket, message: string, level: 'info' | 'error' | 'warning' = 'info'): void {
    this.sendMessage(ws, this.createMessage('SYSTEM_MESSAGE', { message, level }));
  }
}