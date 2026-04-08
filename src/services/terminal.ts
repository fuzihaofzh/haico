
import path from 'path';
import os from 'os';
import { getDatabase } from '../db/database';
import { Agent, Project } from '../types';
import { config } from '../config';
import { resolveCommandType } from './command-profiles';
import logger from '../logger';

let pty: typeof import('node-pty') | null = null;
try { pty = require('node-pty'); } catch { logger.warn('node-pty not available'); }

export interface PtySession {
  pty: import('node-pty').IPty;
  agentId: string;
  createdAt: number;
  outputBuffer: string;
}

// Map of agentId -> active PTY session
const ptySessions = new Map<string, PtySession>();
const PTY_OUTPUT_BUFFER_MAX = 200000;

function splitCommandTemplate(template: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escape = false;

  for (const ch of template) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (escape) current += '\\';
  if (current) tokens.push(current);
  return tokens;
}

function needsShellExecution(template: string): boolean {
  return /[|&;<>()`$]/.test(template);
}

/**
 * Get or create a PTY session for an agent.
 * If `newSession` is true, kill any existing session first.
 */
export function getOrCreatePtySession(
  agentId: string,
  newSession: boolean,
  cols: number = 120,
  rows: number = 30
): PtySession {
  if (!pty) {
    throw new Error('Interactive terminal not available (node-pty not installed)');
  }

  if (!newSession && ptySessions.has(agentId)) {
    return ptySessions.get(agentId)!;
  }

  // Kill existing session if any
  killPtySession(agentId);

  // Get agent info for working directory
  const db = getDatabase();
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Agent | undefined;

  let cwd = agent?.working_directory || process.cwd();
  if (cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(2));

  // Get command template: agent-level > project-level > default
  let commandTemplate = 'claude';
  let commandType: Agent['command_type'] | Project['command_type'] | null = agent?.command_type || null;
  if (agent) {
    if (agent.command_template) {
      commandTemplate = agent.command_template.trim() || 'claude';
    } else {
      const project = db.prepare('SELECT command_template, command_type FROM projects WHERE id = ?').get(agent.project_id) as
        | Pick<Project, 'command_template' | 'command_type'>
        | undefined;
      if (project?.command_template) {
        commandTemplate = project.command_template.trim() || 'claude';
        commandType = commandType || project.command_type || null;
      } else {
        commandTemplate = config.defaultCommandTemplate || 'claude';
      }
    }
  }

  const parsed = splitCommandTemplate(commandTemplate);
  const baseCommand = parsed[0] || 'claude';
  const baseArgs = parsed.slice(1);

  // Prefer explicit command_type when deciding terminal session behavior.
  const sessionId = agent?.session_id || undefined;
  const resolvedCommandType = resolveCommandType(commandType, commandTemplate);
  const isClaudeFamily = resolvedCommandType === 'claude';
  const sessionArgs: string[] = [];
  if (isClaudeFamily) {
    sessionArgs.push('--dangerously-skip-permissions');
    if (sessionId) {
      sessionArgs.push('--resume', sessionId);
    }
  }

  const ptyOptions = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      no_proxy: [process.env.no_proxy, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
      NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
    } as Record<string, string>,
  };

  const finalArgs = [...baseArgs, ...sessionArgs];
  let ptyProcess: import('node-pty').IPty;

  if (needsShellExecution(commandTemplate)) {
    const escapeArg = (arg: string): string => "'" + arg.replace(/'/g, "'\\''") + "'";
    const shellCommand = [commandTemplate, ...sessionArgs.map(escapeArg)].join(' ');
    logger.info(`Spawning PTY for agent ${agentId} via shell: ${shellCommand} in ${cwd}`);
    ptyProcess = pty.spawn('/bin/sh', ['-lc', shellCommand], ptyOptions);
  } else {
    logger.info(`Spawning PTY for agent ${agentId}: ${baseCommand} ${finalArgs.join(' ')} in ${cwd}`);
    ptyProcess = pty.spawn(baseCommand, finalArgs, ptyOptions);
  }

  const session: PtySession = {
    pty: ptyProcess,
    agentId,
    createdAt: Date.now(),
    outputBuffer: '',
  };

  // Keep a rolling output buffer so clients that reconnect (or attach late)
  // can still render the latest terminal content.
  ptyProcess.onData((data: string) => {
    session.outputBuffer += data;
    if (session.outputBuffer.length > PTY_OUTPUT_BUFFER_MAX) {
      session.outputBuffer = session.outputBuffer.slice(-PTY_OUTPUT_BUFFER_MAX);
    }
  });

  ptySessions.set(agentId, session);

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    logger.info(`PTY for agent ${agentId} exited with code ${exitCode}`);
    ptySessions.delete(agentId);
  });

  return session;
}

export function hasPtySession(agentId: string): boolean {
  return ptySessions.has(agentId);
}

export function killPtySession(agentId: string): boolean {
  const session = ptySessions.get(agentId);
  if (!session) return false;

  try {
    session.pty.kill();
  } catch (e) {
    logger.error(e, `Failed to kill PTY for agent ${agentId}`);
  }
  ptySessions.delete(agentId);
  return true;
}

export function killAllPtySessions(): void {
  for (const [agentId] of ptySessions) {
    killPtySession(agentId);
  }
}

export function getPtyOutputBuffer(agentId: string): string {
  return ptySessions.get(agentId)?.outputBuffer || '';
}

export function getPtySession(agentId: string): PtySession | undefined {
  return ptySessions.get(agentId);
}
