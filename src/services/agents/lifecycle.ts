import { config } from '../../config';
import { getDatabase } from '../../db/database';
import { getAgentIssueBatch, buildAssignedIssuesPrompt, markCurrentBatchInProgress } from '../agent-issue-batch';
import { listDispatchableIssuesForAgent } from '../issue-dispatch';
import { isAgentRunning, startAgentProcess, stopAgentProcess } from '../process-manager';
import { buildSystemPrompt } from '../system-prompt';
import { broadcastToProject } from '../websocket';
import {
  AgentAlreadyPausedError,
  AgentAlreadyRunningError,
  AgentNotPausedError,
  AgentPausedError,
  AgentPromptUnavailableError,
  AgentRetryPromptMissingError,
} from './errors';
import { getAgentOrThrow, getProjectOrThrow } from './core';
import { AgentStopLogger, StartAgentServiceInput } from './types';

export function startAgent(agentId: string, input: StartAgentServiceInput = {}): { success: true; runId: string; pid: number } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  if (agent.paused) {
    throw new AgentPausedError();
  }

  if (agent.status === 'running' || isAgentRunning(agent.id)) {
    throw new AgentAlreadyRunningError();
  }

  const project = getProjectOrThrow(db, agent.project_id, 'Project not found for this agent');

  if (input.force_new_session) {
    db.prepare('UPDATE agents SET session_id = NULL WHERE id = ?').run(agent.id);
    agent.session_id = null;
  }

  let prompt = input.prompt?.trim() || '';
  if (!prompt) {
    const parts: string[] = [];
    if (agent.role) parts.push(`Role: ${agent.role}`);
    if (project.task_description) parts.push(`Task: ${project.task_description}`);

    const issues = listDispatchableIssuesForAgent(db, project.id, agent.id);
    if (issues.length > 0) {
      const issueBatch = getAgentIssueBatch(issues);
      parts.push(buildAssignedIssuesPrompt(issueBatch));
      markCurrentBatchInProgress(db, issueBatch);
    }

    prompt = parts.join('\n\n');
  }

  if (!prompt) throw new AgentPromptUnavailableError();

  const commandTemplate = agent.command_template || project.command_template || config.defaultCommandTemplate;
  const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
  const systemPrompt = isRawShell ? undefined : buildSystemPrompt(agent, project);

  const result = startAgentProcess(agent, prompt, commandTemplate, systemPrompt);
  return { success: true, runId: result.runId, pid: result.pid };
}

export function retryAgent(agentId: string): { success: true; runId: string; pid: number } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  if (agent.paused) {
    throw new AgentPausedError();
  }

  if (agent.status === 'running' || isAgentRunning(agent.id)) {
    throw new AgentAlreadyRunningError();
  }

  if (!agent.last_prompt) {
    throw new AgentRetryPromptMissingError();
  }

  const project = getProjectOrThrow(db, agent.project_id, 'Project not found for this agent');
  db.prepare('UPDATE agents SET session_id = NULL WHERE id = ?').run(agent.id);
  const freshAgent = { ...agent, session_id: null };

  const commandTemplate = agent.command_template || project.command_template || config.defaultCommandTemplate;
  const result = startAgentProcess(freshAgent, agent.last_prompt, commandTemplate);
  return { success: true, runId: result.runId, pid: result.pid };
}

export function stopAgent(agentId: string, logger?: AgentStopLogger): { success: true } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agent.id);

  const stopped = stopAgentProcess(agent.id);
  if (!stopped) {
    if (agent.pid) {
      if (agent.pid === process.pid || agent.pid === process.ppid) {
        logger?.error(`Refusing to kill PID ${agent.pid} because it is the HAICO server itself (pid=${process.pid}, ppid=${process.ppid})`);
      } else {
        logger?.warn(`Killing stale PID ${agent.pid} for agent "${agent.name}" (not in memory map)`);
        try { process.kill(agent.pid, 'SIGTERM'); } catch {}
      }
    }
    db.prepare("UPDATE agents SET pid = NULL WHERE id = ?").run(agent.id);
  }

  broadcastToProject(agent.project_id, {
    type: 'agent_status',
    projectId: agent.project_id,
    data: { agentId: agent.id, status: 'idle' },
  });

  return { success: true };
}

export function pauseAgent(agentId: string): { success: true } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  if (agent.paused) {
    throw new AgentAlreadyPausedError();
  }

  if (agent.status === 'running' || isAgentRunning(agent.id)) {
    stopAgentProcess(agent.id);
  }

  db.prepare("UPDATE agents SET paused = 1, status = 'idle' WHERE id = ?").run(agent.id);

  broadcastToProject(agent.project_id, {
    type: 'agent_status',
    projectId: agent.project_id,
    data: { agentId: agent.id, status: 'idle', paused: true },
  });

  return { success: true };
}

export function unpauseAgent(agentId: string): { success: true } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  if (!agent.paused) {
    throw new AgentNotPausedError();
  }

  db.prepare("UPDATE agents SET paused = 0, status = 'idle' WHERE id = ?").run(agent.id);

  broadcastToProject(agent.project_id, {
    type: 'agent_status',
    projectId: agent.project_id,
    data: { agentId: agent.id, status: 'idle', paused: false },
  });

  return { success: true };
}

export function getAgentStatus(agentId: string): any {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  let lastError: string | null = null;
  if (agent.status === 'error') {
    const latestRun = db.prepare(
      "SELECT run_id FROM conversation_logs WHERE agent_id = ? ORDER BY id DESC LIMIT 1"
    ).get(agent.id) as { run_id: string } | undefined;

    if (latestRun?.run_id) {
      const errLog = db.prepare(
        "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stderr' AND trim(content) != '' ORDER BY id DESC LIMIT 1"
      ).get(agent.id, latestRun.run_id) as { content: string } | undefined;
      lastError = errLog?.content || null;

      if (!lastError) {
        const finalResult = db.prepare(
          "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stdout' AND content LIKE '%--- Final Result ---%' ORDER BY id DESC LIMIT 1"
        ).get(agent.id, latestRun.run_id) as { content: string } | undefined;
        lastError = finalResult?.content?.replace(/.*--- Final Result ---\n?/, '').trim() || null;
      }

      if (!lastError) {
        const anyLog = db.prepare(
          "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream != 'cost' AND trim(content) != '' AND content NOT LIKE '--- [%] Cost:%' ORDER BY id DESC LIMIT 1"
        ).get(agent.id, latestRun.run_id) as { content: string } | undefined;
        lastError = anyLog?.content || null;
      }
    }

    if (!lastError) {
      const anyLog = db.prepare(
        "SELECT content FROM conversation_logs WHERE agent_id = ? AND trim(content) != '' ORDER BY id DESC LIMIT 1"
      ).get(agent.id) as { content: string } | undefined;
      lastError = anyLog?.content || null;
    }
  }

  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    paused: !!agent.paused,
    pid: agent.pid,
    is_running: isAgentRunning(agent.id),
    started_at: agent.started_at,
    finished_at: agent.finished_at,
    last_error: lastError,
  };
}

export function getAgentSystemPrompt(agentId: string): { prompt: string } {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);
  const project = getProjectOrThrow(db, agent.project_id);
  return { prompt: buildSystemPrompt(agent, project) };
}
