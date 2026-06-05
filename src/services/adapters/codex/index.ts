/**
 * CodexCliAdapter — OpenAI Codex CLI adapter.
 *
 * Handles: exec/resume, --json, sandbox flags, thread.started/item.completed/turn.completed
 * JSON output format, codex auth readiness.
 */

import type { Agent, Project } from '../../../types';
import type { ToolReadinessSummary, ToolAuthReadiness, ToolReadinessIssue } from '../../tool-readiness';
import type { AdapterEventSink } from '../types';

import { BaseCliAdapter } from '../base-cli-adapter';
import type { CliOutputState } from '../base-cli-adapter';
import {
  hasCommandFlag,
  isEmptyCommandProfileConfig,
  appendCodexConfigArgs,
} from '../../command-profiles';
import { resolveBinaryPath } from '../../tool-readiness';
import {
  CODEX_CACHED_PRICE,
  CODEX_INPUT_PRICE,
  CODEX_OUTPUT_PRICE,
  TOOL_INPUT_LOG_CHAR_LIMIT,
} from '../../process-manager/policy';
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

export class CodexCliAdapter extends BaseCliAdapter {
  readonly type = 'codex';
  readonly requiresCompletionSignal = true;
  readonly chatTimeoutMs = 240000;

  protected buildCommand(input: {
    commandTemplate: string;
    sessionId: string;
    existingSessionId: string | null;
    commandProfileConfigJson: string;
  }): { command: string; useStreamJson: boolean } {
    const lowerTool = input.commandTemplate.toLowerCase();
    const hasExplicitExec = /\bexec\b/.test(lowerTool);
    const hasConfig = !isEmptyCommandProfileConfig(input.commandProfileConfigJson);

    if (hasExplicitExec) {
      return {
        command: input.commandTemplate,
        useStreamJson: input.commandTemplate.includes('--json'),
      };
    }

    if (input.existingSessionId) {
      if (hasConfig) {
        const base = `${input.commandTemplate} exec resume --json ${input.sessionId} -`;
        return {
          command: appendCodexConfigArgs(base, input.commandProfileConfigJson),
          useStreamJson: true,
        };
      }
      return {
        command: `${input.commandTemplate} exec resume --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${input.sessionId} -`,
        useStreamJson: true,
      };
    }

    if (hasConfig) {
      const base = `${input.commandTemplate} exec --json`;
      return {
        command: appendCodexConfigArgs(base, input.commandProfileConfigJson),
        useStreamJson: true,
      };
    }

    return {
      command: `${input.commandTemplate} exec --json --sandbox danger-full-access --skip-git-repo-check`,
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

      // Codex thread.started
      if (obj.type === 'thread.started' && obj.thread_id) {
        handled = true;
        input.updateSessionId(obj.thread_id);
        if (isDatabaseOpen()) {
          input.db.prepare('UPDATE agents SET session_id = ? WHERE id = ?')
            .run(obj.thread_id, input.agent.id);
        }
      }
      // Codex item.completed
      else if (obj.type === 'item.completed' && obj.item) {
        handled = true;
        if (obj.item.type === 'agent_message' && obj.item.text) {
          input.logAndBroadcast(obj.item.text + '\n', 'stdout');
        } else if (obj.item.type === 'tool_call') {
          input.logAndBroadcast(`[Tool: ${obj.item.name || 'unknown'}] ${JSON.stringify(obj.item).slice(0, TOOL_INPUT_LOG_CHAR_LIMIT)}\n`, 'stdout');
        } else if (obj.item.type === 'tool_call_output') {
          const output = (obj.item.output || obj.item.text || '').slice(0, 500);
          input.logAndBroadcast(`[Result] ${output}\n`, 'stdout');
        }
      }
      // Codex turn.completed
      else if (obj.type === 'turn.completed' && obj.usage) {
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
        input.logAndBroadcast(`\n--- [${now}] Tokens: ${inputTokens} in, ${outputTokens} out, ${cacheRead} cache${costLabel} ---\n`, 'stdout');
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
      }
      // Codex turn.started — no action needed
      else if (obj.type === 'turn.started') {
        handled = true;
      }

      // Claude-compatible formats (for when codex output includes them)
      if (!handled && obj.type === 'assistant' && obj.message?.content) {
        handled = true;
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            input.logAndBroadcast(block.text + '\n', 'stdout');
          } else if (block.type === 'tool_use') {
            input.logAndBroadcast(`[Tool: ${block.name}] ${JSON.stringify(block.input).slice(0, TOOL_INPUT_LOG_CHAR_LIMIT)}\n`, 'stdout');
          }
        }
      } else if (!handled && obj.type === 'user' && obj.tool_use_result !== undefined) {
        handled = true;
        const raw = obj.tool_use_result;
        const result = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 500);
        input.logAndBroadcast(`[Result] ${result}\n`, 'stdout');
      } else if (!handled && obj.type === 'result') {
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
    return `
## Codex 执行约束
- 对于需要持续运行、后续还要继续交互的命令，第一次就必须使用带 \`tty: true\` 的交互会话。典型例子：dev server、\`tail -f\`、\`watch\`、REPL、\`ssh\`、\`sqlite3\` 交互模式、\`google-chrome --headless --remote-debugging-port=...\`。
- 只有在拿到交互命令返回的 \`session_id\` 之后，才能继续对该会话调用 \`write_stdin\`。不要对已经结束、没有 tty、或 stdin 已关闭的命令会话继续写入。
- 如果命令只是一次性执行，不需要后续交互，就不要再调用 \`write_stdin\`；直接等待命令完成并读取输出。
- 需要后台服务时，优先把"启动 + 检查 + 清理"放进同一个一次性脚本里完成；除非明确需要持续交互，否则不要把浏览器、服务器、调试端口单独常驻后再尝试补写 stdin。
- 如果你看到 \`stdin is closed for this session\`、\`write_stdin failed\` 或类似提示，立刻放弃旧会话，重新创建新的 tty 会话，不要沿用出错会话。
- 做 UI/浏览器验证时，优先使用一次性脚本完成完整验证流程；只有在确实需要保持进程存活时才开交互 tty。`;
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
    const toolBinary = commandTemplate.split(/\s+/).filter(Boolean)[0] || commandTemplate;
    return `${toolBinary} exec --sandbox workspace-write --skip-git-repo-check -`;
  }

  buildChatCommand(commandTemplate: string): { command: string; binary: string } {
    const { shellWords, shellQuote, resolveCodexScriptPath } = require('../../command-profiles');
    const words = shellWords(commandTemplate);
    const hasExplicitExec = words.includes('exec');
    const codexIndex = words.findIndex((word: string) => {
      const base = path.basename(word).toLowerCase();
      return base === 'codex' || base === 'codex.js';
    });
    if (codexIndex >= 0) {
      const codexScriptPath = resolveCodexScriptPath(words[codexIndex]);
      if (codexScriptPath) {
        const launcherIndex = codexIndex > 0 && /^node(?:\.exe)?$/i.test(path.basename(words[codexIndex - 1]))
          ? codexIndex - 1
          : -1;
        const rewrittenWords = [
          ...words.slice(0, launcherIndex >= 0 ? launcherIndex : codexIndex),
          process.execPath,
          codexScriptPath,
          ...words.slice(codexIndex + 1),
        ];
        if (!hasExplicitExec) {
          rewrittenWords.push('exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-');
        }
        return {
          command: rewrittenWords.map(shellQuote).join(' '),
          binary: 'codex',
        };
      }
    }
    if (hasExplicitExec) {
      return { command: commandTemplate, binary: 'codex' };
    }
    return {
      command: `${commandTemplate} exec --sandbox workspace-write --skip-git-repo-check -`,
      binary: 'codex',
    };
  }

  inspectReadiness(commandTemplate: string): ToolReadinessSummary {
    const binary = commandTemplate.trim().split(/\s+/)[0] || commandTemplate;
    const resolved = resolveBinaryPath(binary);
    const binaryFound = !!resolved;

    let auth: ToolAuthReadiness;
    if (String(process.env.OPENAI_API_KEY || '').trim()) {
      auth = {
        status: 'configured',
        confidence: 'env',
        message: 'OpenAI credentials detected from OPENAI_API_KEY.',
        action_command: null,
      };
    } else {
      const storedAuthFiles = [
        homePath('.codex', 'auth.json'),
        homePath('.config', 'codex', 'auth.json'),
        homePath('.config', 'openai', 'auth.json'),
      ];
      if (storedAuthFiles.some(fileExists)) {
        auth = {
          status: 'configured',
          confidence: 'heuristic',
          message: 'Stored Codex credentials were found on this machine.',
          action_command: null,
        };
      } else {
        auth = {
          status: 'missing',
          confidence: 'heuristic',
          message: 'No obvious Codex sign-in was found. If this is a fresh machine, run the login command first.',
          action_command: 'codex auth',
        };
      }
    }

    const issues: ToolReadinessIssue[] = [];
    if (!binaryFound) {
      issues.push({
        code: 'missing_cli',
        severity: 'blocking',
        title: 'Codex CLI not found',
        detail: `Could not find "${binary}" on this system.`,
        action_label: null,
        action_command: null,
      });
    }
    if (auth.status === 'missing') {
      issues.push({
        code: 'auth_missing',
        severity: 'warning',
        title: 'Codex authentication may not be configured',
        detail: auth.message,
        action_label: 'Login',
        action_command: auth.action_command,
      });
    }

    return {
      command: commandTemplate,
      command_type: 'codex',
      tool_label: 'Codex',
      binary,
      binary_found: binaryFound,
      binary_path: resolved,
      ready: binaryFound && auth.status !== 'missing',
      issues,
      auth,
    };
  }

  buildControllerCommand(commandTemplate: string, commandProfileConfigJson?: string | Record<string, unknown> | null): string {
    return appendCodexConfigArgs(commandTemplate, commandProfileConfigJson);
  }
}
