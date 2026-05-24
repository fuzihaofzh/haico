import { isDatabaseOpen } from '../../db/database';
import { Agent } from '../../types';
import { broadcastToAgent } from '../../realtime';
import logger from '../../logger';
import { resolveCommandType } from '../command-profiles';
import {
  CLOSED_STDIN_SESSION_RE,
  CODEX_CACHED_PRICE,
  CODEX_INPUT_PRICE,
  CODEX_OUTPUT_PRICE,
  TOOL_INPUT_LOG_CHAR_LIMIT,
} from './policy';
import {
  agentFinalResultTime,
  agentLastErrorWasApiConnect,
  isShuttingDown,
  lastActivityTime,
} from './state';
import { ProcessOutputStream } from './types';

export interface AgentOutputState {
  stdoutBuffer: string;
  sawStdout: boolean;
  stderrSample: string;
  sawClosedStdinSessionError: boolean;
  sawCompletionSignal: boolean;
}

export function createAgentOutputHandlers(input: {
  db: any;
  logStmt: any;
  agent: Agent;
  runId: string;
  isStreamJson: boolean;
  isCodex: boolean;
  resolvedCommandType: ReturnType<typeof resolveCommandType>;
  updateSessionId: (sessionId: string) => void;
  persistSessionToAgent?: boolean;
  activityKey?: string;
}): {
  state: AgentOutputState;
  logAndBroadcast: (content: string, stream: ProcessOutputStream) => void;
  handleData: (stream: ProcessOutputStream) => (data: Buffer) => void;
} {
  const state: AgentOutputState = {
    stdoutBuffer: '',
    sawStdout: false,
    stderrSample: '',
    sawClosedStdinSessionError: false,
    sawCompletionSignal: false,
  };

  function logAndBroadcast(content: string, stream: ProcessOutputStream): void {
    if (!content.trim()) return;
    if (isShuttingDown() || !isDatabaseOpen()) return;
    if (stream === 'stdout') {
      state.sawStdout = true;
    } else if (stream === 'stderr' && state.stderrSample.length < 2000) {
      state.stderrSample += content.slice(0, 2000 - state.stderrSample.length);
    }
    lastActivityTime.set(input.activityKey || input.agent.id, Date.now());
    try {
      input.logStmt.run(input.agent.id, input.runId, content, stream);
    } catch (e: any) {
      logger.warn({ err: e }, `logAndBroadcast: failed to write log for agent ${input.agent.id}`);
      return;
    }
    broadcastToAgent(input.agent.id, { type: 'output', stream, content, runId: input.runId });
  }

  function parseStreamJsonLine(line: string): void {
    try {
      const obj: any = JSON.parse(line);
      let handled = false;

      if (input.isCodex) {
        if (obj.type === 'thread.started' && obj.thread_id) {
          handled = true;
          input.updateSessionId(obj.thread_id);
          if (input.persistSessionToAgent !== false && isDatabaseOpen()) {
            input.db.prepare('UPDATE agents SET session_id = ? WHERE id = ?')
              .run(obj.thread_id, input.agent.id);
          }
          logger.debug({
            agentId: input.agent.id,
            runId: input.runId,
            sessionId: obj.thread_id,
          }, 'agent.codex_thread.started');
        } else if (obj.type === 'item.completed' && obj.item) {
          handled = true;
          if (obj.item.type === 'agent_message' && obj.item.text) {
            logAndBroadcast(obj.item.text + '\n', 'stdout');
          } else if (obj.item.type === 'tool_call') {
            logAndBroadcast(`[Tool: ${obj.item.name || 'unknown'}] ${JSON.stringify(obj.item).slice(0, TOOL_INPUT_LOG_CHAR_LIMIT)}\n`, 'stdout');
          } else if (obj.item.type === 'tool_call_output') {
            const output = (obj.item.output || obj.item.text || '').slice(0, 500);
            logAndBroadcast(`[Result] ${output}\n`, 'stdout');
          }
        } else if (obj.type === 'turn.completed' && obj.usage) {
          handled = true;
          state.sawCompletionSignal = true;
          const inputTokens = obj.usage.input_tokens || 0;
          const outputTokens = obj.usage.output_tokens || 0;
          const cacheRead = obj.usage.cached_input_tokens || 0;
          const cacheCreation = Math.max(0, inputTokens - cacheRead);
          const reportedCost = obj.cost_usd || obj.total_cost_usd || obj.usage?.cost_usd || obj.usage?.cost || 0;
          const costUsd = reportedCost > 0
            ? reportedCost
            : (cacheRead * CODEX_CACHED_PRICE + cacheCreation * CODEX_INPUT_PRICE + outputTokens * CODEX_OUTPUT_PRICE);
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          const costLabel = costUsd > 0 ? ` | Cost: $${costUsd.toFixed(4)}` : '';
          logAndBroadcast(`\n--- [${now}] Tokens: ${inputTokens} in, ${outputTokens} out, ${cacheRead} cache${costLabel} ---\n`, 'stdout');
          try {
            input.db.prepare("INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, 'cost')")
              .run(input.agent.id, input.runId, JSON.stringify({
                cost_usd: costUsd,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_read: cacheRead,
                cache_creation: cacheCreation,
              }));
          } catch {}
        } else if (obj.type === 'turn.started') {
          handled = true;
        }
      }

      if (!handled && obj.type === 'assistant' && obj.message?.content) {
        handled = true;
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            logAndBroadcast(block.text + '\n', 'stdout');
          } else if (block.type === 'tool_use') {
            logAndBroadcast(`[Tool: ${block.name}] ${JSON.stringify(block.input).slice(0, TOOL_INPUT_LOG_CHAR_LIMIT)}\n`, 'stdout');
          }
        }
      } else if (!handled && obj.type === 'user' && obj.tool_use_result !== undefined) {
        handled = true;
        const raw = obj.tool_use_result;
        const result = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 500);
        logAndBroadcast(`[Result] ${result}\n`, 'stdout');
      } else if (!handled && obj.type === 'result') {
        handled = true;
        state.sawCompletionSignal = true;
        agentFinalResultTime.set(input.agent.id, Date.now());
        if (obj.result) {
          logAndBroadcast('\n--- Final Result ---\n' + obj.result + '\n', 'stdout');
        }
        if (obj.total_cost_usd > 0 || obj.usage?.input_tokens > 0 || obj.usage?.output_tokens > 0) {
          const costUsd = obj.total_cost_usd || 0;
          const inputTokens = obj.usage?.input_tokens || 0;
          const outputTokens = obj.usage?.output_tokens || 0;
          const cacheRead = obj.usage?.cache_read_input_tokens || 0;
          const cacheCreation = obj.usage?.cache_creation_input_tokens || 0;
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          logAndBroadcast(`\n--- [${now}] Cost: $${costUsd.toFixed(4)} | Tokens: ${inputTokens} in, ${outputTokens} out, ${cacheRead} cache ---\n`, 'stdout');
          try {
            input.db.prepare("INSERT INTO conversation_logs (agent_id, run_id, content, stream) VALUES (?, ?, ?, 'cost')")
              .run(input.agent.id, input.runId, JSON.stringify({
                cost_usd: costUsd,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_read: cacheRead,
                cache_creation: cacheCreation,
                duration_ms: obj.duration_ms,
              }));
          } catch {}
        }
      }

      if (!handled) {
        logAndBroadcast(line + '\n', 'stdout');
      }
    } catch {
      if (!line.includes('proxychains') && !line.includes('Executing through proxy') && !line.includes('Port 7897')) {
        logAndBroadcast(line + '\n', 'stdout');
      }
    }
  }

  const handleData = (stream: ProcessOutputStream) => (data: Buffer) => {
    const raw = data.toString();

    if (raw.includes('Unable to connect to API')) {
      agentLastErrorWasApiConnect.set(input.agent.id, true);
    }

    if (stream === 'stderr') {
      if (CLOSED_STDIN_SESSION_RE.test(raw)) {
        state.sawClosedStdinSessionError = true;
      }
      if (!raw.includes('proxychains')) {
        logAndBroadcast(raw, 'stderr');
      }
      return;
    }

    if (!input.isStreamJson) {
      logAndBroadcast(raw, 'stdout');
      return;
    }

    state.stdoutBuffer += raw;
    const lines = state.stdoutBuffer.split('\n');
    state.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) parseStreamJsonLine(line.trim());
    }
  };

  return { state, logAndBroadcast, handleData };
}
