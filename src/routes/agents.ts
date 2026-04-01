import { FastifyInstance, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TextDecoder } from 'util';
import { getDatabase } from '../db/database';
import { Agent, Project, CreateAgentInput, StartAgentInput } from '../types';
import { startAgentProcess, stopAgentProcess, isAgentRunning } from '../services/process-manager';
import { getAgentIssueBatch, buildAssignedIssuesPrompt, markCurrentBatchInProgress } from '../services/agent-issue-batch';
import { buildSystemPrompt } from '../services/system-prompt';
import { config } from '../config';
import { broadcastToProject } from '../services/websocket';
import { ensureAgentAccess, ensureProjectAccess } from '../services/project-permissions';
import { validateParentAgentAssignment } from '../services/agent-hierarchy';

const TOOL_CALL_REPORT_CHAR_LIMIT = 4000;
const MAX_AGENT_FILE_SIZE = 1024 * 1024;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function expandWorkingDirectory(dir: string): string {
  if (dir.startsWith('~/')) {
    return path.join(os.homedir(), dir.slice(2));
  }
  return dir;
}

function resolveAgentFilesystemPath(agent: Agent, requestedPath?: string): { rootDir: string; targetPath: string; relativePath: string } {
  if (!agent.working_directory) {
    throw new Error('WORKDIR_REQUIRED');
  }

  const rootDir = path.resolve(expandWorkingDirectory(agent.working_directory));
  const candidate = path.resolve(rootDir, requestedPath || '.');
  const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (candidate !== rootDir && !candidate.startsWith(rootPrefix)) {
    throw new Error('PATH_OUTSIDE_WORKDIR');
  }

  return {
    rootDir,
    targetPath: candidate,
    relativePath: candidate === rootDir ? '' : path.relative(rootDir, candidate).split(path.sep).join('/'),
  };
}

function sendAgentFilePathError(reply: FastifyReply, error: unknown) {
  if (error instanceof Error && error.message === 'WORKDIR_REQUIRED') {
    return reply.code(400).send({ error: 'Agent does not have a working_directory configured' });
  }
  if (error instanceof Error && error.message === 'PATH_OUTSIDE_WORKDIR') {
    return reply.code(400).send({ error: 'Path is outside the working_directory' });
  }
  return reply.code(500).send({ error: 'Failed to resolve path' });
}

function sendAgentFileSystemError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof Error)) {
    return reply.code(500).send({ error: 'File operation failed' });
  }

  const fsError = error as NodeJS.ErrnoException;
  if (fsError.code === 'ENOENT') {
    return reply.code(404).send({ error: 'File not found' });
  }
  if (fsError.code === 'EACCES' || fsError.code === 'EPERM') {
    return reply.code(403).send({ error: 'File access denied' });
  }
  if (fsError.code === 'EISDIR') {
    return reply.code(400).send({ error: 'Target is not a file' });
  }
  return reply.code(500).send({ error: 'File operation failed' });
}

function decodeTextFile(buffer: Buffer): string | null {
  if (!buffer.length) {
    return '';
  }

  if (buffer.includes(0)) {
    return null;
  }

  const sampleSize = Math.min(buffer.length, 1024);
  let controlCharCount = 0;
  for (let i = 0; i < sampleSize; i += 1) {
    const byte = buffer[i];
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      controlCharCount += 1;
    }
  }

  if (controlCharCount / sampleSize > 0.2) {
    return null;
  }

  try {
    return utf8Decoder.decode(buffer);
  } catch {
    return null;
  }
}

export function registerAgentRoutes(fastify: FastifyInstance): void {
  // List agents for a project
  fastify.get<{ Params: { pid: string } }>('/api/projects/:pid/agents', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;
    return db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY is_controller DESC, created_at').all(request.params.pid);
  });

  // Create agent
  fastify.post<{ Params: { pid: string }; Body: CreateAgentInput }>('/api/projects/:pid/agents', async (request, reply) => {
    const { name, role, is_controller, session_id, working_directory, command_template, parent_agent_id } = request.body as any;
    if (!name) return reply.code(400).send({ error: 'name is required' });

    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid, true);
    if (!access) return;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.pid);
    if (!project) return reply.code(404).send({ error: 'Project not found' });

    const parentValidation = validateParentAgentAssignment(db, request.params.pid, parent_agent_id);
    if (parentValidation.error) {
      return reply.code(400).send({ error: parentValidation.error });
    }

    const id = uuidv4();
    // For controller agents, default to Sonnet model if no --model flag specified
    let finalCommandTemplate = command_template || null;
    if (is_controller && finalCommandTemplate && !finalCommandTemplate.includes('--model')) {
      finalCommandTemplate = finalCommandTemplate + ' --model claude-sonnet-4-6';
    } else if (is_controller && !finalCommandTemplate) {
      finalCommandTemplate = 'cld --model claude-sonnet-4-6';
    }
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, is_controller, parent_agent_id, session_id, working_directory, command_template, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle')
    `).run(
      id,
      request.params.pid,
      name,
      role || '',
      is_controller ? 1 : 0,
      parentValidation.parentAgent?.id || null,
      session_id || null,
      working_directory || null,
      finalCommandTemplate
    );

    return reply.code(201).send(db.prepare('SELECT * FROM agents WHERE id = ?').get(id));
  });

  // Get agent
  fastify.get<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return agent;
  });

  // Update agent
  fastify.put<{ Params: { id: string }; Body: Partial<CreateAgentInput> }>('/api/agents/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!existing) return reply.code(404).send({ error: 'Agent not found' });

    const {
      name,
      role,
      session_id,
      working_directory,
      custom_instructions,
      session_max_runs,
      session_max_tokens,
      session_resume_timeout,
      command_template,
      parent_agent_id,
      paused,
    } = request.body as any;

    let validatedParentId: string | null | undefined;
    if (parent_agent_id !== undefined) {
      const parentValidation = validateParentAgentAssignment(db, existing.project_id, parent_agent_id, existing.id);
      if (parentValidation.error) {
        return reply.code(400).send({ error: parentValidation.error });
      }
      validatedParentId = parentValidation.parentAgent?.id || null;
    }

    // Build update fields dynamically — command_template and custom_instructions
    // need special handling: COALESCE(NULL, col) preserves the old value, but we
    // want to allow explicitly setting them to NULL when the field is in the request
    const fields: string[] = [
      'name = COALESCE(?, name)',
      'role = COALESCE(?, role)',
      'session_id = COALESCE(?, session_id)',
      'working_directory = COALESCE(?, working_directory)',
      'session_max_runs = COALESCE(?, session_max_runs)',
      'session_max_tokens = COALESCE(?, session_max_tokens)',
      'session_resume_timeout = COALESCE(?, session_resume_timeout)',
    ];
    const params: any[] = [
      name ?? null, role ?? null, session_id ?? null, working_directory ?? null,
      session_max_runs !== undefined ? Math.max(1, Number.isNaN(parseInt(session_max_runs)) ? 10 : parseInt(session_max_runs)) : null,
      session_max_tokens !== undefined ? Math.max(0, Number.isNaN(parseInt(session_max_tokens)) ? 0 : parseInt(session_max_tokens)) : null,
      session_resume_timeout !== undefined ? Math.max(0, Number.isNaN(parseInt(session_resume_timeout)) ? 300 : parseInt(session_resume_timeout)) : null,
    ];

    if (command_template !== undefined) {
      fields.push('command_template = ?');
      params.push(command_template || null);
    }

    if (custom_instructions !== undefined) {
      fields.push('custom_instructions = ?');
      params.push(custom_instructions || null);
    }

    if (validatedParentId !== undefined) {
      fields.push('parent_agent_id = ?');
      params.push(validatedParentId);
    }

    if (paused !== undefined) {
      fields.push('paused = ?');
      params.push(paused ? 1 : 0);
    }

    params.push(request.params.id);
    db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    return db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id);
  });

  // Delete agent
  fastify.delete<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (isAgentRunning(agent.id)) {
      stopAgentProcess(agent.id);
    }

    // Clear assigned_to on issues referencing this agent
    db.prepare('UPDATE issues SET assigned_to = NULL WHERE assigned_to = ?').run(request.params.id);

    db.prepare('DELETE FROM agents WHERE id = ?').run(request.params.id);
    return { success: true };
  });

  // Start agent
  fastify.post<{ Params: { id: string }; Body: { prompt?: string; force_new_session?: boolean } }>('/api/agents/:id/start', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (agent.paused) {
      return reply.code(409).send({ error: 'Agent is paused. Unpause it first.' });
    }

    if (agent.status === 'running' || isAgentRunning(agent.id)) {
      return reply.code(409).send({ error: 'Agent is already running' });
    }

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(agent.project_id) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found for this agent' });

    // If force_new_session is requested, clear session_id to start fresh
    if (request.body?.force_new_session) {
      db.prepare('UPDATE agents SET session_id = NULL WHERE id = ?').run(agent.id);
      agent.session_id = null;
    }

    // Build prompt: user-provided > auto-generated from role + task
    let prompt = request.body?.prompt?.trim() || '';
    if (!prompt) {
      const parts: string[] = [];
      if (agent.role) parts.push(`Role: ${agent.role}`);
      if (project.task_description) parts.push(`Task: ${project.task_description}`);

      // Include open issues assigned to this agent
      const issues = db.prepare(
        "SELECT * FROM issues WHERE project_id = ? AND assigned_to = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, created_at"
      ).all(project.id, agent.id) as any[];
      if (issues.length > 0) {
        const issueBatch = getAgentIssueBatch(issues);
        parts.push(buildAssignedIssuesPrompt(issueBatch));
        markCurrentBatchInProgress(db, issueBatch);
      }

      prompt = parts.join('\n\n');
    }

    if (!prompt) return reply.code(400).send({ error: 'No prompt could be generated. Set agent role or project task_description.' });

    const commandTemplate = agent.command_template || project.command_template || config.defaultCommandTemplate;

    // Inject system prompt by default; skip for raw shell commands (bash -c / sh -c)
    const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
    const systemPrompt = isRawShell ? undefined : buildSystemPrompt(agent, project);

    const result = startAgentProcess(agent, prompt, commandTemplate, systemPrompt);
    return { success: true, runId: result.runId, pid: result.pid };
  });

  // Retry agent (re-run with the same last_prompt)
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/retry', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (agent.paused) {
      return reply.code(409).send({ error: 'Agent is paused. Unpause it first.' });
    }

    if (agent.status === 'running' || isAgentRunning(agent.id)) {
      return reply.code(409).send({ error: 'Agent is already running' });
    }

    if (!agent.last_prompt) {
      return reply.code(400).send({ error: 'No previous prompt to retry. Use start instead.' });
    }

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(agent.project_id) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found for this agent' });

    // Reset session_id to ensure fresh session on retry
    db.prepare('UPDATE agents SET session_id = NULL WHERE id = ?').run(agent.id);
    const freshAgent = { ...agent, session_id: null };

    const commandTemplate = agent.command_template || project.command_template || config.defaultCommandTemplate;
    const result = startAgentProcess(freshAgent, agent.last_prompt, commandTemplate);
    return { success: true, runId: result.runId, pid: result.pid };
  });

  // Stop agent
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/stop', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    // Set status to 'stopped' before killing so close handler preserves it
    db.prepare("UPDATE agents SET status = 'stopped' WHERE id = ?").run(agent.id);

    const stopped = stopAgentProcess(agent.id);
    if (!stopped) {
      // Process not in memory map — try killing PID directly if it exists
      if (agent.pid) {
        // Guard: never kill our own process or parent (PID reuse after restart)
        if (agent.pid === process.pid || agent.pid === process.ppid) {
          fastify.log.error(`Refusing to kill PID ${agent.pid} — it is the Agentopia server itself (pid=${process.pid}, ppid=${process.ppid})`);
        } else {
          fastify.log.warn(`Killing stale PID ${agent.pid} for agent "${agent.name}" (not in memory map)`);
          try { process.kill(agent.pid, 'SIGTERM'); } catch {}
        }
      }
      db.prepare("UPDATE agents SET pid = NULL WHERE id = ?").run(agent.id);
    }

    // Broadcast stopped status immediately for UI feedback
    broadcastToProject(agent.project_id, {
      type: 'agent_status', projectId: agent.project_id,
      data: { agentId: agent.id, status: 'stopped' },
    });

    return { success: true };
  });

  // Pause agent — prevents auto-start and manual start until unpaused
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/pause', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (agent.paused) {
      return reply.code(409).send({ error: 'Agent is already paused' });
    }

    // If running, stop it first
    if (agent.status === 'running' || isAgentRunning(agent.id)) {
      stopAgentProcess(agent.id);
    }

    db.prepare("UPDATE agents SET paused = 1, status = 'stopped' WHERE id = ?").run(agent.id);

    broadcastToProject(agent.project_id, {
      type: 'agent_status', projectId: agent.project_id,
      data: { agentId: agent.id, status: 'stopped', paused: true },
    });

    return { success: true };
  });

  // Unpause agent — allows it to be started again
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/unpause', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (!agent.paused) {
      return reply.code(409).send({ error: 'Agent is not paused' });
    }

    db.prepare("UPDATE agents SET paused = 0, status = 'idle' WHERE id = ?").run(agent.id);

    broadcastToProject(agent.project_id, {
      type: 'agent_status', projectId: agent.project_id,
      data: { agentId: agent.id, status: 'idle', paused: false },
    });

    return { success: true };
  });

  // Get agent status
  fastify.get<{ Params: { id: string } }>('/api/agents/:id/status', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    // If error, prefer logs from the latest run so stale stderr from an older
    // failure does not mask the actual reason the current run exited.
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
  });

  // Preview system prompt for an agent
  fastify.get<{ Params: { id: string } }>('/api/agents/:id/system-prompt', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(agent.project_id) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return { prompt: buildSystemPrompt(agent, project) };
  });

  fastify.get<{ Params: { id: string }; Querystring: { path?: string; showHidden?: string } }>('/api/agents/:id/files', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    let resolvedPath;
    try {
      resolvedPath = resolveAgentFilesystemPath(agent, request.query.path);
    } catch (error) {
      return sendAgentFilePathError(reply, error);
    }

    const showHidden = request.query.showHidden === '1' || request.query.showHidden === 'true';

    try {
      const targetStat = await fs.stat(resolvedPath.targetPath);
      if (!targetStat.isDirectory()) {
        return reply.code(400).send({ error: 'Target path is not a directory' });
      }

      const dirents = await fs.readdir(resolvedPath.targetPath, { withFileTypes: true });
      const visibleEntries = dirents.filter((entry) => showHidden || !entry.name.startsWith('.'));
      const entries = (await Promise.all(visibleEntries.map(async (entry) => {
        const entryPath = path.join(resolvedPath.targetPath, entry.name);
        try {
          const entryStat = await fs.stat(entryPath);
          const relativeEntryPath = resolvedPath.relativePath
            ? path.posix.join(resolvedPath.relativePath, entry.name)
            : entry.name;
          return {
            name: entry.name,
            path: relativeEntryPath,
            type: entry.isDirectory() ? 'dir' : 'file',
            size: entryStat.size,
            modified: entryStat.mtime.toISOString(),
          };
        } catch {
          return null;
        }
      }))).filter(Boolean) as Array<{ name: string; path: string; type: 'file' | 'dir'; size: number; modified: string }>;

      entries.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'dir' ? -1 : 1;
        }
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });

      return {
        path: resolvedPath.relativePath,
        showHidden,
        entries,
      };
    } catch (error) {
      return sendAgentFileSystemError(reply, error);
    }
  });

  fastify.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/agents/:id/files/content', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    if (!request.query.path) return reply.code(400).send({ error: 'path is required' });

    let resolvedPath;
    try {
      resolvedPath = resolveAgentFilesystemPath(agent, request.query.path);
    } catch (error) {
      return sendAgentFilePathError(reply, error);
    }

    try {
      const targetStat = await fs.stat(resolvedPath.targetPath);
      if (!targetStat.isFile()) {
        return reply.code(400).send({ error: 'Target path is not a file' });
      }
      if (targetStat.size > MAX_AGENT_FILE_SIZE) {
        return reply.code(413).send({ error: 'File exceeds the 1 MB limit' });
      }

      const buffer = await fs.readFile(resolvedPath.targetPath);
      if (buffer.length > MAX_AGENT_FILE_SIZE) {
        return reply.code(413).send({ error: 'File exceeds the 1 MB limit' });
      }

      const content = decodeTextFile(buffer);
      if (content === null) {
        return reply.code(415).send({ error: 'Cannot preview binary files' });
      }

      return reply.type('text/plain; charset=utf-8').send(content);
    } catch (error) {
      return sendAgentFileSystemError(reply, error);
    }
  });

  // Serve files directly with correct Content-Type (for PDF/HTML preview in iframe)
  const MAX_SERVE_FILE_SIZE = 10 * 1024 * 1024; // 10 MB for binary previews
  const SERVE_CONTENT_TYPES: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
  };

  fastify.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/agents/:id/files/serve', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    if (!request.query.path) return reply.code(400).send({ error: 'path is required' });

    let resolvedPath;
    try {
      resolvedPath = resolveAgentFilesystemPath(agent, request.query.path);
    } catch (error) {
      return sendAgentFilePathError(reply, error);
    }

    try {
      const targetStat = await fs.stat(resolvedPath.targetPath);
      if (!targetStat.isFile()) {
        return reply.code(400).send({ error: 'Target path is not a file' });
      }
      if (targetStat.size > MAX_SERVE_FILE_SIZE) {
        return reply.code(413).send({ error: 'File exceeds the 10 MB limit' });
      }

      const ext = path.extname(resolvedPath.targetPath).toLowerCase();
      const contentType = SERVE_CONTENT_TYPES[ext];
      if (!contentType) {
        return reply.code(415).send({ error: 'Only PDF and HTML files can be served for preview' });
      }

      const buffer = await fs.readFile(resolvedPath.targetPath);

      // For HTML files, add CSP to prevent script execution
      if (ext === '.html' || ext === '.htm') {
        reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:");
      }

      return reply.type(contentType).send(buffer);
    } catch (error) {
      return sendAgentFileSystemError(reply, error);
    }
  });

  fastify.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>('/api/agents/:id/files/content', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const filePath = typeof request.body?.path === 'string' ? request.body.path.trim() : '';
    if (!filePath) {
      return reply.code(400).send({ error: 'path is required' });
    }

    if (typeof request.body?.content !== 'string') {
      return reply.code(400).send({ error: 'content must be a string' });
    }

    if (Buffer.byteLength(request.body.content, 'utf-8') > MAX_AGENT_FILE_SIZE) {
      return reply.code(413).send({ error: 'File exceeds the 1 MB limit' });
    }

    let resolvedPath;
    try {
      resolvedPath = resolveAgentFilesystemPath(agent, filePath);
    } catch (error) {
      return sendAgentFilePathError(reply, error);
    }

    try {
      const existing = await fs.stat(resolvedPath.targetPath).catch((statError: NodeJS.ErrnoException) => {
        if (statError.code === 'ENOENT') {
          return null;
        }
        throw statError;
      });
      if (existing && !existing.isFile()) {
        return reply.code(400).send({ error: 'Target path is not a file' });
      }

      await fs.writeFile(resolvedPath.targetPath, request.body.content, 'utf-8');
      const savedStat = await fs.stat(resolvedPath.targetPath);
      return {
        success: true,
        path: resolvedPath.relativePath,
        size: savedStat.size,
        modified: savedStat.mtime.toISOString(),
      };
    } catch (error) {
      return sendAgentFileSystemError(reply, error);
    }
  });

  // File upload (multipart/form-data)
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/files/upload', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const parts = request.parts();
    let targetDir = '';
    const uploaded: Array<{ success: true; path: string; name: string; size: number }> = [];

    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'path') {
        targetDir = String(part.value || '');
      } else if (part.type === 'file' && part.fieldname === 'file') {
        const fileName = part.filename;
        if (!fileName) {
          await part.toBuffer(); // consume the stream
          continue;
        }

        let resolvedPath;
        try {
          const filePath = targetDir ? path.posix.join(targetDir, fileName) : fileName;
          resolvedPath = resolveAgentFilesystemPath(agent, filePath);
        } catch (error) {
          await part.toBuffer(); // consume the stream
          return sendAgentFilePathError(reply, error);
        }

        try {
          // Ensure parent directory exists
          await fs.mkdir(path.dirname(resolvedPath.targetPath), { recursive: true });
          const buffer = await part.toBuffer();
          await fs.writeFile(resolvedPath.targetPath, buffer);
          const savedStat = await fs.stat(resolvedPath.targetPath);
          uploaded.push({
            success: true,
            path: resolvedPath.relativePath,
            name: fileName,
            size: savedStat.size,
          });
        } catch (error) {
          return sendAgentFileSystemError(reply, error);
        }
      }
    }

    if (uploaded.length === 0) {
      return reply.code(400).send({ error: 'No files uploaded' });
    }
    if (uploaded.length === 1) {
      return uploaded[0];
    }
    return { success: true, files: uploaded };
  });

  // File download
  const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
    '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
    '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/csv',
    '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.woff': 'font/woff', '.woff2': 'font/woff2',
  };

  fastify.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/agents/:id/files/download', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    if (!request.query.path) return reply.code(400).send({ error: 'path is required' });

    let resolvedPath;
    try {
      resolvedPath = resolveAgentFilesystemPath(agent, request.query.path);
    } catch (error) {
      return sendAgentFilePathError(reply, error);
    }

    try {
      const targetStat = await fs.stat(resolvedPath.targetPath);
      if (!targetStat.isFile()) {
        return reply.code(400).send({ error: 'Target path is not a file' });
      }

      const ext = path.extname(resolvedPath.targetPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const fileName = path.basename(resolvedPath.targetPath);

      const buffer = await fs.readFile(resolvedPath.targetPath);
      return reply
        .header('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`)
        .type(contentType)
        .send(buffer);
    } catch (error) {
      return sendAgentFileSystemError(reply, error);
    }
  });

  // Plain text terminal output (for debugging / curl)
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/agents/:id/terminal', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send('Agent not found');
    const limit = parseInt(request.query.limit || '200', 10);
    const logs = db.prepare(
      'SELECT * FROM conversation_logs WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
    ).all(request.params.id, limit) as any[];
    logs.reverse();

    let text = `=== ${agent.name} [${agent.status}] ===\n\n`;
    for (const l of logs) {
      if (l.stream === 'stdin') {
        text += `--- Input Prompt (${l.content.length} chars) ---\n`;
        text += l.content.replace(/\n/g, ' ').slice(0, 100) + '...\n';
        text += '--- Output ---\n';
      } else if (l.stream === 'stderr') {
        text += `[ERR] ${l.content}`;
      } else {
        text += l.content;
      }
    }
    return reply.type('text/plain').send(text);
  });

  // Get agent logs
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/agents/:id/logs', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const limit = parseInt(request.query.limit || '100', 10);
    return db.prepare(
      'SELECT * FROM conversation_logs WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
    ).all(request.params.id, limit);
  });

  // Get agent cost summary
  fastify.get<{ Params: { id: string } }>('/api/agents/:id/costs', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    // Cost records are cumulative per run — only take the last record per run_id
    const costs = db.prepare(
      `SELECT c.content, c.run_id, c.created_at FROM conversation_logs c
       INNER JOIN (SELECT MAX(id) as max_id FROM conversation_logs WHERE agent_id = ? AND stream = 'cost' GROUP BY run_id) latest
       ON c.id = latest.max_id ORDER BY c.created_at`
    ).all(request.params.id) as any[];

    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    const runs: Array<{ run_id: string; cost_usd: number; input_tokens: number; output_tokens: number; timestamp: string }> = [];

    for (const c of costs) {
      try {
        const data = JSON.parse(c.content);
        const costUsd = data.cost_usd || 0;
        const inputTokens = data.input_tokens || 0;
        const outputTokens = data.output_tokens || 0;
        totalCost += costUsd;
        totalInput += inputTokens;
        totalOutput += outputTokens;
        runs.push({ run_id: c.run_id, cost_usd: costUsd, input_tokens: inputTokens, output_tokens: outputTokens, timestamp: c.created_at });
      } catch {}
    }

    return {
      total_cost_usd: totalCost,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_runs: runs.length,
      runs,
    };
  });

  // Get logs for a specific run
  fastify.get<{ Params: { id: string; run_id: string } }>('/api/agents/:id/logs/:run_id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    return db.prepare(
      'SELECT * FROM conversation_logs WHERE agent_id = ? AND run_id = ? ORDER BY id'
    ).all(request.params.id, request.params.run_id);
  });

  // List agent runs with summary
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/agents/:id/runs', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);

    // Get distinct run_ids with timestamps
    const runs = db.prepare(`
      SELECT run_id,
        MIN(created_at) as started_at,
        MAX(created_at) as finished_at
      FROM conversation_logs
      WHERE agent_id = ?
      GROUP BY run_id
      ORDER BY MIN(id) DESC
      LIMIT ?
    `).all(request.params.id, limit) as any[];

    const result = runs.map(run => {
      // Get cost data for this run
      // Cost records are cumulative — take the last one (highest cumulative value)
      const costLog = db.prepare(
        "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'cost' ORDER BY id DESC LIMIT 1"
      ).get(request.params.id, run.run_id) as { content: string } | undefined;

      let costUsd = 0, inputTokens = 0, outputTokens = 0, durationMs = 0;
      if (costLog) {
        try {
          const data = JSON.parse(costLog.content);
          costUsd = data.cost_usd || 0;
          inputTokens = data.input_tokens || 0;
          outputTokens = data.output_tokens || 0;
          durationMs = data.duration_ms || 0;
        } catch {}
      }

      // Count tool calls
      const toolCount = db.prepare(
        "SELECT COUNT(*) as c FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stdout' AND content LIKE '[Tool:%'"
      ).get(request.params.id, run.run_id) as { c: number };

      // Check if there was an error
      const hasError = db.prepare(
        "SELECT COUNT(*) as c FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stderr' AND content != ''"
      ).get(request.params.id, run.run_id) as { c: number };

      // Get final result snippet
      const finalResult = db.prepare(
        "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stdout' AND content LIKE '%--- Final Result ---%' LIMIT 1"
      ).get(request.params.id, run.run_id) as { content: string } | undefined;

      const resultSnippet = finalResult?.content?.replace('--- Final Result ---', '').trim().slice(0, 200) || '';

      return {
        run_id: run.run_id,
        started_at: run.started_at,
        finished_at: run.finished_at,
        status: hasError.c > 0 ? 'error' : 'success',
        cost_usd: costUsd,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        duration_ms: durationMs,
        tool_call_count: toolCount.c,
        result_snippet: resultSnippet,
      };
    });

    return { runs: result };
  });

  // Get agent git status
  fastify.get<{ Params: { id: string } }>('/api/agents/:id/git-status', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    let dir = agent.working_directory;
    if (!dir) return { branch: null, recent_commits: [], has_uncommitted: false, diff_stat: '' };
    if (dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(2));

    try {
      const gitExec = (cmd: string) => execSync(cmd, { cwd: dir!, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

      const branch = gitExec('git branch --show-current') || gitExec('git rev-parse --short HEAD');

      const logOutput = gitExec("git log --format='%H|%s|%ai' -n 5");
      const recent_commits = logOutput ? logOutput.split('\n').map(line => {
        const parts = line.split('|');
        return { hash: parts[0]?.slice(0, 7) || '', message: parts[1] || '', date: parts.slice(2).join('|') };
      }) : [];

      const statusOutput = execSync('git status --porcelain', { cwd: dir!, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      const statusLines = statusOutput.split('\n').filter(l => l.length > 0);
      const has_uncommitted = statusLines.length > 0;

      let diff_stat = '';
      if (has_uncommitted) {
        try { diff_stat = gitExec('git diff --stat'); } catch {}
      }

      const uncommitted_files = statusLines.map(line => {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3);
        return { status, file };
      });

      return { branch, recent_commits, has_uncommitted, diff_stat, uncommitted_files };
    } catch {
      return { branch: null, recent_commits: [], has_uncommitted: false, diff_stat: '' };
    }
  });

  // Get structured run report
  fastify.get<{ Params: { id: string; run_id: string } }>('/api/agents/:id/runs/:run_id/report', async (request, reply) => {
    const db = getDatabase();
    const access = ensureAgentAccess(db, request, reply, request.params.id);
    if (!access) return;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id) as Agent | undefined;
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const logs = db.prepare(
      'SELECT * FROM conversation_logs WHERE agent_id = ? AND run_id = ? ORDER BY id'
    ).all(request.params.id, request.params.run_id) as any[];

    if (!logs.length) return reply.code(404).send({ error: 'Run not found' });

    // Parse logs into structured report
    const toolCalls: Array<{ name: string; input: string; result: string; index: number }> = [];
    const textBlocks: string[] = [];
    const filesChanged = new Set<string>();
    let costData: any = null;
    let finalResult = '';
    let hasError = false;
    let errorMsg = '';

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];

      if (log.stream === 'cost') {
        try { costData = JSON.parse(log.content); } catch {}
        continue;
      }

      if (log.stream === 'stderr' && log.content.trim()) {
        hasError = true;
        errorMsg += log.content;
        continue;
      }

      if (log.stream === 'stdin') continue;

      const content = log.content || '';

      // Parse tool calls
      const toolMatch = content.match(/^\[Tool: (\w+)\] (.*)$/s);
      if (toolMatch) {
        const toolName = toolMatch[1];
        const toolInput = toolMatch[2].trim();

        // Extract file paths from Edit/Write/Read tool calls
        try {
          const inputObj = JSON.parse(toolInput);
          if (inputObj.file_path) filesChanged.add(inputObj.file_path);
          if (inputObj.path) filesChanged.add(inputObj.path);
        } catch {
          // Input was truncated, try to extract file paths with regex
          const pathMatch = toolInput.match(/"(?:file_path|path)"\s*:\s*"([^"]+)"/);
          if (pathMatch) filesChanged.add(pathMatch[1]);
        }

        toolCalls.push({ name: toolName, input: toolInput.slice(0, TOOL_CALL_REPORT_CHAR_LIMIT), result: '', index: i });
        continue;
      }

      // Parse results — associate with the preceding tool call
      const resultMatch = content.match(/^\[Result\] (.*)$/s);
      if (resultMatch && toolCalls.length > 0) {
        toolCalls[toolCalls.length - 1].result = resultMatch[1].slice(0, 500);
        continue;
      }

      // Final result
      if (content.includes('--- Final Result ---')) {
        finalResult = content.replace(/.*--- Final Result ---\n?/, '').trim();
        continue;
      }

      // Cost line (formatted)
      if (content.includes('--- Cost:')) continue;

      // Regular text output
      if (content.trim()) {
        textBlocks.push(content.trim());
      }
    }

    // Build summary
    const startedAt = logs[0]?.created_at;
    const finishedAt = logs[logs.length - 1]?.created_at;

    // Tool call frequency
    const toolFreq: Record<string, number> = {};
    for (const tc of toolCalls) {
      toolFreq[tc.name] = (toolFreq[tc.name] || 0) + 1;
    }

    return {
      run_id: request.params.run_id,
      agent_id: request.params.id,
      agent_name: agent.name,
      started_at: startedAt,
      finished_at: finishedAt,
      status: hasError ? 'error' : 'success',
      error_message: errorMsg.slice(0, 1000) || null,
      cost: costData ? {
        total_usd: costData.cost_usd,
        input_tokens: costData.input_tokens,
        output_tokens: costData.output_tokens,
        cache_read: costData.cache_read,
        duration_ms: costData.duration_ms,
      } : null,
      summary: {
        total_tool_calls: toolCalls.length,
        tool_frequency: toolFreq,
        files_changed: Array.from(filesChanged),
        text_output_length: textBlocks.join('').length,
      },
      final_result: finalResult.slice(0, 2000) || null,
      tool_calls: toolCalls.map(tc => ({
        name: tc.name,
        input: tc.input,
        result: tc.result,
      })),
      key_decisions: textBlocks.slice(0, 20).map(t => t.slice(0, 300)),
    };
  });
}
