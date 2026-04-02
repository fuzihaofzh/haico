import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { ApprovalRequest } from '../types';
import { broadcastToProject } from '../services/websocket';
import {
  ensureProjectAccess,
  getProjectRequestContext,
  listAccessibleProjectIds,
} from '../services/project-permissions';

export function registerApprovalRoutes(fastify: FastifyInstance): void {

  // List approval requests for a project
  fastify.get<{ Params: { pid: string }; Querystring: { status?: string; limit?: string } }>(
    '/api/projects/:pid/approvals',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const status = request.query.status;
      const limit = Math.min(parseInt(request.query.limit || '50', 10), 200);

      let rows: any[];
      if (status) {
        rows = db.prepare(
          `SELECT ar.*, a.name as agent_name, i.number as issue_number, i.title as issue_title
           FROM approval_requests ar
           LEFT JOIN agents a ON ar.agent_id = a.id
           LEFT JOIN issues i ON ar.issue_id = i.id
           WHERE ar.project_id = ? AND ar.status = ?
           ORDER BY ar.created_at DESC LIMIT ?`
        ).all(pid, status, limit);
      } else {
        rows = db.prepare(
          `SELECT ar.*, a.name as agent_name, i.number as issue_number, i.title as issue_title
           FROM approval_requests ar
           LEFT JOIN agents a ON ar.agent_id = a.id
           LEFT JOIN issues i ON ar.issue_id = i.id
           WHERE ar.project_id = ?
           ORDER BY ar.created_at DESC LIMIT ?`
        ).all(pid, limit);
      }
      return rows;
    }
  );

  // Get pending approval count across all accessible projects (for dashboard badge)
  fastify.get('/api/approvals/pending-count', async (request) => {
    const db = getDatabase();
    const { user, localhostBypass } = getProjectRequestContext(request);
    const projectIds = listAccessibleProjectIds(db, user, localhostBypass);
    if (projectIds.length === 0) return { count: 0 };

    const placeholders = projectIds.map(() => '?').join(', ');
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM approval_requests WHERE project_id IN (${placeholders}) AND status = 'pending'`
    ).get(...projectIds) as any;
    return { count: row?.count || 0 };
  });

  // Create approval request (called by agents)
  fastify.post<{ Params: { pid: string }; Body: any }>(
    '/api/projects/:pid/approvals',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const { agent_id, title, description, risk_level, issue_id } = request.body as any;

      if (!agent_id || !title) {
        return reply.code(400).send({ error: 'agent_id and title are required' });
      }

      // Verify agent belongs to this project
      const agent = db.prepare('SELECT id, name FROM agents WHERE id = ? AND project_id = ?').get(agent_id, pid) as any;
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found in this project' });
      }

      const id = uuidv4();
      const validRisk = ['low', 'medium', 'high', 'critical'].includes(risk_level) ? risk_level : 'medium';

      db.prepare(
        `INSERT INTO approval_requests (id, project_id, issue_id, agent_id, title, description, risk_level)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, pid, issue_id || null, agent_id, title, description || '', validRisk);

      const created = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as ApprovalRequest;

      broadcastToProject(pid, {
        type: 'approval_created',
        projectId: pid,
        data: { ...created, agent_name: agent.name },
      });

      return reply.code(201).send(created);
    }
  );

  // Decide on an approval request (approve/reject)
  fastify.put<{ Params: { id: string }; Body: any }>(
    '/api/approvals/:id',
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;
      const { status, decision_note, decided_by } = request.body as any;

      if (!status || !['approved', 'rejected'].includes(status)) {
        return reply.code(400).send({ error: 'status must be approved or rejected' });
      }

      const existing = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as ApprovalRequest | undefined;
      if (!existing) {
        return reply.code(404).send({ error: 'Approval request not found' });
      }
      if (existing.status !== 'pending') {
        return reply.code(409).send({ error: 'Approval has already been decided' });
      }

      db.prepare(
        `UPDATE approval_requests SET status = ?, decided_by = ?, decision_note = ?, decided_at = datetime('now') WHERE id = ?`
      ).run(status, decided_by || 'user', decision_note || '', id);

      const updated = db.prepare(
        `SELECT ar.*, a.name as agent_name
         FROM approval_requests ar
         LEFT JOIN agents a ON ar.agent_id = a.id
         WHERE ar.id = ?`
      ).get(id) as any;

      broadcastToProject(existing.project_id, {
        type: 'approval_decided',
        projectId: existing.project_id,
        data: updated,
      });

      return updated;
    }
  );

  // Get single approval request detail
  fastify.get<{ Params: { id: string } }>(
    '/api/approvals/:id',
    async (request, reply) => {
      const db = getDatabase();
      const { id } = request.params;

      const row = db.prepare(
        `SELECT ar.*, a.name as agent_name, i.number as issue_number, i.title as issue_title
         FROM approval_requests ar
         LEFT JOIN agents a ON ar.agent_id = a.id
         LEFT JOIN issues i ON ar.issue_id = i.id
         WHERE ar.id = ?`
      ).get(id) as any;

      if (!row) {
        return reply.code(404).send({ error: 'Approval request not found' });
      }
      return row;
    }
  );

  // Workflow status API — returns agents with their current issues and collaboration data
  fastify.get<{ Params: { pid: string } }>(
    '/api/projects/:pid/workflow-status',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      // Get all agents with their current assigned issues
      const agents = db.prepare(
        `SELECT id, name, role, is_controller, parent_agent_id, status, paused, started_at, finished_at
         FROM agents WHERE project_id = ?`
      ).all(pid) as any[];

      const agentIds = agents.map((a: any) => a.id);

      // Get active issues assigned to each agent
      const activeIssues = agentIds.length > 0
        ? db.prepare(
          `SELECT id, number, title, status, assigned_to, priority, labels
           FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress', 'pending')
           ORDER BY priority DESC`
        ).all(pid) as any[]
        : [];

      // Get recent messages between agents (last 20)
      const recentMessages = db.prepare(
        `SELECT from_agent_id, to_agent_id, subject, created_at
         FROM agent_messages WHERE project_id = ?
         ORDER BY created_at DESC LIMIT 20`
      ).all(pid) as any[];

      // Get pending approvals
      const pendingApprovals = db.prepare(
        `SELECT ar.id, ar.title, ar.risk_level, ar.agent_id, ar.created_at, a.name as agent_name
         FROM approval_requests ar
         LEFT JOIN agents a ON ar.agent_id = a.id
         WHERE ar.project_id = ? AND ar.status = 'pending'
         ORDER BY ar.created_at DESC`
      ).all(pid) as any[];

      // Build issue map per agent
      const issuesByAgent: Record<string, any[]> = {};
      for (const issue of activeIssues) {
        const aid = issue.assigned_to;
        if (aid) {
          if (!issuesByAgent[aid]) issuesByAgent[aid] = [];
          issuesByAgent[aid].push(issue);
        }
      }

      return {
        agents: agents.map((a: any) => ({
          ...a,
          current_issues: issuesByAgent[a.id] || [],
        })),
        recent_messages: recentMessages,
        pending_approvals: pendingApprovals,
        total_active_issues: activeIssues.length,
      };
    }
  );
}
