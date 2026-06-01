import { ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDatabase } from '../../db/database';
import { Agent, Project } from '../../types';
import logger from '../../logger';
import { expandHomePath } from '../file-management';
import {
  appendClaudeConfigArgs,
  appendCodexConfigArgs,
  appendGeminiConfigArgs,
  hasCommandFlag,
  isEmptyCommandProfileConfig,
  resolveCommandType,
} from '../command-profiles';
import { PROMPT_ENV_MAX_CHARS } from './policy';

const PROMPT_DIR = path.join(os.tmpdir(), 'haico-prompts');

export function resolveProcessCommandConfig(
  db: ReturnType<typeof getDatabase>,
  agent: Agent,
  commandTemplate: string
): { commandTemplate: string; commandType: ReturnType<typeof resolveCommandType> } {
  const normalizedCommandTemplate = commandTemplate.trim() || 'claude';
  let inheritedProjectCommandType: Project['command_type'] | null = null;

  if (!agent.command_type && agent.project_id) {
    const project = db.prepare('SELECT command_template, command_type FROM projects WHERE id = ?').get(agent.project_id) as
      | Pick<Project, 'command_template' | 'command_type'>
      | undefined;
    const projectCommandTemplate = String(project?.command_template || '').trim();
    const agentUsesProjectDefault = !String(agent.command_template || '').trim()
      || (!!projectCommandTemplate && projectCommandTemplate === normalizedCommandTemplate);

    if (agentUsesProjectDefault) {
      inheritedProjectCommandType = project?.command_type || null;
    }
  }

  return {
    commandTemplate: normalizedCommandTemplate,
    commandType: resolveCommandType(agent.command_type || inheritedProjectCommandType, normalizedCommandTemplate),
  };
}

export function buildAgentProcessCommand(input: {
  toolPath: string;
  resolvedCommandType: ReturnType<typeof resolveCommandType>;
  sessionId: string;
  existingSessionId: string | null;
  commandProfileConfigJson?: string | Record<string, unknown> | null;
}): { command: string; useStreamJson: boolean } {
  const lowerTool = input.toolPath.toLowerCase();
  const hasConfig = !isEmptyCommandProfileConfig(input.commandProfileConfigJson);

  if (input.resolvedCommandType === 'claude') {
    const sessionFlag = input.existingSessionId
      ? `--resume ${input.sessionId}`
      : `--session-id ${input.sessionId}`;
    if (hasConfig) {
      const baseParts = [
        input.toolPath,
        hasCommandFlag(input.toolPath, '-p') ? '' : '-p',
        hasCommandFlag(input.toolPath, '--output-format') ? '' : '--output-format stream-json',
        sessionFlag,
        hasCommandFlag(input.toolPath, '--dangerously-skip-permissions') ? '' : '--dangerously-skip-permissions',
      ].filter(Boolean);
      return {
        command: appendClaudeConfigArgs(baseParts.join(' '), input.commandProfileConfigJson),
        useStreamJson: true,
      };
    }
    return {
      command: `${input.toolPath} -p --output-format stream-json --verbose ${sessionFlag} --dangerously-skip-permissions --allowedTools "Bash Edit Read Write Glob Grep NotebookEdit WebFetch WebSearch Agent"`,
      useStreamJson: true,
    };
  }

  if (input.resolvedCommandType === 'codex') {
    const hasExplicitExec = /\bexec\b/.test(lowerTool);
    if (hasExplicitExec) {
      return {
        command: input.toolPath,
        useStreamJson: input.toolPath.includes('--json'),
      };
    }

    if (input.existingSessionId) {
      if (hasConfig) {
        const base = `${input.toolPath} exec resume --json ${input.sessionId} -`;
        return {
          command: appendCodexConfigArgs(base, input.commandProfileConfigJson),
          useStreamJson: true,
        };
      }
      return {
        command: `${input.toolPath} exec resume --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${input.sessionId} -`,
        useStreamJson: true,
      };
    }

    if (hasConfig) {
      const base = `${input.toolPath} exec --json`;
      return {
        command: appendCodexConfigArgs(base, input.commandProfileConfigJson),
        useStreamJson: true,
      };
    }

    return {
      command: `${input.toolPath} exec --json --sandbox danger-full-access --skip-git-repo-check`,
      useStreamJson: true,
    };
  }

  if (input.resolvedCommandType === 'gemini') {
    if (hasConfig) {
      const command = appendGeminiConfigArgs(input.toolPath, input.commandProfileConfigJson);
      return {
        command,
        useStreamJson: /(^|\s)--output-format(?:\s|=)stream-json(?:\s|$)/.test(command),
      };
    }
    return {
      command: `${input.toolPath} --output-format stream-json --sandbox --approval-mode yolo`,
      useStreamJson: true,
    };
  }

  return {
    command: input.toolPath,
    useStreamJson: false,
  };
}

export function writePromptFile(runId: string, prompt: string): string {
  if (!fs.existsSync(PROMPT_DIR)) fs.mkdirSync(PROMPT_DIR, { recursive: true });
  const fp = path.join(PROMPT_DIR, runId + '.txt');
  fs.writeFileSync(fp, prompt, 'utf-8');
  return fp;
}

export function cleanupPromptFile(fp: string): void {
  try {
    if (!fp || !fs.existsSync(fp)) return;
    fs.unlinkSync(fp);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      logger.error({ err: e, promptFile: fp }, 'agent.prompt_file.cleanup_failed');
    }
  }
}

function buildPromptEnvValue(prompt: string): { value: string; truncated: boolean } {
  if (prompt.length <= PROMPT_ENV_MAX_CHARS) {
    return { value: prompt, truncated: false };
  }

  const notice = '\n...[truncated; read HAICO_PROMPT_FILE for full prompt]...\n';
  const remaining = Math.max(0, PROMPT_ENV_MAX_CHARS - notice.length);
  const headLength = Math.ceil(remaining / 2);
  const tailLength = Math.floor(remaining / 2);

  return {
    value: prompt.slice(0, headLength) + notice + prompt.slice(Math.max(0, prompt.length - tailLength)),
    truncated: true,
  };
}

export function resolveAgentCwd(agent: Agent): string {
  let cwd = agent.working_directory || process.cwd();
  if (cwd.startsWith('~/')) cwd = expandHomePath(cwd);

  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      logger.warn({
        projectId: agent.project_id,
        agentId: agent.id,
        cwd,
        fallbackCwd: process.cwd(),
        reason: 'missing',
      }, 'agent.working_directory_fallback');
      return process.cwd();
    }
  } catch {
    logger.warn({
      projectId: agent.project_id,
      agentId: agent.id,
      cwd,
      fallbackCwd: process.cwd(),
      reason: 'invalid',
    }, 'agent.working_directory_fallback');
    return process.cwd();
  }

  return cwd;
}

export function buildShellInvocation(command: string): { shellPath: string; shellArgs: string[] } {
  const shellPath = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const shellArgs = shellPath.endsWith('bash')
    ? ['-lc', 'exec ' + command]
    : ['-c', 'exec ' + command];

  return { shellPath, shellArgs };
}

export function buildChildEnv(input: {
  agent: Agent;
  runId: string;
  sessionId: string;
  fullPrompt: string;
  promptFile: string;
}): NodeJS.ProcessEnv {
  const promptEnv = buildPromptEnvValue(input.fullPrompt);
  const childEnv = {
    ...process.env,
    no_proxy: [process.env.no_proxy, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
    NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
    HAICO_PROMPT: promptEnv.value,
    HAICO_PROMPT_FILE: input.promptFile,
    HAICO_PROMPT_TRUNCATED: promptEnv.truncated ? '1' : '0',
    HAICO_SESSION_ID: input.sessionId,
    HAICO_AGENT_ID: input.agent.id,
    HAICO_RUN_ID: input.runId,
  } as NodeJS.ProcessEnv;

  if (promptEnv.truncated) {
    logger.warn({
      projectId: input.agent.project_id,
      agentId: input.agent.id,
      runId: input.runId,
      promptEnvMaxChars: PROMPT_ENV_MAX_CHARS,
      promptFile: input.promptFile,
    }, 'agent.prompt_env_truncated');
  }

  // nvm aborts shell init when npm_config_prefix is preset, preventing Node CLIs from restoring PATH.
  delete childEnv.npm_config_prefix;
  delete childEnv.NPM_CONFIG_PREFIX;

  return childEnv;
}

export function detachChildProcessIo(child: ChildProcess | undefined): void {
  if (!child) return;

  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream) continue;
    try {
      if (typeof (stream as any).unref === 'function') {
        (stream as any).unref();
      }
    } catch {}
    try {
      if (!(stream as any).destroyed && typeof stream.destroy === 'function') {
        stream.destroy();
      }
    } catch {}
  }

  try {
    child.unref();
  } catch {}
}
