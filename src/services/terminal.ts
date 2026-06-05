
import { getDatabase } from '../db/database';
import { Agent, Project } from '../types';
import { config } from '../config';
import { getAdapterRegistry } from './adapters';
import { expandHomePath } from './file-management';
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
  if (cwd.startsWith('~/')) cwd = expandHomePath(cwd);

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

  // Task runtime stores CLI continuity in executor_sessions, not legacy agents.session_id.
  const sessionRow = agent
    ? db.prepare(
        'SELECT session_id FROM executor_sessions WHERE agent_id = ? ORDER BY last_used_at DESC LIMIT 1'
      ).get(agent.id) as { session_id: string } | undefined
    : undefined;
  const sessionId = sessionRow?.session_id || undefined;

  const adapter = getAdapterRegistry().resolveFromCommand(commandTemplate, commandType);
  const ptyArgs = adapter.buildPtyArgs(commandTemplate, sessionId);

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

  let ptyProcess: import('node-pty').IPty;

  if (ptyArgs.useShell) {
    const shellCommand = [ptyArgs.command, ...ptyArgs.args].join(' ');
    logger.info(`Spawning PTY for agent ${agentId} via shell: ${shellCommand} in ${cwd}`);
    ptyProcess = pty.spawn('/bin/sh', ['-lc', shellCommand], ptyOptions);
  } else {
    logger.info(`Spawning PTY for agent ${agentId}: ${ptyArgs.command} ${ptyArgs.args.join(' ')} in ${cwd}`);
    ptyProcess = pty.spawn(ptyArgs.command, ptyArgs.args, ptyOptions);
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
