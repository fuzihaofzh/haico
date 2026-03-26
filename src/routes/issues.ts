import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { Agent, Project } from '../types';
import { startAgentProcess, isAgentRunning } from '../services/process-manager';
import { buildSystemPrompt } from '../services/system-prompt';
import { triggerControllerAgent } from '../services/controller';
import { tryHandleWithoutLLM } from '../services/pre-controller';
import { broadcastToProject } from '../services/websocket';
import { config } from '../config';

// Parse @agent-name mentions from text and auto-start mentioned agents
function parseMentionsAndStartAgents(
  text: string,
  projectId: string,
  issueId: string,
  issueNumber: number,
  issueTitle: string,
  authorId: string
): void {
  if (!text) return;
  const mentionPattern = /@([\w-]+)/g;
  const mentions = new Set<string>();
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    mentions.add(match[1]);
  }
  if (mentions.size === 0) return;

  const db = getDatabase();
  const agents = db.prepare('SELECT * FROM agents WHERE project_id = ?').all(projectId) as Agent[];
  const eventStmt = db.prepare('INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)');

  for (const agentName of mentions) {
    const agent = agents.find(a => a.name === agentName);
    if (!agent) continue;

    // Auto-start if idle and not paused
    if (!agent.paused && agent.status !== 'running' && !isAgentRunning(agent.id)) {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
      if (project) {
        const prompt = `You were mentioned (@${agentName}) in issue #${issueNumber} "${issueTitle}". Review the issue and take action.\n\nContext: ${text.slice(0, 500)}`;
        const commandTemplate = agent.command_template || project.command_template || config.defaultCommandTemplate;
        const isRaw = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
        const systemPrompt = isRaw ? undefined : buildSystemPrompt(agent, project);
        startAgentProcess(agent, prompt, commandTemplate, systemPrompt);

        // Record system event
        eventStmt.run(
          uuidv4(), issueId, 'system',
          `auto-started ${agent.name} (mentioned by ${authorId === 'user' ? 'user' : nameOfAgent(authorId, agents)})`,
          'status_change',
          JSON.stringify({ mention: agentName, agent_id: agent.id, triggered_by: authorId })
        );
      }
    }
  }
}

function nameOfAgent(agentId: string, agents: Agent[]): string {
  const a = agents.find(x => x.id === agentId);
  return a ? a.name : agentId;
}

// Trigger controller on-demand when interval=0 (wake-on-issue mode)
// actorId: skip triggering if the actor is the controller itself (avoid self-trigger loops)
function triggerControllerOnDemand(projectId: string, triggerIssueNumber?: number, actorId?: string): void {
  const db = getDatabase();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project || project.controller_interval_min > 0) return;

  // Pre-controller: 规则引擎拦截简单场景，避免不必要的 LLM 调用
  if (tryHandleWithoutLLM(projectId, triggerIssueNumber)) return;

  const controller = db.prepare(
    'SELECT * FROM agents WHERE project_id = ? AND is_controller = 1'
  ).get(projectId) as Agent | undefined;
  if (!controller || controller.status === 'running' || controller.paused) return;

  // Skip if the action was performed by the controller itself to avoid self-trigger loops
  if (actorId && actorId === controller.id) return;

  setTimeout(() => { try { triggerControllerAgent(project, false, triggerIssueNumber); } catch {} }, 1000);
}

function resolvePriority(createdBy: string, projectId: string): number {
  if (createdBy === 'user' || createdBy === 'system') return 10;
  const db = getDatabase();
  const agent = db.prepare('SELECT is_controller FROM agents WHERE id = ? AND project_id = ?').get(createdBy, projectId) as { is_controller: number } | undefined;
  if (agent?.is_controller) return 5;
  return 1;
}

export function registerIssueRoutes(fastify: FastifyInstance): void {

  // ─── Issues ───

  // List issues (with search, sort, pagination)
  fastify.get<{ Params: { pid: string }; Querystring: { status?: string; assigned_to?: string; label?: string; q?: string; sort?: string; page?: string; per_page?: string; milestone_id?: string } }>(
    '/api/projects/:pid/issues',
    async (request) => {
      const db = getDatabase();
      const { status, assigned_to, label, q, sort, page, per_page, milestone_id } = request.query;

      let sql = `SELECT issues.*, (SELECT COUNT(*) FROM issue_comments WHERE issue_id = issues.id AND event_type = 'comment') as comment_count FROM issues WHERE project_id = ?`;
      const params: any[] = [request.params.pid];

      if (status) { sql += ' AND status = ?'; params.push(status); }
      if (assigned_to) { sql += ' AND assigned_to = ?'; params.push(assigned_to); }
      if (label) { sql += " AND (',' || labels || ',') LIKE ?"; params.push(`%,${label},%`); }
      if (milestone_id) { sql += ' AND milestone_id = ?'; params.push(milestone_id); }
      if (q) { sql += ' AND (title LIKE ? OR body LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }

      // Sort
      const sortMap: Record<string, string> = {
        'newest': 'created_at DESC',
        'oldest': 'created_at ASC',
        'updated': 'updated_at DESC',
        'priority': 'priority DESC, created_at DESC',
        'comments': '(SELECT COUNT(*) FROM issue_comments WHERE issue_id = issues.id) DESC',
      };
      sql += ' ORDER BY ' + (sortMap[sort || ''] || 'priority DESC, created_at DESC');

      // Pagination
      const limit = Math.min(parseInt(per_page || '100'), 200);
      const offset = (Math.max(parseInt(page || '1'), 1) - 1) * limit;
      const countSql = sql.replace(/SELECT issues\.\*.*?FROM issues/, 'SELECT COUNT(*) as total FROM issues');
      const total = (db.prepare(countSql).get(...params) as any)?.total || 0;

      sql += ` LIMIT ${limit} OFFSET ${offset}`;
      const issues = db.prepare(sql).all(...params);

      return { issues, total, page: Math.floor(offset / limit) + 1, per_page: limit, total_pages: Math.ceil(total / limit) };
    }
  );

  // Issue counts by status (lightweight alternative to loading all issues)
  fastify.get<{ Params: { pid: string } }>(
    '/api/projects/:pid/issues/counts',
    async (request) => {
      const db = getDatabase();
      const rows = db.prepare(
        `SELECT status, COUNT(*) as count FROM issues WHERE project_id = ? GROUP BY status`
      ).all(request.params.pid) as { status: string; count: number }[];
      const counts: Record<string, number> = { open: 0, in_progress: 0, pending: 0, done: 0, closed: 0 };
      let total = 0;
      for (const row of rows) {
        counts[row.status] = row.count;
        total += row.count;
      }
      return { ...counts, total };
    }
  );

  // Create issue
  fastify.post<{ Params: { pid: string }; Body: { title: string; body?: string; created_by: string; assigned_to?: string; labels?: string; parent_id?: string } }>(
    '/api/projects/:pid/issues',
    async (request, reply) => {
      const { title, body, created_by, assigned_to, labels, parent_id } = request.body;
      if (!title || !created_by) {
        return reply.code(400).send({ error: 'title and created_by are required' });
      }

      const db = getDatabase();
      const id = uuidv4();
      const priority = resolvePriority(created_by, request.params.pid);

      // Auto-increment number per project
      const last = db.prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?').get(request.params.pid) as { n: number | null };
      const number = (last?.n || 0) + 1;

      // Validate parent_id if provided
      if (parent_id) {
        const parent = db.prepare('SELECT id, project_id FROM issues WHERE id = ?').get(parent_id) as any;
        if (!parent) return reply.code(400).send({ error: 'Parent issue not found' });
        if (parent.project_id !== request.params.pid) return reply.code(400).send({ error: 'Parent issue must be in the same project' });
      }

      db.prepare(`
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, labels, parent_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `).run(id, request.params.pid, number, title, body || '', created_by, assigned_to || null, priority, labels || '', parent_id || null);

      const created = db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as any;

      broadcastToProject(request.params.pid, {
        type: 'issue_created', projectId: request.params.pid,
        data: { issue: created },
      });

      // Auto-start assigned agent when user creates issue
      if (created_by === 'user' && assigned_to && assigned_to !== 'user' && assigned_to !== 'all') {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(assigned_to) as Agent | undefined;
        if (agent && !agent.paused && agent.status !== 'running' && !isAgentRunning(agent.id)) {
          const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.pid) as Project | undefined;
          if (project) {
            const prompt = `New issue #${number} "${title}" has been assigned to you. Review and take action.\n\nDescription: ${(body || '').slice(0, 500)}`;
            const commandTemplate = agent.command_template || project.command_template || config.defaultCommandTemplate;
            const isRaw = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
            const systemPrompt = isRaw ? undefined : buildSystemPrompt(agent, project);
            startAgentProcess(agent, prompt, commandTemplate, systemPrompt);
          }
        }
      } else if (created_by === 'user' && (!assigned_to || assigned_to === 'all')) {
        // Trigger controller for unassigned/broadcast issues
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.pid) as Project | undefined;
        if (project) setTimeout(() => { try { triggerControllerAgent(project, false, number); } catch {} }, 1000);
      }

      // Parse @mentions in body and auto-start mentioned agents
      if (body) {
        parseMentionsAndStartAgents(body, request.params.pid, id, number, title, created_by);
      }

      // Wake-on-issue: trigger controller when any issue is created
      triggerControllerOnDemand(request.params.pid, number, created_by);

      return reply.code(201).send(created);
    }
  );

  // Get issue detail (with comments + reactions + parent/children)
  fastify.get<{ Params: { id: string } }>('/api/issues/:id', async (request, reply) => {
    const db = getDatabase();
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id) as any;
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });

    const comments = db.prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at').all(request.params.id);
    const reactions = db.prepare("SELECT * FROM reactions WHERE target_type = 'issue' AND target_id = ?").all(request.params.id);
    const commentsWithReactions = (comments as any[]).map(c => ({
      ...c,
      reactions: db.prepare("SELECT * FROM reactions WHERE target_type = 'comment' AND target_id = ?").all(c.id),
    }));

    // Parent info
    let parent_number: number | null = null;
    let parent_title: string | null = null;
    if (issue.parent_id) {
      const parent = db.prepare('SELECT number, title FROM issues WHERE id = ?').get(issue.parent_id) as any;
      if (parent) { parent_number = parent.number; parent_title = parent.title; }
    }

    // Children
    const children = db.prepare(
      'SELECT id, number, title, status, assigned_to FROM issues WHERE parent_id = ? ORDER BY number'
    ).all(request.params.id);

    return { ...issue, comments: commentsWithReactions, reactions, parent_number, parent_title, children };
  });

  // Update issue with timeline events
  fastify.put<{ Params: { id: string }; Body: { status?: string; assigned_to?: string; title?: string; body?: string; labels?: string; milestone_id?: string; actor?: string } }>(
    '/api/issues/:id',
    async (request, reply) => {
      const db = getDatabase();
      const existing = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id) as any;
      if (!existing) return reply.code(404).send({ error: 'Issue not found' });

      const { status, assigned_to, title, body, labels, milestone_id, actor } = request.body as any;
      const actorId = actor || 'user';

      if (status && !['open', 'in_progress', 'pending', 'done', 'closed'].includes(status)) {
        return reply.code(400).send({ error: 'Invalid status' });
      }

      // Record timeline events for changes
      const eventStmt = db.prepare('INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)');
      if (status && status !== existing.status) {
        eventStmt.run(uuidv4(), request.params.id, actorId, `changed status from ${existing.status} to ${status}`, 'status_change', JSON.stringify({ from: existing.status, to: status }));
      }
      if (assigned_to !== undefined && assigned_to !== existing.assigned_to) {
        eventStmt.run(uuidv4(), request.params.id, actorId, `assigned to ${assigned_to || 'nobody'}`, 'assignment', JSON.stringify({ from: existing.assigned_to, to: assigned_to }));
      }
      if (labels !== undefined && labels !== existing.labels) {
        eventStmt.run(uuidv4(), request.params.id, actorId, `changed labels`, 'label_change', JSON.stringify({ from: existing.labels, to: labels }));
      }

      // Reset acknowledged_at when status or assignment changes
      const resetAck = (status && status !== existing.status) || (assigned_to !== undefined && assigned_to !== existing.assigned_to);

      db.prepare(`
        UPDATE issues SET
          title = COALESCE(?, title),
          body = COALESCE(?, body),
          assigned_to = COALESCE(?, assigned_to),
          status = COALESCE(?, status),
          labels = COALESCE(?, labels),
          milestone_id = COALESCE(?, milestone_id),
          acknowledged_at = CASE WHEN ? THEN NULL ELSE acknowledged_at END,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(title ?? null, body ?? null, assigned_to ?? null, status ?? null, labels ?? null, milestone_id ?? null, resetAck ? 1 : 0, request.params.id);

      const updated = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id) as any;

      broadcastToProject(updated.project_id, {
        type: 'issue_updated', projectId: updated.project_id,
        data: { issue: updated },
      });

      // When child issue completed, check siblings and update parent
      if ((status === 'done' || status === 'closed') && updated.parent_id) {
        const siblings = db.prepare(
          "SELECT COUNT(*) as total, SUM(CASE WHEN status IN ('done','closed') THEN 1 ELSE 0 END) as completed FROM issues WHERE parent_id = ?"
        ).get(updated.parent_id) as any;
        const parentIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(updated.parent_id) as any;
        const eventStmt2 = db.prepare('INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)');

        if (siblings.total > 0 && siblings.total === siblings.completed && parentIssue) {
          // All children done
          eventStmt2.run(uuidv4(), updated.parent_id, 'system',
            `All ${siblings.total} child issues are now complete.`, 'status_change',
            JSON.stringify({ all_children_complete: true, child_count: siblings.total }));

          // If parent was created by user, assign back to user for review
          if (parentIssue.created_by === 'user') {
            db.prepare("UPDATE issues SET status = 'done', assigned_to = 'user', acknowledged_at = NULL, updated_at = datetime('now') WHERE id = ?")
              .run(updated.parent_id);
            eventStmt2.run(uuidv4(), updated.parent_id, 'system',
              'assigned to user for review (all child issues complete)', 'assignment',
              JSON.stringify({ from: parentIssue.assigned_to, to: 'user' }));
          } else {
            db.prepare("UPDATE issues SET updated_at = datetime('now'), acknowledged_at = NULL WHERE id = ?")
              .run(updated.parent_id);
            // Trigger controller to review and close parent
            triggerControllerOnDemand(updated.project_id, parentIssue.number, actorId);
          }
        } else if (parentIssue) {
          // Partial progress — update parent timestamp so it's visible
          eventStmt2.run(uuidv4(), updated.parent_id, 'system',
            `Child #${updated.number} completed (${siblings.completed}/${siblings.total} done).`, 'status_change',
            JSON.stringify({ child_number: updated.number, completed: siblings.completed, total: siblings.total }));
          db.prepare("UPDATE issues SET updated_at = datetime('now') WHERE id = ?").run(updated.parent_id);
        }
      }

      // System-level auto-assign back to user: when a user-created issue (without parent)
      // is marked done by an agent, assign it back to user for review — no controller needed
      if ((status === 'done' || status === 'closed') && !updated.parent_id
          && existing.created_by === 'user' && actorId !== 'user'
          && existing.assigned_to !== 'user') {
        db.prepare("UPDATE issues SET assigned_to = 'user', acknowledged_at = NULL, updated_at = datetime('now') WHERE id = ?")
          .run(request.params.id);
        const returnEvt = db.prepare('INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)');
        returnEvt.run(uuidv4(), request.params.id, 'system',
          'assigned to user for review (task completed)', 'assignment',
          JSON.stringify({ from: existing.assigned_to, to: 'user' }));
      }

      // Wake-on-issue: trigger controller when issue status/assignment changes
      triggerControllerOnDemand(updated.project_id, updated.number, actorId);

      // Auto-start agent when user assigns an issue to them
      if (actorId === 'user' && assigned_to && assigned_to !== existing.assigned_to && assigned_to !== 'user' && assigned_to !== 'all') {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(assigned_to) as Agent | undefined;
        if (agent && !agent.paused && agent.status !== 'running' && !isAgentRunning(agent.id)) {
          const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(updated.project_id) as Project | undefined;
          if (project) {
            const prompt = `You have been assigned issue #${updated.number} "${updated.title}". Review it and take action.\n\nDescription: ${updated.body?.slice(0, 500) || '(none)'}`;
            const commandTemplate = agent.command_template || project.command_template || config.defaultCommandTemplate;
            const isRaw = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
            const systemPrompt = isRaw ? undefined : buildSystemPrompt(agent, project);
            startAgentProcess(agent, prompt, commandTemplate, systemPrompt);
          }
        }
      }

      return updated;
    }
  );

  // Delete issue (only open)
  fastify.delete<{ Params: { id: string } }>('/api/issues/:id', async (request, reply) => {
    const db = getDatabase();
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id) as any;
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });
    if (issue.status !== 'open') {
      return reply.code(409).send({ error: 'Only open issues can be deleted' });
    }
    db.prepare('DELETE FROM issues WHERE id = ?').run(request.params.id);
    return { success: true };
  });

  // ─── Comments ───

  // List comments
  fastify.get<{ Params: { id: string } }>('/api/issues/:id/comments', async (request) => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at').all(request.params.id);
  });

  // User notifications — open issues assigned to user + recent comments on user's issues
  fastify.get('/api/notifications', async () => {
    const db = getDatabase();
    const userIssues = db.prepare(
      "SELECT i.*, p.name as project_name FROM issues i JOIN projects p ON i.project_id = p.id WHERE i.assigned_to = 'user' AND i.status IN ('open', 'in_progress') AND i.acknowledged_at IS NULL ORDER BY i.priority DESC, i.updated_at DESC"
    ).all() as any[];

    // Recent comments on any issue (last 20)
    const recentComments = db.prepare(
      "SELECT c.*, i.title as issue_title, i.number as issue_number, i.project_id, p.name as project_name FROM issue_comments c JOIN issues i ON c.issue_id = i.id JOIN projects p ON i.project_id = p.id WHERE c.author_id != 'user' ORDER BY c.created_at DESC LIMIT 20"
    ).all() as any[];

    return { user_issues: userIssues, recent_comments: recentComments };
  });

  // My Issues — all issues the user is involved in (assigned, created, or commented)
  fastify.get('/api/my-issues', async () => {
    const db = getDatabase();
    return db.prepare(`
      SELECT DISTINCT i.*, p.name as project_name FROM issues i
      JOIN projects p ON i.project_id = p.id
      WHERE i.assigned_to = 'user'
         OR i.created_by = 'user'
         OR i.id IN (SELECT DISTINCT issue_id FROM issue_comments WHERE author_id = 'user')
      ORDER BY i.updated_at DESC
      LIMIT 100
    `).all();
  });

  // Inbox search — search all issues by title, body, or number
  fastify.get<{ Querystring: { q?: string } }>('/api/inbox/search', async (request) => {
    const db = getDatabase();
    const q = (request.query.q || '').trim();
    if (!q) return [];
    const like = `%${q}%`;
    return db.prepare(
      "SELECT i.*, p.name as project_name FROM issues i JOIN projects p ON i.project_id = p.id WHERE i.title LIKE ? OR i.body LIKE ? OR CAST(i.number AS TEXT) LIKE ? ORDER BY i.updated_at DESC LIMIT 50"
    ).all(like, like, like);
  });

  // Acknowledge issue (mark as read — hides from notifications)
  fastify.post<{ Params: { id: string } }>('/api/issues/:id/acknowledge', async (request, reply) => {
    const db = getDatabase();
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id);
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });
    db.prepare("UPDATE issues SET acknowledged_at = datetime('now') WHERE id = ?").run(request.params.id);
    return db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id);
  });

  // Unacknowledge issue (show again in notifications)
  fastify.post<{ Params: { id: string } }>('/api/issues/:id/unacknowledge', async (request, reply) => {
    const db = getDatabase();
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id);
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });
    db.prepare("UPDATE issues SET acknowledged_at = NULL WHERE id = ?").run(request.params.id);
    return db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id);
  });

  // Add comment
  fastify.post<{ Params: { id: string }; Body: { author_id: string; body: string } }>(
    '/api/issues/:id/comments',
    async (request, reply) => {
      const { author_id, body } = request.body;
      if (!author_id || !body) {
        return reply.code(400).send({ error: 'author_id and body are required' });
      }

      const db = getDatabase();
      const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id);
      if (!issue) return reply.code(404).send({ error: 'Issue not found' });

      const id = uuidv4();
      db.prepare('INSERT INTO issue_comments (id, issue_id, author_id, body) VALUES (?, ?, ?, ?)')
        .run(id, request.params.id, author_id, body);

      // Update issue timestamp and reset acknowledged_at (new comment = new activity)
      db.prepare("UPDATE issues SET updated_at = datetime('now'), acknowledged_at = NULL WHERE id = ?").run(request.params.id);

      const comment = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(id);
      const iss = issue as any;

      broadcastToProject(iss.project_id, {
        type: 'comment_added', projectId: iss.project_id,
        data: { comment, issueId: request.params.id, issueNumber: iss.number },
      });

      // Parse @mentions in comment and auto-start mentioned agents
      parseMentionsAndStartAgents(body, iss.project_id, request.params.id, iss.number, iss.title, author_id);

      // Wake-on-issue: trigger controller when comment is added
      triggerControllerOnDemand(iss.project_id, iss.number, author_id);

      // If user commented, auto-reassign issue and start the target agent
      if (author_id === 'user') {
        // Auto-reassign: parse @mentions to find target agent, fallback to controller
        const agents = db.prepare('SELECT * FROM agents WHERE project_id = ?').all(iss.project_id) as Agent[];
        const mentionPattern = /@([\w-]+)/g;
        let mentionMatch;
        let targetAgent: Agent | undefined;
        while ((mentionMatch = mentionPattern.exec(body)) !== null) {
          targetAgent = agents.find(a => a.name === mentionMatch![1]);
          if (targetAgent) break; // Use first matched agent
        }

        const controllerAgent = agents.find(a => a.is_controller);
        const controllerId = controllerAgent?.id || 'b9b6362c-2d59-40cd-9ffc-fd871a7e811e';
        const newAssignee = targetAgent ? targetAgent.id : controllerId;

        // Update assignment
        db.prepare('UPDATE issues SET assigned_to = ? WHERE id = ?').run(newAssignee, request.params.id);

        // Reopen if done/closed
        if (iss.status === 'done' || iss.status === 'closed') {
          db.prepare("UPDATE issues SET status = 'open' WHERE id = ?").run(request.params.id);
        }

        // Start the assigned agent
        const agentToStart = targetAgent || (controllerAgent as Agent | undefined);
        if (agentToStart && !agentToStart.paused && agentToStart.status !== 'running' && !isAgentRunning(agentToStart.id)) {
          const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(iss.project_id) as Project | undefined;
          if (project) {
            if (agentToStart.is_controller) {
              setTimeout(() => { try { triggerControllerAgent(project, false, iss.number); } catch {} }, 1000);
            } else {
              const prompt = `User just commented on issue #${iss.number} "${iss.title}" assigned to you. Review the comment and respond.\n\nComment: ${body}`;
              const commandTemplate = agentToStart.command_template || project.command_template || config.defaultCommandTemplate;
              const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
              const systemPrompt = isRawShell ? undefined : buildSystemPrompt(agentToStart, project);
              startAgentProcess(agentToStart, prompt, commandTemplate, systemPrompt);
            }
          }
        }
      }

      return reply.code(201).send(comment);
    }
  );

  // Edit comment
  fastify.put<{ Params: { id: string }; Body: { body: string } }>('/api/comments/:id', async (request, reply) => {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Comment not found' });
    db.prepare('UPDATE issue_comments SET body = ? WHERE id = ?').run(request.body.body, request.params.id);
    return db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(request.params.id);
  });

  // Delete comment
  fastify.delete<{ Params: { id: string } }>('/api/comments/:id', async (request, reply) => {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Comment not found' });
    db.prepare('DELETE FROM issue_comments WHERE id = ?').run(request.params.id);
    return { success: true };
  });

  // Get issue by project ID + number (with reactions + parent/children)
  fastify.get<{ Params: { pid: string; num: string } }>('/api/projects/:pid/issues/number/:num', async (request, reply) => {
    const db = getDatabase();
    const issue = db.prepare('SELECT * FROM issues WHERE project_id = ? AND number = ?').get(request.params.pid, parseInt(request.params.num)) as any;
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });
    const comments = db.prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at').all(issue.id);
    const reactions = db.prepare("SELECT * FROM reactions WHERE target_type = 'issue' AND target_id = ?").all(issue.id);
    const commentsWithReactions = (comments as any[]).map(c => ({
      ...c,
      reactions: db.prepare("SELECT * FROM reactions WHERE target_type = 'comment' AND target_id = ?").all(c.id),
    }));

    let parent_number: number | null = null;
    let parent_title: string | null = null;
    if (issue.parent_id) {
      const parent = db.prepare('SELECT number, title FROM issues WHERE id = ?').get(issue.parent_id) as any;
      if (parent) { parent_number = parent.number; parent_title = parent.title; }
    }
    const children = db.prepare(
      'SELECT id, number, title, status, assigned_to FROM issues WHERE parent_id = ? ORDER BY number'
    ).all(issue.id);

    return { ...issue, comments: commentsWithReactions, reactions, parent_number, parent_title, children };
  });

  // Also update GET /api/issues/:id to include reactions
  // (Override by adding reactions to response)

  // ─── Reactions ───

  fastify.post<{ Params: { type: string; id: string }; Body: { user_id: string; emoji: string } }>(
    '/api/reactions/:type/:id',
    async (request, reply) => {
      const db = getDatabase();
      const { user_id, emoji } = request.body;
      if (!user_id || !emoji) return reply.code(400).send({ error: 'user_id and emoji required' });
      const id = uuidv4();
      try {
        db.prepare('INSERT INTO reactions (id, target_type, target_id, user_id, emoji) VALUES (?, ?, ?, ?, ?)')
          .run(id, request.params.type, request.params.id, user_id, emoji);
      } catch {
        // Already exists, remove (toggle)
        db.prepare('DELETE FROM reactions WHERE target_type = ? AND target_id = ? AND user_id = ? AND emoji = ?')
          .run(request.params.type, request.params.id, user_id, emoji);
        return { toggled: 'off' };
      }
      return reply.code(201).send({ toggled: 'on', id });
    }
  );

  fastify.get<{ Params: { type: string; id: string } }>('/api/reactions/:type/:id', async (request) => {
    const db = getDatabase();
    return db.prepare('SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users FROM reactions WHERE target_type = ? AND target_id = ? GROUP BY emoji')
      .all(request.params.type, request.params.id);
  });

  // ─── Milestones ───

  fastify.get<{ Params: { pid: string } }>('/api/projects/:pid/milestones', async (request) => {
    const db = getDatabase();
    const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY created_at DESC').all(request.params.pid);
    // Add progress
    return (milestones as any[]).map(m => {
      const total = db.prepare('SELECT COUNT(*) as c FROM issues WHERE milestone_id = ?').get(m.id) as any;
      const closed = db.prepare("SELECT COUNT(*) as c FROM issues WHERE milestone_id = ? AND status IN ('done','closed')").get(m.id) as any;
      return { ...m, total_issues: total.c, closed_issues: closed.c, progress: total.c > 0 ? Math.round(closed.c / total.c * 100) : 0 };
    });
  });

  fastify.post<{ Params: { pid: string }; Body: { title: string; description?: string; due_date?: string } }>(
    '/api/projects/:pid/milestones',
    async (request, reply) => {
      const db = getDatabase();
      const { title, description, due_date } = request.body;
      if (!title) return reply.code(400).send({ error: 'title required' });
      const id = uuidv4();
      db.prepare('INSERT INTO milestones (id, project_id, title, description, due_date) VALUES (?, ?, ?, ?, ?)')
        .run(id, request.params.pid, title, description || '', due_date || null);
      return reply.code(201).send(db.prepare('SELECT * FROM milestones WHERE id = ?').get(id));
    }
  );

  fastify.put<{ Params: { id: string }; Body: { title?: string; description?: string; due_date?: string; status?: string } }>(
    '/api/milestones/:id',
    async (request, reply) => {
      const db = getDatabase();
      const { title, description, due_date, status } = request.body;
      db.prepare('UPDATE milestones SET title = COALESCE(?, title), description = COALESCE(?, description), due_date = COALESCE(?, due_date), status = COALESCE(?, status) WHERE id = ?')
        .run(title ?? null, description ?? null, due_date ?? null, status ?? null, request.params.id);
      return db.prepare('SELECT * FROM milestones WHERE id = ?').get(request.params.id);
    }
  );

  fastify.delete<{ Params: { id: string } }>('/api/milestones/:id', async (request, reply) => {
    const db = getDatabase();
    db.prepare('UPDATE issues SET milestone_id = NULL WHERE milestone_id = ?').run(request.params.id);
    db.prepare('DELETE FROM milestones WHERE id = ?').run(request.params.id);
    return { success: true };
  });

  // ─── Search ───

  fastify.get<{ Params: { pid: string }; Querystring: { q: string } }>('/api/projects/:pid/search', async (request) => {
    const db = getDatabase();
    const q = `%${request.query.q}%`;
    const issues = db.prepare('SELECT * FROM issues WHERE project_id = ? AND (title LIKE ? OR body LIKE ?) ORDER BY updated_at DESC LIMIT 50')
      .all(request.params.pid, q, q);
    const comments = db.prepare("SELECT c.*, i.number as issue_number, i.title as issue_title FROM issue_comments c JOIN issues i ON c.issue_id = i.id WHERE i.project_id = ? AND c.body LIKE ? AND c.event_type = 'comment' ORDER BY c.created_at DESC LIMIT 20")
      .all(request.params.pid, q);
    return { issues, comments };
  });

}
