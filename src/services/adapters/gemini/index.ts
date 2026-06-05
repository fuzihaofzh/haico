/**
 * GeminiCliAdapter — Google Gemini CLI adapter.
 *
 * Handles: --output-format stream-json, --sandbox, --approval-mode yolo,
 * config args, claude-compatible JSON output format, gemini auth readiness.
 */

import type { Agent, Project } from '../../../types';
import type { ToolReadinessSummary, ToolAuthReadiness, ToolReadinessIssue } from '../../tool-readiness';
import type { AdapterEventSink } from '../types';

import { BaseCliAdapter } from '../base-cli-adapter';
import type { CliOutputState } from '../base-cli-adapter';
import {
  hasCommandFlag,
  isEmptyCommandProfileConfig,
  appendGeminiConfigArgs,
} from '../../command-profiles';
import { resolveBinaryPath } from '../../tool-readiness';
import { TOOL_INPUT_LOG_CHAR_LIMIT } from '../../process-manager/policy';
import { isDatabaseOpen } from '../../../db/database';
import os from 'os';
import path from 'path';
import fs from 'fs';

function homePath(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

function fileExists(targetPath: string): boolean {
  try { return fs.existsSync(targetPath); } catch { return false; }
}

export class GeminiCliAdapter extends BaseCliAdapter {
  readonly type = 'gemini';
  readonly requiresCompletionSignal = true;
  readonly chatTimeoutMs = 180000;

  protected buildCommand(input: {
    commandTemplate: string;
    sessionId: string;
    existingSessionId: string | null;
    commandProfileConfigJson: string;
  }): { command: string; useStreamJson: boolean } {
    const hasConfig = !isEmptyCommandProfileConfig(input.commandProfileConfigJson);

    if (hasConfig) {
      const command = appendGeminiConfigArgs(input.commandTemplate, input.commandProfileConfigJson);
      return {
        command,
        useStreamJson: /(^|\s)--output-format(?:\s|=)stream-json(?:\s|$)/.test(command),
      };
    }

    return {
      command: `${input.commandTemplate} --output-format stream-json --sandbox --approval-mode yolo`,
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
      db: any;
      logStmt: any;
      updateSessionId: (sessionId: string) => void;
    },
  ): void {
    try {
      const obj: any = JSON.parse(line);
      let handled = false;

      // Gemini uses claude-compatible output format (assistant/user/result)
      if (obj.type === 'assistant' && obj.message?.content) {
        handled = true;
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            input.logAndBroadcast(block.text + '\n', 'stdout');
          } else if (block.type === 'tool_use') {
            input.logAndBroadcast(`[Tool: ${block.name}] ${JSON.stringify(block.input).slice(0, TOOL_INPUT_LOG_CHAR_LIMIT)}\n`, 'stdout');
          }
        }
      } else if (obj.type === 'user' && obj.tool_use_result !== undefined) {
        handled = true;
        const raw = obj.tool_use_result;
        const result = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 500);
        input.logAndBroadcast(`[Result] ${result}\n`, 'stdout');
      } else if (obj.type === 'result') {
        handled = true;
        state.sawCompletionSignal = true;
        const { getAgentFinalResultTime } = require('../base-cli-adapter') as typeof import('../base-cli-adapter');
        getAgentFinalResultTime().set(input.agent.id, Date.now());
        if (obj.result) {
          input.logAndBroadcast('\n--- Final Result ---\n' + obj.result + '\n', 'stdout');
        }
        if (obj.total_cost_usd > 0 || obj.usage?.input_tokens > 0 || obj.usage?.output_tokens > 0) {
          const costUsd = obj.total_cost_usd || 0;
          const inputTokens = obj.usage?.input_tokens || 0;
          const outputTokens = obj.usage?.output_tokens || 0;
          const cacheRead = obj.usage?.cache_read_input_tokens || 0;
          const cacheCreation = obj.usage?.cache_creation_input_tokens || 0;
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          input.logAndBroadcast(`\n--- [${now}] Cost: $${costUsd.toFixed(4)} | Tokens: ${inputTokens} in, ${outputTokens} out, ${cacheRead} cache ---\n`, 'stdout');
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
    return `${commandTemplate} --output-format text -p`;
  }

  buildChatCommand(commandTemplate: string): { command: string; binary: string } {
    const binary = commandTemplate.trim().split(/\s+/)[0] || commandTemplate;
    return { command: `${commandTemplate} --output-format text -p`, binary };
  }

  inspectReadiness(commandTemplate: string): ToolReadinessSummary {
    const binary = commandTemplate.trim().split(/\s+/)[0] || commandTemplate;
    const resolved = resolveBinaryPath(binary);
    const binaryFound = !!resolved;

    let auth: ToolAuthReadiness;
    if (String(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '').trim()) {
      auth = {
        status: 'configured',
        confidence: 'env',
        message: 'Gemini credentials detected from environment variables.',
        action_command: null,
      };
    } else {
      const storedAuthFiles = [
        homePath('.config', 'gemini', 'credentials.json'),
        homePath('.gemini', 'credentials.json'),
      ];
      if (storedAuthFiles.some(fileExists)) {
        auth = {
          status: 'configured',
          confidence: 'heuristic',
          message: 'Stored Gemini credentials were found on this machine.',
          action_command: null,
        };
      } else {
        auth = {
          status: 'missing',
          confidence: 'heuristic',
          message: 'No obvious Gemini sign-in was found on this machine.',
          action_command: 'gemini auth login',
        };
      }
    }

    const issues: ToolReadinessIssue[] = [];
    if (!binaryFound) {
      issues.push({
        code: 'missing_cli',
        severity: 'blocking',
        title: 'Gemini CLI not found',
        detail: `Could not find "${binary}" on this system.`,
        action_label: null,
        action_command: null,
      });
    }
    if (auth.status === 'missing') {
      issues.push({
        code: 'auth_missing',
        severity: 'warning',
        title: 'Gemini authentication may not be configured',
        detail: auth.message,
        action_label: 'Login',
        action_command: auth.action_command,
      });
    }

    return {
      command: commandTemplate,
      command_type: 'gemini',
      tool_label: 'Gemini CLI',
      binary,
      binary_found: binaryFound,
      binary_path: resolved,
      ready: binaryFound && auth.status !== 'missing',
      issues,
      auth,
    };
  }

  buildControllerCommand(commandTemplate: string, commandProfileConfigJson?: string | Record<string, unknown> | null): string {
    return appendGeminiConfigArgs(commandTemplate, commandProfileConfigJson);
  }
}
