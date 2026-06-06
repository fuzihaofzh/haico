/**
 * OmpCliAdapter — Oh My Pi (OMP) CLI adapter.
 *
 * Handles: -p --mode json, --model, --thinking, --tools, --no-lsp,
 * --auto-approve, --approval-mode, session --no-session/--resume,
 * JSON event-stream output format, OMP auth readiness.
 *
 * OMP JSON event stream (newline-delimited):
 *   session → thinking_level_changed → agent_start → turn_start →
 *   message_start/message_update/message_end (with usage) →
 *   turn_end → agent_end
 */

import type { Agent, Project } from '../../../types';
import type { ToolReadinessSummary, ToolAuthReadiness, ToolReadinessIssue } from '../../tool-readiness';
import type { AdapterEventSink } from '../types';

import { BaseCliAdapter } from '../base-cli-adapter';
import type { CliOutputState } from '../base-cli-adapter';
import {
  hasCommandFlag,
  isEmptyCommandProfileConfig,
  appendOmpConfigArgs,
} from '../../command-profiles';
import { resolveBinaryPath } from '../../tool-readiness';
import { TOOL_INPUT_LOG_CHAR_LIMIT } from '../../process-manager/policy';
import { isDatabaseOpen } from '../../../db/database';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import fs from 'fs';

function homePath(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

function fileExists(targetPath: string): boolean {
  try { return fs.existsSync(targetPath); } catch { return false; }
}

// ── OMP JSON event types ──

interface OmpUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface OmpCostRow {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  duration_ms?: number;
}

interface OmpMessageContent {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface OmpMessage {
  role: string;
  content?: OmpMessageContent[];
  usage?: OmpUsage;
  stopReason?: string;
  duration?: number;
}

interface OmpAssistantMessageEvent {
  type: string;
  contentIndex?: number;
  text?: string;
  thinking?: string;
}

interface OmpJsonEvent {
  type: string;
  id?: string;
  message?: OmpMessage;
  assistantMessageEvent?: OmpAssistantMessageEvent;
}

export class OmpCliAdapter extends BaseCliAdapter {
  readonly type = 'omp';
  readonly requiresCompletionSignal = true;
  readonly chatTimeoutMs = 180000;

  protected buildCommand(input: {
    commandTemplate: string;
    sessionId: string;
    existingSessionId: string | null;
    commandProfileConfigJson: string;
  }): { command: string; useStreamJson: boolean } {
    const hasConfig = !isEmptyCommandProfileConfig(input.commandProfileConfigJson);
    const sessionFlag = input.existingSessionId
      ? `--resume ${input.sessionId}`
      : '--no-session';

    if (hasConfig) {
      const baseParts = [
        input.commandTemplate,
        hasCommandFlag(input.commandTemplate, '-p') ? '' : '-p',
        '@$HAICO_PROMPT_FILE',
        hasCommandFlag(input.commandTemplate, '--mode') ? '' : '--mode json',
        sessionFlag,
        hasCommandFlag(input.commandTemplate, '--approval-mode') ? '' : '--approval-mode yolo',
      ].filter(Boolean);
      return {
        command: appendOmpConfigArgs(baseParts.join(' '), input.commandProfileConfigJson),
        useStreamJson: true,
      };
    }

    return {
      command: `${input.commandTemplate} -p @$HAICO_PROMPT_FILE --mode json ${sessionFlag} --approval-mode yolo`,
      useStreamJson: true,
    };
  }

  protected parseOutputLine(
    line: string,
    state: CliOutputState,
    input: {
      agent: Agent;
      runId: string;
      sink: AdapterEventSink;
      logAndBroadcast: (content: string, stream: 'stdout' | 'stderr') => void;
      db: Database.Database;
      logStmt: Database.Statement;
      updateSessionId: (sessionId: string) => void;
    },
  ): void {
    try {
      const obj: OmpJsonEvent = JSON.parse(line);
      let handled = false;

      // OMP session event — capture session ID
      if (obj.type === 'session' && obj.id) {
        handled = true;
        input.updateSessionId(obj.id);
        if (isDatabaseOpen()) {
          input.db.prepare('UPDATE agents SET session_id = ? WHERE id = ?')
            .run(obj.id, input.agent.id);
        }
      }

      // OMP assistant message_end — has usage and full content
      if (obj.type === 'message_end' && obj.message?.role === 'assistant') {
        handled = true;
        const msg = obj.message;

        // Broadcast completed text content
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              input.logAndBroadcast(block.text + '\n', 'stdout');
            } else if (block.type === 'tool_use' && block.name) {
              const inputStr = JSON.stringify(block.input).slice(0, TOOL_INPUT_LOG_CHAR_LIMIT);
              input.logAndBroadcast(`[Tool: ${block.name}] ${inputStr}\n`, 'stdout');
            }
          }
        }

        // Record cost from usage
        if (msg.usage && (msg.usage.cost?.total || msg.usage.input || msg.usage.output)) {
          const costUsd = msg.usage.cost?.total || 0;
          const inputTokens = msg.usage.input || 0;
          const outputTokens = msg.usage.output || 0;
          const cacheRead = msg.usage.cacheRead || 0;
          const cacheWrite = msg.usage.cacheWrite || 0;
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          const costLabel = costUsd > 0 ? ` | Cost: $${costUsd.toFixed(4)}` : '';
          input.logAndBroadcast(`\n--- [${now}] Tokens: ${inputTokens} in, ${outputTokens} out, ${cacheRead} cache, ${cacheWrite} cache-write${costLabel} ---\n`, 'stdout');
          try {
            const costRow: OmpCostRow = {
              cost_usd: costUsd,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_read: cacheRead,
              cache_write: cacheWrite,
              duration_ms: msg.duration,
            };
            input.logStmt.run(input.agent.id, input.runId, JSON.stringify(costRow), 'cost');
          } catch { /* ignore db write failures during shutdown */ }
        }
      }

      // OMP agent_end — completion signal
      if (obj.type === 'agent_end') {
        handled = true;
        state.sawCompletionSignal = true;
        const { getAgentFinalResultTime } = require('../base-cli-adapter') as typeof import('../base-cli-adapter');
        getAgentFinalResultTime().set(input.agent.id, Date.now());
      }

      // OMP streaming text delta — forward for real-time output
      if (obj.type === 'message_update' && obj.assistantMessageEvent) {
        const evt = obj.assistantMessageEvent;
        if (evt.type === 'text_delta' && evt.text) {
          handled = true;
          input.logAndBroadcast(evt.text, 'stdout');
        } else if (evt.type === 'thinking_delta' && evt.thinking) {
          handled = true;
          // Lighter-weight: just note thinking is happening, don't dump full thinking
        } else if (evt.type === 'text_start' || evt.type === 'text_end' ||
                   evt.type === 'thinking_start' || evt.type === 'thinking_end') {
          handled = true;
        }
      }

      // Silence non-essential events
      if (obj.type === 'thinking_level_changed' || obj.type === 'agent_start' ||
          obj.type === 'turn_start' || obj.type === 'turn_end' ||
          obj.type === 'message_start') {
        handled = true;
      }

      if (!handled) {
        input.logAndBroadcast(line + '\n', 'stdout');
      }
    } catch {
      if (!line.includes('proxychains') && !line.includes('Executing through proxy') && !line.includes('Port 7897')) {
        input.logAndBroadcast(line + '\n', 'stdout');
      }
    }
  }

  buildSystemPromptSection(_agent: Agent, _project: Project): string {
    return '';
  }

  buildPtyArgs(commandTemplate: string, _sessionId?: string): {
    command: string;
    args: string[];
    useShell: boolean;
  } {
    const parts = commandTemplate.trim().split(/\s+/);
    return { command: parts[0] || commandTemplate, args: parts.slice(1), useShell: false };
  }

  buildMetadataCommand(commandTemplate: string): string {
    return `${commandTemplate} -p --mode text`;
  }

  buildChatCommand(commandTemplate: string): { command: string; binary: string } {
    const binary = commandTemplate.trim().split(/\s+/)[0] || commandTemplate;
    // OMP -p requires a positional prompt argument; "$(cat)" consumes stdin from spawnSync.
    // No --mode json: dashboard-chat parseAssistantEnvelope expects plain text or
    // single-envelope JSON, not a JSONL event stream.
    return { command: `${commandTemplate} -p "$(cat)"`, binary };
  }

  inspectReadiness(commandTemplate: string): ToolReadinessSummary {
    const binary = commandTemplate.trim().split(/\s+/)[0] || commandTemplate;
    const resolved = resolveBinaryPath(binary);
    const binaryFound = !!resolved;

    let auth: ToolAuthReadiness;
    const ompConfigDir = homePath('.config', 'omp');
    const ompCredFile = path.join(ompConfigDir, 'credentials.json');
    if (fs.existsSync(ompCredFile)) {
      auth = {
        status: 'configured',
        confidence: 'heuristic',
        message: 'OMP credentials file found.',
        action_command: null,
      };
    } else {
      auth = {
        status: 'unknown',
        confidence: 'unknown',
        message: 'Could not verify OMP authentication status.',
        action_command: null,
      };
    }

    const issues: ToolReadinessIssue[] = [];
    if (!binaryFound) {
      issues.push({
        code: 'missing_cli',
        severity: 'blocking',
        title: 'OMP CLI not found',
        detail: `Could not find "${binary}" on this system.`,
        action_label: null,
        action_command: null,
      });
    }

    return {
      command: commandTemplate,
      command_type: 'omp',
      tool_label: 'OMP',
      binary,
      binary_found: binaryFound,
      binary_path: resolved,
      ready: binaryFound,
      issues,
      auth,
    };
  }

  buildControllerCommand(commandTemplate: string, commandProfileConfigJson?: string | Record<string, unknown> | null): string {
    return appendOmpConfigArgs(commandTemplate, commandProfileConfigJson);
  }
}
