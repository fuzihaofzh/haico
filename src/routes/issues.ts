import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { Agent, Project } from '../types';
import { startAgentProcess, isAgentRunning } from '../services/process-manager';
import { buildSystemPrompt } from '../services/system-prompt';
import { triggerControllerAgent } from '../services/controller';
import { broadcastToProject } from '../services/websocket';

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

      let sql = 'SELECT * FROM issues WHERE project_id = ?';
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
      const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
      const total = (db.prepare(countSql).get(...params) as any)?.total || 0;

      sql += ` LIMIT ${limit} OFFSET ${offset}`;
      const issues = db.prepare(sql).all(...params);

      return { issues, total, page: Math.floor(offset / limit) + 1, per_page: limit, total_pages: Math.ceil(total / limit) };
    }
  );

  // Create issue
  fastify.post<{ Params: { pid: string }; Body: { title: string; body?: string; created_by: string; assigned_to?: string; labels?: string } }>(
    '/api/projects/:pid/issues',
    async (request, reply) => {
      const { title, body, created_by, assigned_to, labels } = request.body;
      if (!title || !created_by) {
        return reply.code(400).send({ error: 'title and created_by are required' });
      }

      const db = getDatabase();
      const id = uuidv4();
      const priority = resolvePriority(created_by, request.params.pid);

      // Auto-increment number per project
      const last = db.prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?').get(request.params.pid) as { n: number | null };
      const number = (last?.n || 0) + 1;

      db.prepare(`
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, labels, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `).run(id, request.params.pid, number, title, body || '', created_by, assigned_to || null, priority, labels || '');

      const created = db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as any;

      broadcastToProject(request.params.pid, {
        type: 'issue_created', projectId: request.params.pid,
        data: { issue: created },
      });

      // Auto-start assigned agent when user creates issue
      if (created_by === 'user' && assigned_to && assigned_to !== 'user' && assigned_to !== 'all') {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(assigned_to) as Agent | undefined;
        if (agent && agent.status !== 'running' && !isAgentRunning(agent.id)) {
          const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.pid) as Project | undefined;
          if (project) {
            const prompt = `New issue #${number} "${title}" has been assigned to you. Review and take action.\n\nDescription: ${(body || '').slice(0, 500)}`;
            const isRaw = /^\s*(bash|sh|zsh)\s+-c\b/.test(project.command_template);
            const fullPrompt = isRaw ? prompt : buildSystemPrompt(agent, project) + prompt;
            startAgentProcess(agent, fullPrompt, project.command_template);
          }
        }
      } else if (created_by === 'user' && (!assigned_to || assigned_to === 'all')) {
        // Trigger controller for unassigned/broadcast issues
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.pid) as Project | undefined;
        if (project) setTimeout(() => { try { triggerControllerAgent(project); } catch {} }, 1000);
      }

      return reply.code(201).send(created);
    }
  );

  // Get issue detail (with comments + reactions)
  fastify.get<{ Params: { id: string } }>('/api/issues/:id', async (request, reply) => {
    const db = getDatabase();
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id);
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });

    const comments = db.prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at').all(request.params.id);
    const reactions = db.prepare("SELECT * FROM reactions WHERE target_type = 'issue' AND target_id = ?").all(request.params.id);
    const commentsWithReactions = (comments as any[]).map(c => ({
      ...c,
      reactions: db.prepare("SELECT * FROM reactions WHERE target_type = 'comment' AND target_id = ?").all(c.id),
    }));
    return { ...issue as any, comments: commentsWithReactions, reactions };
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

      if (status && !['open', 'in_progress', 'done', 'closed'].includes(status)) {
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

      db.prepare(`
        UPDATE issues SET
          title = COALESCE(?, title),
          body = COALESCE(?, body),
          assigned_to = COALESCE(?, assigned_to),
          status = COALESCE(?, status),
          labels = COALESCE(?, labels),
          milestone_id = COALESCE(?, milestone_id),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(title ?? null, body ?? null, assigned_to ?? null, status ?? null, labels ?? null, milestone_id ?? null, request.params.id);

      const updated = db.prepare('SELECT * FROM issues WHERE id = ?').get(request.params.id) as any;

      broadcastToProject(updated.project_id, {
        type: 'issue_updated', projectId: updated.project_id,
        data: { issue: updated },
      });

      // Auto-start agent when user assigns an issue to them
      if (actorId === 'user' && assigned_to && assigned_to !== existing.assigned_to && assigned_to !== 'user' && assigned_to !== 'all') {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(assigned_to) as Agent | undefined;
        if (agent && agent.status !== 'running' && !isAgentRunning(agent.id)) {
          const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(updated.project_id) as Project | undefined;
          if (project) {
            const prompt = `You have been assigned issue #${updated.number} "${updated.title}". Review it and take action.\n\nDescription: ${updated.body?.slice(0, 500) || '(none)'}`;
            const isRaw = /^\s*(bash|sh|zsh)\s+-c\b/.test(project.command_template);
            const fullPrompt = isRaw ? prompt : buildSystemPrompt(agent, project) + prompt;
            startAgentProcess(agent, fullPrompt, project.command_template);
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
      "SELECT i.*, p.name as project_name FROM issues i JOIN projects p ON i.project_id = p.id WHERE i.assigned_to = 'user' AND i.status IN ('open', 'in_progress') ORDER BY i.priority DESC, i.updated_at DESC"
    ).all() as any[];

    // Recent comments on any issue (last 20)
    const recentComments = db.prepare(
      "SELECT c.*, i.title as issue_title, i.number as issue_number, i.project_id FROM issue_comments c JOIN issues i ON c.issue_id = i.id WHERE c.author_id != 'user' ORDER BY c.created_at DESC LIMIT 20"
    ).all() as any[];

    return { user_issues: userIssues, recent_comments: recentComments };
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

      // Update issue timestamp
      db.prepare("UPDATE issues SET updated_at = datetime('now') WHERE id = ?").run(request.params.id);

      const comment = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(id);
      const iss = issue as any;

      broadcastToProject(iss.project_id, {
        type: 'comment_added', projectId: iss.project_id,
        data: { comment, issueId: request.params.id, issueNumber: iss.number },
      });

      // If user commented, auto-start the assigned agent to check the issue
      if (author_id === 'user') {
        if (iss.assigned_to && iss.assigned_to !== 'user' && iss.assigned_to !== 'all') {
          // Start the assigned agent
          const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(iss.assigned_to) as Agent | undefined;
          if (agent && agent.status !== 'running' && !isAgentRunning(agent.id)) {
            const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(iss.project_id) as Project | undefined;
            if (project) {
              const prompt = `User just commented on issue #${iss.number} "${iss.title}" assigned to you. Review the comment and respond.\n\nComment: ${body}`;
              const isRawShell = /^\s*(bash|sh|zsh)\s+-c\b/.test(project.command_template);
              const fullPrompt = isRawShell ? prompt : buildSystemPrompt(agent, project) + prompt;
              startAgentProcess(agent, fullPrompt, project.command_template);
            }
          }
        } else if (iss.assigned_to === 'all' || !iss.assigned_to) {
          // Trigger controller to handle user comment
          const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(iss.project_id) as Project | undefined;
          if (project) {
            setTimeout(() => { try { triggerControllerAgent(project); } catch {} }, 1000);
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

  // Get issue by project ID + number (with reactions)
  fastify.get<{ Params: { pid: string; num: string } }>('/api/projects/:pid/issues/number/:num', async (request, reply) => {
    const db = getDatabase();
    const issue = db.prepare('SELECT * FROM issues WHERE project_id = ? AND number = ?').get(request.params.pid, parseInt(request.params.num));
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });
    const comments = db.prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at').all((issue as any).id);
    const reactions = db.prepare("SELECT * FROM reactions WHERE target_type = 'issue' AND target_id = ?").all((issue as any).id);
    // Add reactions per comment
    const commentsWithReactions = (comments as any[]).map(c => ({
      ...c,
      reactions: db.prepare("SELECT * FROM reactions WHERE target_type = 'comment' AND target_id = ?").all(c.id),
    }));
    return { ...issue as any, comments: commentsWithReactions, reactions };
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
