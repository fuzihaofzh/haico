import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { ExecutiveSummary, ExecutiveSummaryBlock } from '../types';
import { broadcastToProject } from '../services/websocket';
import {
  ensureProjectAccess,
  getProjectRequestContext,
} from '../services/project-permissions';

interface SummaryRow {
  id: string;
  project_id: string;
  title: string;
  period_start: string;
  period_end: string;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface BlockRow {
  id: string;
  summary_id: string;
  block_key: string;
  title: string;
  content: string;
  order_index: number;
}

function attachBlocks(db: ReturnType<typeof getDatabase>, summaryId: string): ExecutiveSummaryBlock[] {
  const rows = db.prepare(
    `SELECT id, block_key, title, content, order_index
     FROM executive_summary_blocks
     WHERE summary_id = ?
     ORDER BY order_index`
  ).all(summaryId) as BlockRow[];
  return rows.map((r) => ({
    id: r.id,
    key: r.block_key,
    title: r.title,
    content: r.content,
    order_index: r.order_index,
  }));
}

function serializeSummary(db: ReturnType<typeof getDatabase>, row: SummaryRow): ExecutiveSummary {
  return {
    ...row,
    status: row.status as ExecutiveSummary['status'],
    blocks: attachBlocks(db, row.id),
  };
}

/** Default block templates for a weekly treasury review. */
const DEFAULT_BLOCK_TEMPLATES: Array<{ key: string; title: string; placeholder: string }> = [
  {
    key: 'cash_position',
    title: 'Cash Position Overview',
    placeholder: 'Summarize opening/closing balances, net change, and key movements across entities.',
  },
  {
    key: 'payment_activity',
    title: 'Payment Activity',
    placeholder: 'Total payment volume and value, approval turnaround, rejected/escalated items.',
  },
  {
    key: 'liquidity_alerts',
    title: 'Liquidity Alerts',
    placeholder: 'Alerts triggered during the period: threshold breaches, forecast deviations, counterparty issues.',
  },
  {
    key: 'forecast_variance',
    title: 'Forecast vs. Actual Variance',
    placeholder: 'Highlight material variances between forecasted and actual cash flows with root-cause notes.',
  },
  {
    key: 'risk_compliance',
    title: 'Risk & Compliance',
    placeholder: 'FX exposure changes, counterparty limit usage, policy exceptions or audit findings.',
  },
  {
    key: 'action_items',
    title: 'Action Items & Next Steps',
    placeholder: 'Carry-forward items, upcoming maturities, decisions required before next review.',
  },
];

export function registerExecutiveSummaryRoutes(fastify: FastifyInstance): void {

  // List executive summaries for a project
  fastify.get<{
    Params: { pid: string };
    Querystring: { status?: string; limit?: string; offset?: string };
  }>(
    '/api/projects/:pid/executive-summaries',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const status = request.query.status;
      const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);
      const offset = parseInt(request.query.offset || '0', 10);

      let rows: SummaryRow[];
      if (status) {
        rows = db.prepare(
          `SELECT * FROM executive_summaries
           WHERE project_id = ? AND status = ?
           ORDER BY period_end DESC, created_at DESC
           LIMIT ? OFFSET ?`
        ).all(pid, status, limit, offset) as SummaryRow[];
      } else {
        rows = db.prepare(
          `SELECT * FROM executive_summaries
           WHERE project_id = ?
           ORDER BY period_end DESC, created_at DESC
           LIMIT ? OFFSET ?`
        ).all(pid, limit, offset) as SummaryRow[];
      }

      const total = (db.prepare(
        `SELECT COUNT(*) as count FROM executive_summaries WHERE project_id = ?${status ? ' AND status = ?' : ''}`
      ).get(...(status ? [pid, status] : [pid])) as { count: number }).count;

      return {
        summaries: rows.map((r) => serializeSummary(db, r)),
        total,
        limit,
        offset,
      };
    }
  );

  // Get a single executive summary by ID
  fastify.get<{ Params: { pid: string; sid: string } }>(
    '/api/projects/:pid/executive-summaries/:sid',
    async (request, reply) => {
      const db = getDatabase();
      const { pid, sid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const row = db.prepare(
        'SELECT * FROM executive_summaries WHERE id = ? AND project_id = ?'
      ).get(sid, pid) as SummaryRow | undefined;

      if (!row) {
        return reply.code(404).send({ error: 'Executive summary not found' });
      }
      return serializeSummary(db, row);
    }
  );

  // Create a new executive summary with default block templates
  fastify.post<{ Params: { pid: string }; Body: any }>(
    '/api/projects/:pid/executive-summaries',
    async (request, reply) => {
      const db = getDatabase();
      const { pid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const { title, period_start, period_end, created_by } = request.body as any;

      if (!title || !period_start || !period_end) {
        return reply.code(400).send({ error: 'title, period_start, and period_end are required' });
      }

      const id = uuidv4();
      const author = created_by || 'user';

      db.prepare(
        `INSERT INTO executive_summaries (id, project_id, title, period_start, period_end, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'draft', ?)`
      ).run(id, pid, title, period_start, period_end, author);

      // Seed default blocks
      const insertBlock = db.prepare(
        `INSERT INTO executive_summary_blocks (id, summary_id, block_key, title, content, order_index)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (let i = 0; i < DEFAULT_BLOCK_TEMPLATES.length; i++) {
        const tpl = DEFAULT_BLOCK_TEMPLATES[i];
        insertBlock.run(uuidv4(), id, tpl.key, tpl.title, tpl.placeholder, i);
      }

      const created = db.prepare('SELECT * FROM executive_summaries WHERE id = ?').get(id) as SummaryRow;
      const result = serializeSummary(db, created);

      broadcastToProject(pid, {
        type: 'executive_summary_created',
        projectId: pid,
        data: result,
      });

      return reply.code(201).send(result);
    }
  );

  // Update executive summary metadata (title, status, period)
  fastify.put<{ Params: { pid: string; sid: string }; Body: any }>(
    '/api/projects/:pid/executive-summaries/:sid',
    async (request, reply) => {
      const db = getDatabase();
      const { pid, sid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const existing = db.prepare(
        'SELECT * FROM executive_summaries WHERE id = ? AND project_id = ?'
      ).get(sid, pid) as SummaryRow | undefined;
      if (!existing) {
        return reply.code(404).send({ error: 'Executive summary not found' });
      }

      const body = request.body as Record<string, unknown>;
      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.title !== undefined) { updates.push('title = ?'); values.push(body.title); }
      if (body.period_start !== undefined) { updates.push('period_start = ?'); values.push(body.period_start); }
      if (body.period_end !== undefined) { updates.push('period_end = ?'); values.push(body.period_end); }
      if (body.status !== undefined) {
        const validStatuses = ['draft', 'final', 'archived'];
        if (!validStatuses.includes(body.status as string)) {
          return reply.code(400).send({ error: `status must be one of: ${validStatuses.join(', ')}` });
        }
        updates.push('status = ?'); values.push(body.status);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: 'No valid fields to update' });
      }

      updates.push("updated_at = datetime('now')");
      values.push(sid, pid);

      db.prepare(
        `UPDATE executive_summaries SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`
      ).run(...values);

      const updated = db.prepare('SELECT * FROM executive_summaries WHERE id = ?').get(sid) as SummaryRow;
      const result = serializeSummary(db, updated);

      broadcastToProject(pid, {
        type: 'executive_summary_updated',
        projectId: pid,
        data: result,
      });

      return result;
    }
  );

  // Delete an executive summary
  fastify.delete<{ Params: { pid: string; sid: string } }>(
    '/api/projects/:pid/executive-summaries/:sid',
    async (request, reply) => {
      const db = getDatabase();
      const { pid, sid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const existing = db.prepare(
        'SELECT id FROM executive_summaries WHERE id = ? AND project_id = ?'
      ).get(sid, pid);
      if (!existing) {
        return reply.code(404).send({ error: 'Executive summary not found' });
      }

      // Blocks are cascade-deleted via FK
      db.prepare('DELETE FROM executive_summaries WHERE id = ?').run(sid);

      broadcastToProject(pid, {
        type: 'executive_summary_deleted',
        projectId: pid,
        data: { id: sid },
      });

      return { ok: true };
    }
  );

  // Update a single block within a summary
  fastify.put<{ Params: { pid: string; sid: string; bid: string }; Body: any }>(
    '/api/projects/:pid/executive-summaries/:sid/blocks/:bid',
    async (request, reply) => {
      const db = getDatabase();
      const { pid, sid, bid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      // Verify summary belongs to project
      const summary = db.prepare(
        'SELECT id FROM executive_summaries WHERE id = ? AND project_id = ?'
      ).get(sid, pid);
      if (!summary) {
        return reply.code(404).send({ error: 'Executive summary not found' });
      }

      const block = db.prepare(
        'SELECT * FROM executive_summary_blocks WHERE id = ? AND summary_id = ?'
      ).get(bid, sid) as BlockRow | undefined;
      if (!block) {
        return reply.code(404).send({ error: 'Block not found' });
      }

      const body = request.body as Record<string, unknown>;
      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.title !== undefined) { updates.push('title = ?'); values.push(body.title); }
      if (body.content !== undefined) { updates.push('content = ?'); values.push(body.content); }
      if (body.order_index !== undefined) { updates.push('order_index = ?'); values.push(body.order_index); }

      if (updates.length === 0) {
        return reply.code(400).send({ error: 'No valid fields to update' });
      }

      values.push(bid);
      db.prepare(
        `UPDATE executive_summary_blocks SET ${updates.join(', ')} WHERE id = ?`
      ).run(...values);

      // Touch the parent summary timestamp
      db.prepare("UPDATE executive_summaries SET updated_at = datetime('now') WHERE id = ?").run(sid);

      const updated = db.prepare('SELECT * FROM executive_summary_blocks WHERE id = ?').get(bid) as BlockRow;

      broadcastToProject(pid, {
        type: 'executive_summary_block_updated',
        projectId: pid,
        data: { summary_id: sid, block: updated },
      });

      return {
        id: updated.id,
        key: updated.block_key,
        title: updated.title,
        content: updated.content,
        order_index: updated.order_index,
      };
    }
  );

  // Add a custom block to a summary
  fastify.post<{ Params: { pid: string; sid: string }; Body: any }>(
    '/api/projects/:pid/executive-summaries/:sid/blocks',
    async (request, reply) => {
      const db = getDatabase();
      const { pid, sid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const summary = db.prepare(
        'SELECT id FROM executive_summaries WHERE id = ? AND project_id = ?'
      ).get(sid, pid);
      if (!summary) {
        return reply.code(404).send({ error: 'Executive summary not found' });
      }

      const { key, title, content } = request.body as any;
      if (!key || !title) {
        return reply.code(400).send({ error: 'key and title are required' });
      }

      // Determine next order_index
      const maxOrder = db.prepare(
        'SELECT MAX(order_index) as max_idx FROM executive_summary_blocks WHERE summary_id = ?'
      ).get(sid) as { max_idx: number | null };
      const nextIndex = (maxOrder.max_idx ?? -1) + 1;

      const id = uuidv4();
      db.prepare(
        `INSERT INTO executive_summary_blocks (id, summary_id, block_key, title, content, order_index)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, sid, key, title, content || '', nextIndex);

      db.prepare("UPDATE executive_summaries SET updated_at = datetime('now') WHERE id = ?").run(sid);

      const created = db.prepare('SELECT * FROM executive_summary_blocks WHERE id = ?').get(id) as BlockRow;

      return reply.code(201).send({
        id: created.id,
        key: created.block_key,
        title: created.title,
        content: created.content,
        order_index: created.order_index,
      });
    }
  );

  // Delete a block from a summary
  fastify.delete<{ Params: { pid: string; sid: string; bid: string } }>(
    '/api/projects/:pid/executive-summaries/:sid/blocks/:bid',
    async (request, reply) => {
      const db = getDatabase();
      const { pid, sid, bid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const summary = db.prepare(
        'SELECT id FROM executive_summaries WHERE id = ? AND project_id = ?'
      ).get(sid, pid);
      if (!summary) {
        return reply.code(404).send({ error: 'Executive summary not found' });
      }

      const block = db.prepare(
        'SELECT id FROM executive_summary_blocks WHERE id = ? AND summary_id = ?'
      ).get(bid, sid);
      if (!block) {
        return reply.code(404).send({ error: 'Block not found' });
      }

      db.prepare('DELETE FROM executive_summary_blocks WHERE id = ?').run(bid);
      db.prepare("UPDATE executive_summaries SET updated_at = datetime('now') WHERE id = ?").run(sid);

      return { ok: true };
    }
  );

  // Generate a summary from project data for a given period
  // Aggregates issues, approvals, and agent activity into pre-filled blocks
  fastify.post<{ Params: { pid: string; sid: string } }>(
    '/api/projects/:pid/executive-summaries/:sid/generate',
    async (request, reply) => {
      const db = getDatabase();
      const { pid, sid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const summary = db.prepare(
        'SELECT * FROM executive_summaries WHERE id = ? AND project_id = ?'
      ).get(sid, pid) as SummaryRow | undefined;
      if (!summary) {
        return reply.code(404).send({ error: 'Executive summary not found' });
      }

      const { period_start, period_end } = summary;

      // Gather project data for the period
      const issuesDone = db.prepare(
        `SELECT COUNT(*) as count FROM issues
         WHERE project_id = ? AND status IN ('done', 'closed')
         AND updated_at >= ? AND updated_at <= ?`
      ).get(pid, period_start, period_end) as { count: number };

      const issuesOpen = db.prepare(
        `SELECT COUNT(*) as count FROM issues
         WHERE project_id = ? AND status IN ('open', 'in_progress', 'pending')
         AND created_at <= ?`
      ).get(pid, period_end) as { count: number };

      const issuesCreated = db.prepare(
        `SELECT COUNT(*) as count FROM issues
         WHERE project_id = ? AND created_at >= ? AND created_at <= ?`
      ).get(pid, period_start, period_end) as { count: number };

      const highPriorityOpen = db.prepare(
        `SELECT number, title, assigned_to, status FROM issues
         WHERE project_id = ? AND priority >= 3
         AND status IN ('open', 'in_progress', 'pending')
         AND created_at <= ?
         ORDER BY priority DESC LIMIT 5`
      ).all(pid, period_end) as Array<{ number: number; title: string; assigned_to: string; status: string }>;

      const approvalsTotal = db.prepare(
        `SELECT COUNT(*) as count FROM approval_requests
         WHERE project_id = ? AND created_at >= ? AND created_at <= ?`
      ).get(pid, period_start, period_end) as { count: number };

      const approvalsApproved = db.prepare(
        `SELECT COUNT(*) as count FROM approval_requests
         WHERE project_id = ? AND status = 'approved'
         AND decided_at >= ? AND decided_at <= ?`
      ).get(pid, period_start, period_end) as { count: number };

      const approvalsRejected = db.prepare(
        `SELECT COUNT(*) as count FROM approval_requests
         WHERE project_id = ? AND status = 'rejected'
         AND decided_at >= ? AND decided_at <= ?`
      ).get(pid, period_start, period_end) as { count: number };

      const approvalsPending = db.prepare(
        `SELECT COUNT(*) as count FROM approval_requests
         WHERE project_id = ? AND status = 'pending'
         AND created_at <= ?`
      ).get(pid, period_end) as { count: number };

      const agentActivity = db.prepare(
        `SELECT a.name, a.role, a.status,
                (SELECT COUNT(*) FROM issues i WHERE i.assigned_to = a.id AND i.status IN ('done', 'closed')
                 AND i.updated_at >= ? AND i.updated_at <= ?) as completed_issues
         FROM agents a WHERE a.project_id = ?`
      ).all(period_start, period_end, pid) as Array<{ name: string; role: string; status: string; completed_issues: number }>;

      // Build generated content for each default block key
      const generatedContent: Record<string, string> = {
        cash_position: [
          `**Period**: ${period_start} — ${period_end}`,
          ``,
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Issues resolved | ${issuesDone.count} |`,
          `| Issues created | ${issuesCreated.count} |`,
          `| Open items at period end | ${issuesOpen.count} |`,
          ``,
          `Net issue throughput: ${issuesDone.count - issuesCreated.count >= 0 ? '+' : ''}${issuesDone.count - issuesCreated.count} (resolved minus created).`,
        ].join('\n'),

        payment_activity: [
          `**Approval Activity for Period**`,
          ``,
          `| Status | Count |`,
          `|--------|-------|`,
          `| Submitted | ${approvalsTotal.count} |`,
          `| Approved | ${approvalsApproved.count} |`,
          `| Rejected | ${approvalsRejected.count} |`,
          `| Pending | ${approvalsPending.count} |`,
          ``,
          approvalsTotal.count > 0
            ? `Approval rate: ${((approvalsApproved.count / approvalsTotal.count) * 100).toFixed(1)}%.`
            : 'No approval requests submitted during this period.',
        ].join('\n'),

        liquidity_alerts: [
          `**High-Priority Open Items**`,
          ``,
          highPriorityOpen.length > 0
            ? highPriorityOpen.map((i) =>
                `- **#${i.number}** ${i.title} — ${i.status} (assigned: ${i.assigned_to || 'unassigned'})`
              ).join('\n')
            : 'No high-priority items flagged during this period.',
        ].join('\n'),

        forecast_variance: [
          `**Agent Throughput**`,
          ``,
          `| Agent | Role | Resolved Issues |`,
          `|-------|------|----------------|`,
          ...agentActivity.map((a) => `| ${a.name} | ${a.role} | ${a.completed_issues} |`),
        ].join('\n'),

        risk_compliance: [
          `**Pending Approvals at Period End**: ${approvalsPending.count}`,
          ``,
          approvalsPending.count > 0
            ? 'Review pending approvals to ensure timely processing and policy compliance.'
            : 'All approval requests have been resolved.',
          ``,
          approvalsRejected.count > 0
            ? `**${approvalsRejected.count} rejection(s)** during period — review root causes.`
            : 'No rejections during this period.',
        ].join('\n'),

        action_items: [
          `**Carry-Forward Items**`,
          ``,
          `- Open issues at period end: ${issuesOpen.count}`,
          highPriorityOpen.length > 0
            ? `- High-priority items requiring attention: ${highPriorityOpen.length}`
            : '',
          approvalsPending.count > 0
            ? `- Pending approvals to resolve: ${approvalsPending.count}`
            : '',
          ``,
          `**Next Steps**`,
          `- Review high-priority items and assign owners`,
          `- Clear pending approval backlog`,
          `- Prepare forecast inputs for next period`,
        ].filter(Boolean).join('\n'),
      };

      // Update blocks with generated content
      const updateBlock = db.prepare(
        `UPDATE executive_summary_blocks SET content = ? WHERE summary_id = ? AND block_key = ?`
      );
      for (const [key, content] of Object.entries(generatedContent)) {
        updateBlock.run(content, sid, key);
      }

      db.prepare("UPDATE executive_summaries SET updated_at = datetime('now') WHERE id = ?").run(sid);

      const result = serializeSummary(db, db.prepare('SELECT * FROM executive_summaries WHERE id = ?').get(sid) as SummaryRow);

      broadcastToProject(pid, {
        type: 'executive_summary_generated',
        projectId: pid,
        data: result,
      });

      return result;
    }
  );

  // Finalize a summary (set status to 'final')
  fastify.post<{ Params: { pid: string; sid: string } }>(
    '/api/projects/:pid/executive-summaries/:sid/finalize',
    async (request, reply) => {
      const db = getDatabase();
      const { pid, sid } = request.params;
      const access = ensureProjectAccess(db, request, reply, pid);
      if (!access) return;

      const existing = db.prepare(
        'SELECT * FROM executive_summaries WHERE id = ? AND project_id = ?'
      ).get(sid, pid) as SummaryRow | undefined;
      if (!existing) {
        return reply.code(404).send({ error: 'Executive summary not found' });
      }
      if (existing.status === 'final') {
        return reply.code(409).send({ error: 'Summary is already finalized' });
      }
      if (existing.status === 'archived') {
        return reply.code(409).send({ error: 'Cannot finalize an archived summary' });
      }

      db.prepare(
        "UPDATE executive_summaries SET status = 'final', updated_at = datetime('now') WHERE id = ?"
      ).run(sid);

      const updated = db.prepare('SELECT * FROM executive_summaries WHERE id = ?').get(sid) as SummaryRow;
      const result = serializeSummary(db, updated);

      broadcastToProject(pid, {
        type: 'executive_summary_finalized',
        projectId: pid,
        data: result,
      });

      return result;
    }
  );
}
