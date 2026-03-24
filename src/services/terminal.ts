import * as pty from 'node-pty';
import path from 'path';
import os from 'os';
import { getDatabase } from '../db/database';
import { Agent } from '../types';
import { config } from '../config';
import logger from '../logger';

export interface PtySession {
  pty: pty.IPty;
  agentId: string;
  createdAt: number;
}

// Map of agentId -> active PTY session
const ptySessions = new Map<string, PtySession>();

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
  let command = 'claude';
  if (agent) {
    if (agent.command_template) {
      command = agent.command_template.trim() || 'claude';
    } else {
      const project = db.prepare('SELECT command_template FROM projects WHERE id = ?').get(agent.project_id) as { command_template: string } | undefined;
      if (project?.command_template) {
        command = project.command_template.trim() || 'claude';
      } else {
        command = config.defaultCommandTemplate || 'claude';
      }
    }
  }

  // Build session args - interactive mode (no -p flag, no stream-json)
  const sessionId = agent?.session_id || undefined;
  const sessionArgs: string[] = [];
  if (sessionId) {
    sessionArgs.push('--resume', sessionId);
  }

  logger.info(`Spawning PTY for agent ${agentId}: ${command} ${sessionArgs.join(' ')} in ${cwd}`);

  const ptyProcess = pty.spawn(command, sessionArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      no_proxy: [process.env.no_proxy, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
      NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(','),
    } as Record<string, string>,
  });

  const session: PtySession = {
    pty: ptyProcess,
    agentId,
    createdAt: Date.now(),
  };

  ptySessions.set(agentId, session);

  ptyProcess.onExit(({ exitCode }) => {
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

export function getPtySession(agentId: string): PtySession | undefined {
  return ptySessions.get(agentId);
}
