import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, isDatabaseOpen } from '../db/database';
import { Agent, Project } from '../types';
import { startAgentProcess, isAgentRunning } from '../services/process-manager';
import logger from '../logger';
import { buildSystemPrompt } from '../services/system-prompt';
import { triggerControllerAgent } from '../services/controller';
import { tryHandleWithoutLLM } from '../services/pre-controller';
import { broadcastToProject } from '../services/websocket';
import { config } from '../config';
import {
  ensureCommentAccess,
  ensureIssueAccess,
  ensureMilestoneAccess,
  ensureProjectAccess,
  ensureRelationAccess,
  getProjectRequestContext,
  listAccessibleProjectIds,
} from '../services/project-permissions';

// Track pending controller trigger timers so they can be cancelled during shutdown
const pendingControllerTriggerTimers = new Set<NodeJS.Timeout>();

export function clearPendingControllerTriggerTimers(): void {
  for (const timer of pendingControllerTriggerTimers) clearTimeout(timer);
  pendingControllerTriggerTimers.clear();
}

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
      if (project && project.status !== 'paused') {
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

// Trigger controller on-demand (wake-on-issue mode)
// actorId: skip triggering if the actor is the controller itself (avoid self-trigger loops)
function triggerControllerOnDemand(projectId: string, triggerIssueNumber?: number, actorId?: string): void {
  const db = getDatabase();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project || project.status === 'paused') return;

  // Pre-controller: 规则引擎拦截简单场景，避免不必要的 LLM 调用
  if (tryHandleWithoutLLM(projectId, triggerIssueNumber)) return;

  const controller = db.prepare(
    'SELECT * FROM agents WHERE project_id = ? AND is_controller = 1'
  ).get(projectId) as Agent | undefined;
  if (!controller || controller.status === 'running' || controller.paused) return;

  // Skip if the action was performed by the controller itself to avoid self-trigger loops
  if (actorId && actorId === controller.id) return;

  const timer = setTimeout(() => {
    pendingControllerTriggerTimers.delete(timer);
    try { if (isDatabaseOpen()) triggerControllerAgent(project, false, triggerIssueNumber); } catch {}
  }, 1000);
  pendingControllerTriggerTimers.add(timer);
}

function resolvePriority(createdBy: string, projectId: string): number {
  if (createdBy === 'user' || createdBy === 'system') return 10;
  const db = getDatabase();
  const agent = db.prepare('SELECT is_controller FROM agents WHERE id = ? AND project_id = ?').get(createdBy, projectId) as { is_controller: number } | undefined;
  if (agent?.is_controller) return 5;
  return 1;
}

function buildSqlPlaceholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export function registerIssueRoutes(fastify: FastifyInstance): void {

  // ─── Issues ───

  // List issues (with search, sort, pagination)
  fastify.get<{ Params: { pid: string }; Querystring: { status?: string; assigned_to?: string; label?: string; q?: string; sort?: string; page?: string; per_page?: string; milestone_id?: string } }>(
    '/api/projects/:pid/issues',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.pid);
      if (!access) return;
      const { status, assigned_to, label, q, sort, page, per_page, milestone_id } = request.query;

      let sql = `SELECT issues.*, (SELECT COUNT(*) FROM issue_comments WHERE issue_id = issues.id AND event_type = 'comment') as comment_count, (SELECT COUNT(*) > 0 FROM issue_relations r JOIN issues blocker ON blocker.id = r.from_issue_id WHERE r.to_issue_id = issues.id AND r.relation_type = 'blocks' AND blocker.status NOT IN ('done', 'closed')) as is_blocked FROM issues WHERE project_id = ?`;
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
      sql += ' ORDER BY ' + (sortMap[sort || ''] || 'created_at DESC');

      // Pagination
      const limit = Math.min(parseInt(per_page || '100'), 200);
      const offset = (Math.max(parseInt(page || '1'), 1) - 1) * limit;
      const countSql = sql.replace(/SELECT issues\.\*.*?FROM issues/, 'SELECT COUNT(*) as total FROM issues');
      const total = (db.prepare(countSql).get(...params) as any)?.total || 0;

      sql += ` LIMIT ${limit} OFFSET ${offset}`;
      const issues = db.prepare(sql).all(...params).map((issue: any) => ({
        ...issue,
        is_blocked: !!issue.is_blocked,
      }));

      return { issues, total, page: Math.floor(offset / limit) + 1, per_page: limit, total_pages: Math.ceil(total / limit) };
    }
  );

  // Issue counts by status (lightweight alternative to loading all issues)
  fastify.get<{ Params: { pid: string } }>(
    '/api/projects/:pid/issues/counts',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.pid);
      if (!access) return;
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
      const access = ensureProjectAccess(db, request, reply, request.params.pid, true);
      if (!access) return;
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

      // Auto-set parent issue to 'pending' when a child issue is created
      if (parent_id) {
        const parent = db.prepare('SELECT id, status FROM issues WHERE id = ?').get(parent_id) as any;
        if (parent && !['done', 'closed', 'pending'].includes(parent.status)) {
          db.prepare("UPDATE issues SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(parent_id);
          const eventStmt = db.prepare('INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)');
          eventStmt.run(uuidv4(), parent_id, 'system',
            `changed status from ${parent.status} to pending (child issue #${number} created)`, 'status_change',
            JSON.stringify({ from: parent.status, to: 'pending', child_number: number }));
          broadcastToProject(request.params.pid, {
            type: 'issue_updated', projectId: request.params.pid,
            data: { issue: db.prepare('SELECT * FROM issues WHERE id = ?').get(parent_id) },
          });
        } else if (parent && parent.status === 'pending') {
          const eventStmt = db.prepare('INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)');
          eventStmt.run(uuidv4(), parent_id, 'system',
            `New child issue #${number} added`, 'status_change',
            JSON.stringify({ child_number: number }));
        }
      }

      broadcastToProject(request.params.pid, {
        type: 'issue_created', projectId: request.params.pid,
        data: { issue: created },
      });

      // Auto-start assigned agent when user creates issue
      if (created_by === 'user' && assigned_to && assigned_to !== 'user' && assigned_to !== 'all') {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(assigned_to) as Agent | undefined;
        if (agent && !agent.paused && agent.status !== 'running' && !isAgentRunning(agent.id)) {
          const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.pid) as Project | undefined;
          if (project && project.status !== 'paused') {
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
        if (project && project.status !== 'paused') {
          const t = setTimeout(() => {
            pendingControllerTriggerTimers.delete(t);
            try { if (isDatabaseOpen()) triggerControllerAgent(project, false, number); } catch {}
          }, 1000);
          pendingControllerTriggerTimers.add(t);
        }
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
    const t0 = Date.now();
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id);
    if (!access) return;
    const t1 = Date.now();
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id) as any;
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });
    const t2 = Date.now();

    const comments = db.prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at').all(request.params.id) as any[];
    const reactions = db.prepare("SELECT * FROM reactions WHERE target_type = 'issue' AND target_id = ?").all(request.params.id);
    const t3 = Date.now();
    // Batch-fetch all comment reactions in one query (fixes N+1)
    const commentIds = comments.map(c => c.id);
    let commentReactionsMap: Record<string, any[]> = {};
    if (commentIds.length > 0) {
      const placeholders = commentIds.map(() => '?').join(',');
      const allReactions = db.prepare(`SELECT * FROM reactions WHERE target_type = 'comment' AND target_id IN (${placeholders})`).all(...commentIds) as any[];
      for (const r of allReactions) {
        (commentReactionsMap[r.target_id] ||= []).push(r);
      }
    }
    const commentsWithReactions = comments.map(c => ({
      ...c,
      reactions: commentReactionsMap[c.id] || [],
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

    // Relations (blocks / blocked_by / related_to) — single query for all directions
    const allRelations = db.prepare(`
      SELECT r.id as relation_id, r.relation_type, r.created_by, r.created_at,
             r.from_issue_id, r.to_issue_id,
             i.id, i.number, i.title, i.status
      FROM issue_relations r JOIN issues i ON i.id = CASE
        WHEN r.from_issue_id = ? THEN r.to_issue_id
        ELSE r.from_issue_id
      END
      WHERE r.from_issue_id = ? OR r.to_issue_id = ?
    `).all(request.params.id, request.params.id, request.params.id) as any[];
    const t4 = Date.now();

    const issueId = request.params.id;
    const blocks = allRelations.filter(r => r.relation_type === 'blocks' && r.from_issue_id === issueId);
    const blocked_by = allRelations.filter(r => r.relation_type === 'blocks' && r.to_issue_id === issueId);
    const related_to = allRelations.filter(r => r.relation_type === 'related_to');

    // is_blocked: true if any blocker is not done/closed
    const is_blocked = blocked_by.some((r: any) => !['done', 'closed'].includes(r.status));

    const total = Date.now() - t0;
    if (total > 500) {
      logger.warn(`SLOW /api/issues/:id (${total}ms): access=${t1-t0}ms issue=${t2-t1}ms comments=${t3-t2}ms rest=${t4-t3}ms id=${issueId}`);
    }

    return { ...issue, comments: commentsWithReactions, reactions, parent_number, parent_title, children, blocks, blocked_by, related_to, is_blocked };
  });

  // Update issue with timeline events
  fastify.put<{ Params: { id: string }; Body: { status?: string; assigned_to?: string; title?: string; body?: string; labels?: string; milestone_id?: string; actor?: string } }>(
    '/api/issues/:id',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureIssueAccess(db, request, reply, request.params.id, true);
      if (!access) return;
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
        const agentRow = assigned_to ? db.prepare('SELECT name FROM agents WHERE id = ?').get(assigned_to) as { name: string } | undefined : null;
        const assigneeName = agentRow ? agentRow.name : (assigned_to || 'nobody');
        eventStmt.run(uuidv4(), request.params.id, actorId, `assigned to ${assigneeName}`, 'assignment', JSON.stringify({ from: existing.assigned_to, to: assigned_to }));
      }
      if (labels !== undefined && labels !== existing.labels) {
        eventStmt.run(uuidv4(), request.params.id, actorId, `changed labels`, 'label_change', JSON.stringify({ from: existing.labels, to: labels }));
      }

      // Reset acknowledged_at only when issue is reassigned TO user (needs attention)
      // Status changes alone don't reset — user gets notified via comments instead
      const resetAck = assigned_to !== undefined && assigned_to !== existing.assigned_to && assigned_to === 'user';

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
          // All children done — build summary with each sub-issue listed
          const childIssues = db.prepare(
            'SELECT number, title, status FROM issues WHERE parent_id = ? ORDER BY number ASC'
          ).all(updated.parent_id) as Array<{ number: number; title: string; status: string }>;
          const summaryLines = childIssues.map(
            (c) => `- #${c.number} [${c.status}] ${c.title}`
          ).join('\n');
          const summaryBody = `All ${siblings.total} sub-issues completed:\n${summaryLines}`;
          eventStmt2.run(uuidv4(), updated.parent_id, 'system',
            summaryBody, 'status_change',
            JSON.stringify({ all_children_complete: true, child_count: siblings.total }));

          // If parent was created by user, DO NOT assign to user yet — let controller summarize first
          if (parentIssue.created_by === 'user') {
            db.prepare("UPDATE issues SET updated_at = datetime('now'), acknowledged_at = NULL WHERE id = ?")
              .run(updated.parent_id);
            // Trigger controller to write summary, then controller will assign to user
            triggerControllerOnDemand(updated.project_id, parentIssue.number, actorId);
          } else {
            db.prepare("UPDATE issues SET updated_at = datetime('now'), acknowledged_at = NULL WHERE id = ?")
              .run(updated.parent_id);
            // Trigger controller to review and close parent
            triggerControllerOnDemand(updated.project_id, parentIssue.number, actorId);
          }
          // Broadcast parent update to frontend
          const refreshedParent = db.prepare('SELECT * FROM issues WHERE id = ?').get(updated.parent_id);
          broadcastToProject(updated.project_id, {
            type: 'issue_updated', projectId: updated.project_id,
            data: { issue: refreshedParent },
          });
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

      // Re-fetch to include any auto-assign changes
      const finalIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id);
      return finalIssue;
    }
  );

  // Delete issue (only open, no children)
  fastify.delete<{ Params: { id: string } }>('/api/issues/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id) as any;
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });
    if (issue.status !== 'open') {
      return reply.code(409).send({ error: 'Only open issues can be deleted' });
    }
    const childCount = (db.prepare('SELECT COUNT(*) as c FROM issues WHERE parent_id = ?').get(request.params.id) as any).c;
    if (childCount > 0) {
      return reply.code(409).send({ error: `Cannot delete: issue has ${childCount} child issue(s)` });
    }
    db.prepare('DELETE FROM issues WHERE id = ?').run(request.params.id);
    return { success: true };
  });

  // ─── Comments ───

  // List comments
  fastify.get<{ Params: { id: string } }>('/api/issues/:id/comments', async (request, reply) => {
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id);
    if (!access) return;
    return db.prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at').all(request.params.id);
  });

  // User notifications — open issues assigned to user + recent comments on user's issues
  // ?scope=user (default): only user-related issues & comments
  // ?scope=all: all issues & comments in accessible projects
  fastify.get('/api/notifications', async (request) => {
    const _nt0 = Date.now();
    const db = getDatabase();
    const { user, localhostBypass } = getProjectRequestContext(request);
    const projectIds = listAccessibleProjectIds(db, user, localhostBypass);
    if (projectIds.length === 0) {
      return { user_issues: [], recent_comments: [] };
    }
    const scope = (request.query as any)?.scope || 'user';
    const placeholders = buildSqlPlaceholders(projectIds);

    let userIssues: any[];
    let recentComments: any[];

    if (scope === 'all') {
      // All issues in accessible projects (non-closed)
      // Uses a CTE to find latest comment per issue (avoids 4x repeated correlated subqueries)
      userIssues = db.prepare(
        `WITH latest_comments AS (
           SELECT issue_id, body, author_id,
                  ROW_NUMBER() OVER (PARTITION BY issue_id ORDER BY created_at DESC) as rn
           FROM issue_comments
           WHERE event_type IS NULL OR event_type = 'comment'
         )
         SELECT i.*, p.name as project_name, p.color as project_color,
                CASE WHEN i.assigned_to = 'user' THEN 1 ELSE 0 END as is_actionable,
                lc.body as latest_comment_body,
                lc.author_id as latest_comment_author_id,
                lca.role as latest_comment_author_role,
                lca.name as latest_comment_author_name,
                aa.role as assigned_agent_role,
                aa.name as assigned_agent_name
         FROM issues i
         JOIN projects p ON i.project_id = p.id
         LEFT JOIN latest_comments lc ON lc.issue_id = i.id AND lc.rn = 1
         LEFT JOIN agents lca ON lca.id = lc.author_id
         LEFT JOIN agents aa ON aa.id = i.assigned_to
         WHERE i.project_id IN (${placeholders})
           AND i.status IN ('open', 'in_progress', 'pending', 'done')
         ORDER BY i.acknowledged_at IS NULL DESC, i.priority DESC, i.updated_at DESC`
      ).all(...projectIds);
      // All comments
      recentComments = db.prepare(
        `SELECT c.*, i.title as issue_title, i.number as issue_number, i.project_id, p.name as project_name
         FROM issue_comments c
         JOIN issues i ON c.issue_id = i.id
         JOIN projects p ON i.project_id = p.id
         WHERE i.project_id IN (${placeholders})
           AND c.author_id != 'user'
           AND (c.event_type IS NULL OR c.event_type = 'comment')
         ORDER BY c.created_at DESC
         LIMIT 50`
      ).all(...projectIds);
    } else {
      // scope=user: user-related (assigned or created), with is_actionable flag
      // Uses a CTE to find latest comment per issue (avoids 4x repeated correlated subqueries)
      userIssues = db.prepare(
        `WITH latest_comments AS (
           SELECT issue_id, body, author_id,
                  ROW_NUMBER() OVER (PARTITION BY issue_id ORDER BY created_at DESC) as rn
           FROM issue_comments
           WHERE event_type IS NULL OR event_type = 'comment'
         )
         SELECT i.*, p.name as project_name, p.color as project_color,
                CASE WHEN i.assigned_to = 'user' THEN 1 ELSE 0 END as is_actionable,
                lc.body as latest_comment_body,
                lc.author_id as latest_comment_author_id,
                lca.role as latest_comment_author_role,
                lca.name as latest_comment_author_name,
                aa.role as assigned_agent_role,
                aa.name as assigned_agent_name
         FROM issues i
         JOIN projects p ON i.project_id = p.id
         LEFT JOIN latest_comments lc ON lc.issue_id = i.id AND lc.rn = 1
         LEFT JOIN agents lca ON lca.id = lc.author_id
         LEFT JOIN agents aa ON aa.id = i.assigned_to
         WHERE i.project_id IN (${placeholders})
           AND (i.assigned_to = 'user' OR i.created_by = 'user')
           AND i.status IN ('open', 'in_progress', 'pending', 'done')
         ORDER BY i.acknowledged_at IS NULL DESC, i.priority DESC, i.updated_at DESC`
      ).all(...projectIds);
      // Only comments on user-related issues
      recentComments = db.prepare(
        `SELECT c.*, i.title as issue_title, i.number as issue_number, i.project_id, p.name as project_name
         FROM issue_comments c
         JOIN issues i ON c.issue_id = i.id
         JOIN projects p ON i.project_id = p.id
         WHERE i.project_id IN (${placeholders})
           AND c.author_id != 'user'
           AND (c.event_type IS NULL OR c.event_type = 'comment')
           AND (i.assigned_to = 'user' OR i.created_by = 'user')
         ORDER BY c.created_at DESC
         LIMIT 50`
      ).all(...projectIds);
    }

    const _ntTotal = Date.now() - _nt0;
    if (_ntTotal > 500) {
      logger.warn(`SLOW /api/notifications (${_ntTotal}ms) scope=${scope} issues=${(userIssues as any[]).length} comments=${(recentComments as any[]).length}`);
    }
    return { user_issues: userIssues, recent_comments: recentComments };
  });

  // My Issues — all issues the user is involved in (assigned, created, or commented)
  fastify.get('/api/my-issues', async (request) => {
    const db = getDatabase();
    const { user, localhostBypass } = getProjectRequestContext(request);
    const projectIds = listAccessibleProjectIds(db, user, localhostBypass);
    if (projectIds.length === 0) return [];
    const placeholders = buildSqlPlaceholders(projectIds);
    return db.prepare(`
      SELECT DISTINCT i.*, p.name as project_name FROM issues i
      JOIN projects p ON i.project_id = p.id
      WHERE i.project_id IN (${placeholders})
        AND (
          i.assigned_to = 'user'
          OR i.created_by = 'user'
          OR i.id IN (SELECT DISTINCT issue_id FROM issue_comments WHERE author_id = 'user')
        )
      ORDER BY i.updated_at DESC
      LIMIT 100
    `).all(...projectIds);
  });

  // Inbox search — search all issues by title, body, or number
  fastify.get<{ Querystring: { q?: string } }>('/api/inbox/search', async (request) => {
    const db = getDatabase();
    const q = (request.query.q || '').trim();
    if (!q) return [];
    const { user, localhostBypass } = getProjectRequestContext(request);
    const projectIds = listAccessibleProjectIds(db, user, localhostBypass);
    if (projectIds.length === 0) return [];
    const placeholders = buildSqlPlaceholders(projectIds);
    const like = `%${q}%`;
    return db.prepare(
      `SELECT i.*, p.name as project_name
       FROM issues i
       JOIN projects p ON i.project_id = p.id
       WHERE i.project_id IN (${placeholders})
         AND (i.title LIKE ? OR i.body LIKE ? OR CAST(i.number AS TEXT) LIKE ?)
       ORDER BY i.updated_at DESC
       LIMIT 200`
    ).all(...projectIds, like, like, like);
  });

  // Acknowledge issue (mark as read — hides from notifications)
  fastify.post<{ Params: { id: string } }>('/api/issues/:id/acknowledge', async (request, reply) => {
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id);
    if (!access) return;
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id);
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });
    db.prepare("UPDATE issues SET acknowledged_at = datetime('now') WHERE id = ?").run(request.params.id);
    return db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id);
  });

  // Unacknowledge issue (show again in notifications)
  fastify.post<{ Params: { id: string } }>('/api/issues/:id/unacknowledge', async (request, reply) => {
    const db = getDatabase();
    const access = ensureIssueAccess(db, request, reply, request.params.id);
    if (!access) return;
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
      const access = ensureIssueAccess(db, request, reply, request.params.id, true);
      if (!access) return;
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
          if (project && project.status !== 'paused') {
            if (agentToStart.is_controller) {
              const t = setTimeout(() => {
                pendingControllerTriggerTimers.delete(t);
                try { if (isDatabaseOpen()) triggerControllerAgent(project, false, iss.number); } catch {}
              }, 1000);
              pendingControllerTriggerTimers.add(t);
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
    const access = ensureCommentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const existing = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Comment not found' });
    db.prepare('UPDATE issue_comments SET body = ? WHERE id = ?').run(request.body.body, request.params.id);
    return db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(request.params.id);
  });

  // Delete comment
  fastify.delete<{ Params: { id: string } }>('/api/comments/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureCommentAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    const existing = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Comment not found' });
    db.prepare('DELETE FROM issue_comments WHERE id = ?').run(request.params.id);
    return { success: true };
  });

  // Get issue by project ID + number (with reactions + parent/children)
  fastify.get<{ Params: { pid: string; num: string } }>('/api/projects/:pid/issues/number/:num', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;
    const issue = db.prepare('SELECT * FROM issues WHERE project_id = ? AND number = ?').get(request.params.pid, parseInt(request.params.num)) as any;
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });
    const comments = db.prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at').all(issue.id) as any[];
    const reactions = db.prepare("SELECT * FROM reactions WHERE target_type = 'issue' AND target_id = ?").all(issue.id);
    // Batch-fetch all comment reactions in one query (fixes N+1)
    const cIds = comments.map(c => c.id);
    let cReactionsMap: Record<string, any[]> = {};
    if (cIds.length > 0) {
      const ph = cIds.map(() => '?').join(',');
      const allCReactions = db.prepare(`SELECT * FROM reactions WHERE target_type = 'comment' AND target_id IN (${ph})`).all(...cIds) as any[];
      for (const r of allCReactions) {
        (cReactionsMap[r.target_id] ||= []).push(r);
      }
    }
    const commentsWithReactions = comments.map(c => ({
      ...c,
      reactions: cReactionsMap[c.id] || [],
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

    // Relations for by-number endpoint
    const blocks2 = db.prepare(`
      SELECT r.id as relation_id, r.relation_type, r.created_by, r.created_at,
             i.id, i.number, i.title, i.status
      FROM issue_relations r JOIN issues i ON i.id = r.to_issue_id
      WHERE r.from_issue_id = ? AND r.relation_type = 'blocks'
    `).all(issue.id) as any[];
    const blocked_by2 = db.prepare(`
      SELECT r.id as relation_id, r.relation_type, r.created_by, r.created_at,
             i.id, i.number, i.title, i.status
      FROM issue_relations r JOIN issues i ON i.id = r.from_issue_id
      WHERE r.to_issue_id = ? AND r.relation_type = 'blocks'
    `).all(issue.id) as any[];
    const related_to2 = db.prepare(`
      SELECT r.id as relation_id, r.relation_type, r.created_by, r.created_at,
             i.id, i.number, i.title, i.status
      FROM issue_relations r JOIN issues i ON i.id = r.to_issue_id
      WHERE r.from_issue_id = ? AND r.relation_type = 'related_to'
      UNION
      SELECT r.id as relation_id, r.relation_type, r.created_by, r.created_at,
             i.id, i.number, i.title, i.status
      FROM issue_relations r JOIN issues i ON i.id = r.from_issue_id
      WHERE r.to_issue_id = ? AND r.relation_type = 'related_to'
    `).all(issue.id, issue.id) as any[];
    const is_blocked2 = blocked_by2.some((r: any) => !['done', 'closed'].includes(r.status));

    return { ...issue, comments: commentsWithReactions, reactions, parent_number, parent_title, children, blocks: blocks2, blocked_by: blocked_by2, related_to: related_to2, is_blocked: is_blocked2 };
  });

  // Also update GET /api/issues/:id to include reactions
  // (Override by adding reactions to response)

  // ─── Reactions ───

  fastify.post<{ Params: { type: string; id: string }; Body: { user_id: string; emoji: string } }>(
    '/api/reactions/:type/:id',
    async (request, reply) => {
      const db = getDatabase();
      if (request.params.type === 'issue') {
        const access = ensureIssueAccess(db, request, reply, request.params.id, true);
        if (!access) return;
      } else if (request.params.type === 'comment') {
        const access = ensureCommentAccess(db, request, reply, request.params.id, true);
        if (!access) return;
      } else {
        return reply.code(400).send({ error: 'Invalid reaction target type' });
      }
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

  fastify.get<{ Params: { type: string; id: string } }>('/api/reactions/:type/:id', async (request, reply) => {
    const db = getDatabase();
    if (request.params.type === 'issue') {
      const access = ensureIssueAccess(db, request, reply, request.params.id);
      if (!access) return;
    } else if (request.params.type === 'comment') {
      const access = ensureCommentAccess(db, request, reply, request.params.id);
      if (!access) return;
    } else {
      return reply.code(400).send({ error: 'Invalid reaction target type' });
    }
    return db.prepare('SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users FROM reactions WHERE target_type = ? AND target_id = ? GROUP BY emoji')
      .all(request.params.type, request.params.id);
  });

  // ─── Milestones ───

  fastify.get<{ Params: { pid: string } }>('/api/projects/:pid/milestones', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;
    const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY created_at DESC').all(request.params.pid) as any[];
    if (milestones.length === 0) return milestones;
    // Batch-fetch progress for all milestones in one query (avoids 2 queries per milestone)
    const mIds = milestones.map((m: any) => m.id);
    const ph = mIds.map(() => '?').join(',');
    const stats = db.prepare(
      `SELECT milestone_id, COUNT(*) as total,
              SUM(CASE WHEN status IN ('done','closed') THEN 1 ELSE 0 END) as closed
       FROM issues WHERE milestone_id IN (${ph}) GROUP BY milestone_id`
    ).all(...mIds) as any[];
    const statsMap = new Map(stats.map((s: any) => [s.milestone_id, s]));
    return milestones.map((m: any) => {
      const s = statsMap.get(m.id);
      const total = s?.total || 0;
      const closed = s?.closed || 0;
      return { ...m, total_issues: total, closed_issues: closed, progress: total > 0 ? Math.round(closed / total * 100) : 0 };
    });
  });

  fastify.post<{ Params: { pid: string }; Body: { title: string; description?: string; due_date?: string } }>(
    '/api/projects/:pid/milestones',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureProjectAccess(db, request, reply, request.params.pid, true);
      if (!access) return;
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
      const access = ensureMilestoneAccess(db, request, reply, request.params.id, true);
      if (!access) return;
      const { title, description, due_date, status } = request.body;
      db.prepare('UPDATE milestones SET title = COALESCE(?, title), description = COALESCE(?, description), due_date = COALESCE(?, due_date), status = COALESCE(?, status) WHERE id = ?')
        .run(title ?? null, description ?? null, due_date ?? null, status ?? null, request.params.id);
      return db.prepare('SELECT * FROM milestones WHERE id = ?').get(request.params.id);
    }
  );

  fastify.delete<{ Params: { id: string } }>('/api/milestones/:id', async (request, reply) => {
    const db = getDatabase();
    const access = ensureMilestoneAccess(db, request, reply, request.params.id, true);
    if (!access) return;
    db.prepare('UPDATE issues SET milestone_id = NULL WHERE milestone_id = ?').run(request.params.id);
    db.prepare('DELETE FROM milestones WHERE id = ?').run(request.params.id);
    return { success: true };
  });

  // ─── Search ───

  fastify.get<{ Params: { pid: string }; Querystring: { q: string } }>('/api/projects/:pid/search', async (request, reply) => {
    const db = getDatabase();
    const access = ensureProjectAccess(db, request, reply, request.params.pid);
    if (!access) return;
    const q = `%${request.query.q}%`;
    const issues = db.prepare('SELECT * FROM issues WHERE project_id = ? AND (title LIKE ? OR body LIKE ?) ORDER BY updated_at DESC LIMIT 50')
      .all(request.params.pid, q, q);
    const comments = db.prepare("SELECT c.*, i.number as issue_number, i.title as issue_title FROM issue_comments c JOIN issues i ON c.issue_id = i.id WHERE i.project_id = ? AND c.body LIKE ? AND c.event_type = 'comment' ORDER BY c.created_at DESC LIMIT 20")
      .all(request.params.pid, q);
    return { issues, comments };
  });

  // ─── Issue Relations ───

  // Add relation
  fastify.post<{ Params: { id: string }; Body: { type: string; target_issue_id: string; actor?: string } }>(
    '/api/issues/:id/relations',
    async (request, reply) => {
      const db = getDatabase();
      const sourceAccess = ensureIssueAccess(db, request, reply, request.params.id, true);
      if (!sourceAccess) return;
      const { id: fromId } = request.params;
      const { type: relationType, target_issue_id: toId, actor } = request.body as any;

      if (!relationType || !toId) {
        return reply.code(400).send({ error: 'type and target_issue_id are required' });
      }
      if (!['blocks', 'related_to'].includes(relationType)) {
        return reply.code(400).send({ error: 'type must be blocks or related_to' });
      }
      if (fromId === toId) {
        return reply.code(400).send({ error: 'Cannot create relation to self' });
      }

      const fromIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(fromId) as any;
      const toIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(toId) as any;
      if (!fromIssue) return reply.code(404).send({ error: 'Source issue not found' });
      if (!toIssue) return reply.code(404).send({ error: 'Target issue not found' });
      if (toIssue.project_id !== fromIssue.project_id || toIssue.project_id !== sourceAccess.entity.project_id) {
        return reply.code(400).send({ error: 'Target issue must belong to the same project' });
      }

      const relId = uuidv4();
      try {
        db.prepare(
          'INSERT INTO issue_relations (id, from_issue_id, to_issue_id, relation_type, created_by) VALUES (?, ?, ?, ?, ?)'
        ).run(relId, fromId, toId, relationType, actor || 'user');
      } catch {
        return reply.code(409).send({ error: 'Relation already exists' });
      }

      // Record event on both issues
      const eventStmt = db.prepare('INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)');
      const actorId = actor || 'user';
      if (relationType === 'blocks') {
        eventStmt.run(uuidv4(), fromId, actorId, `added blocks dependency on #${toIssue.number}`, 'status_change',
          JSON.stringify({ relation: 'blocks', target: toId, target_number: toIssue.number }));
        eventStmt.run(uuidv4(), toId, actorId, `marked as blocked by #${fromIssue.number}`, 'status_change',
          JSON.stringify({ relation: 'blocked_by', source: fromId, source_number: fromIssue.number }));
      } else {
        eventStmt.run(uuidv4(), fromId, actorId, `linked as related to #${toIssue.number}`, 'status_change',
          JSON.stringify({ relation: 'related_to', target: toId, target_number: toIssue.number }));
      }

      broadcastToProject(fromIssue.project_id, {
        type: 'issue_updated', projectId: fromIssue.project_id,
        data: { issue: db.prepare('SELECT * FROM issues WHERE id = ?').get(fromId) },
      });

      const relation = db.prepare('SELECT * FROM issue_relations WHERE id = ?').get(relId);
      return reply.code(201).send(relation);
    }
  );

  // Delete relation
  fastify.delete<{ Params: { id: string; relationId: string } }>(
    '/api/issues/:id/relations/:relationId',
    async (request, reply) => {
      const db = getDatabase();
      const issueAccess = ensureIssueAccess(db, request, reply, request.params.id, true);
      if (!issueAccess) return;
      const relationAccess = ensureRelationAccess(db, request, reply, request.params.relationId, true);
      if (!relationAccess) return;
      if (relationAccess.entity.from_issue_id !== request.params.id && relationAccess.entity.to_issue_id !== request.params.id) {
        return reply.code(404).send({ error: 'Relation not found' });
      }
      const relation = db.prepare('SELECT * FROM issue_relations WHERE id = ?').get(request.params.relationId) as any;
      if (!relation) return reply.code(404).send({ error: 'Relation not found' });

      db.prepare('DELETE FROM issue_relations WHERE id = ?').run(request.params.relationId);

      const fromIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(relation.from_issue_id) as any;
      if (fromIssue) {
        broadcastToProject(fromIssue.project_id, {
          type: 'issue_updated', projectId: fromIssue.project_id,
          data: { issue: fromIssue },
        });
      }

      return { success: true };
    }
  );

  // List relations for an issue
  fastify.get<{ Params: { id: string } }>(
    '/api/issues/:id/relations',
    async (request, reply) => {
      const db = getDatabase();
      const access = ensureIssueAccess(db, request, reply, request.params.id);
      if (!access) return;
      const issueId = request.params.id;

      const blocks = db.prepare(`
        SELECT r.*, i.number as target_number, i.title as target_title, i.status as target_status
        FROM issue_relations r JOIN issues i ON i.id = r.to_issue_id
        WHERE r.from_issue_id = ? AND r.relation_type = 'blocks'
      `).all(issueId);

      const blocked_by = db.prepare(`
        SELECT r.*, i.number as source_number, i.title as source_title, i.status as source_status
        FROM issue_relations r JOIN issues i ON i.id = r.from_issue_id
        WHERE r.to_issue_id = ? AND r.relation_type = 'blocks'
      `).all(issueId);

      const related_to = db.prepare(`
        SELECT r.*, i.number as other_number, i.title as other_title, i.status as other_status
        FROM issue_relations r JOIN issues i ON i.id = r.to_issue_id
        WHERE r.from_issue_id = ? AND r.relation_type = 'related_to'
        UNION
        SELECT r.*, i.number as other_number, i.title as other_title, i.status as other_status
        FROM issue_relations r JOIN issues i ON i.id = r.from_issue_id
        WHERE r.to_issue_id = ? AND r.relation_type = 'related_to'
      `).all(issueId, issueId);

      const is_blocked = (blocked_by as any[]).some(r => !['done', 'closed'].includes(r.source_status));

      return { blocks, blocked_by, related_to, is_blocked };
    }
  );

}
