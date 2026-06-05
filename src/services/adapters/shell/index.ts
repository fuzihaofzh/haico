/**
 * ShellAdapter — fallback adapter for generic shell commands.
 *
 * No stream-json parsing, no session management, no completion signal.
 * Used when command type cannot be identified as claude/codex/gemini.
 */

import type { Agent, Project } from '../../../types';
import type { ToolReadinessSummary } from '../../tool-readiness';

import { BaseCliAdapter } from '../base-cli-adapter';
import type { CliOutputState } from '../base-cli-adapter';
import type { AdapterEventSink } from '../types';
import { resolveBinaryPath } from '../../tool-readiness';

export class ShellAdapter extends BaseCliAdapter {
  readonly type = 'shell';
  readonly requiresCompletionSignal = false;

  protected buildCommand(input: {
    commandTemplate: string;
    sessionId: string;
    existingSessionId: string | null;
    commandProfileConfigJson: string;
  }): { command: string; useStreamJson: boolean } {
    return {
      command: input.commandTemplate,
      useStreamJson: false,
    };
  }

  protected parseOutputLine(
    _line: string,
    _state: CliOutputState,
    _input: {
      agent: Agent;
      runId: string;
      sink: AdapterEventSink;
      logAndBroadcast: (content: string, stream: 'stdout' | 'stderr') => void;
      db: any;
      logStmt: any;
      updateSessionId: (sessionId: string) => void;
    },
  ): void {
    // Shell adapter never uses stream-json; raw output is handled by base class.
    // This method should never be called since useStreamJson is always false.
  }

  buildSystemPromptSection(_agent: Agent, _project: Project): string {
    return '';
  }

  inspectReadiness(commandTemplate: string): ToolReadinessSummary {
    const binary = commandTemplate.trim().split(/\s+/)[0] || commandTemplate;
    const resolved = resolveBinaryPath(binary);
    const binaryFound = !!resolved;
    return {
      command: commandTemplate,
      command_type: null,
      tool_label: 'Shell',
      binary,
      binary_found: binaryFound,
      binary_path: resolved,
      ready: binaryFound,
      issues: binaryFound ? [] : [{
        code: 'missing_cli',
        severity: 'blocking',
        title: `Command "${binary}" not found`,
        detail: `Could not find "${binary}" on this system.`,
        action_label: null,
        action_command: null,
      }],
      auth: { status: 'unknown', confidence: 'unknown', message: '', action_command: null },
    };
  }
}
