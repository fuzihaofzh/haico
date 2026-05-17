import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { broadcastToProject } from '../websocket';
import {
  InvalidIssueStatusError,
  IssueDeleteStatusConflictError,
  IssueHasChildrenDeleteConflictError,
  IssueNotFoundError,
  IssueParentNotFoundError,
  IssueParentProjectMismatchError,
  MissingIssueCreateFieldsError,
} from './errors';
import { attachCommentReactions } from './utils';
import {
  autoStartAssignedAgentForIssue,
  parseMentionsAndStartAgents,
  triggerControllerOnDemand,
} from './automation';

const ISSUE_STATUSES = ['open', 'in_progress', 'pending', 'done', 'closed'] as const;
type IssueStatus = typeof ISSUE_STATUSES[number];

export interface ListIssuesFilters {
  status?: string;
  assigned_to?: string;
  label?: string;
  q?: string;
  sort?: string;
  page?: string;
  per_page?: string;
  milestone_id?: string;
}

export interface CreateIssueInput {
  title?: string;
  body?: string;
  created_by?: string;
  assigned_to?: string;
  labels?: string;
  parent_id?: string;
}

export interface UpdateIssueInput {
  status?: string;
  assigned_to?: string;
  title?: string;
  body?: string;
  labels?: string;
  milestone_id?: string;
  actor?: string;
}

export interface IssueListResult {
  issues: any[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

function isIssueStatus(status: string): status is IssueStatus {
  return (ISSUE_STATUSES as readonly string[]).includes(status);
}

function resolvePriority(db: Database.Database, createdBy: string, projectId: string): number {
  if (createdBy === 'user' || createdBy === 'system') return 10;
  const agent = db.prepare(
    'SELECT is_controller FROM agents WHERE id = ? AND project_id = ?'
  ).get(createdBy, projectId) as { is_controller: number } | undefined;
  if (agent?.is_controller) return 5;
  return 1;
}

function resolveImplicitParentId(db: Database.Database, projectId: string, body?: string): string | undefined {
  if (!body) return undefined;
  const firstNonEmptyLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstNonEmptyLine) return undefined;

  const match = /^(?:父\s*issue|parent\s*issue)\s*:\s*#(\d+)\b/i.exec(firstNonEmptyLine);
  if (!match) return undefined;

  const parentNumber = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parentNumber)) return undefined;

  const parent = db.prepare(
    'SELECT id FROM issues WHERE project_id = ? AND number = ?'
  ).get(projectId, parentNumber) as { id: string } | undefined;
  return parent?.id;
}

function getIssueOrThrow(db: Database.Database, issueId: string): any {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId) as any;
  if (!issue) throw new IssueNotFoundError();
  return issue;
}

function buildIssueDetail(db: Database.Database, issue: any): any {
  const comments = db.prepare(
    'SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at'
  ).all(issue.id) as any[];
  const reactions = db.prepare(
    "SELECT * FROM reactions WHERE target_type = 'issue' AND target_id = ?"
  ).all(issue.id);
  const commentsWithReactions = attachCommentReactions(db, comments);

  let parent_number: number | null = null;
  let parent_title: string | null = null;
  if (issue.parent_id) {
    const parent = db.prepare('SELECT number, title FROM issues WHERE id = ?').get(issue.parent_id) as any;
    if (parent) {
      parent_number = parent.number;
      parent_title = parent.title;
    }
  }

  const children = db.prepare(
    'SELECT id, number, title, status, assigned_to FROM issues WHERE parent_id = ? ORDER BY number'
  ).all(issue.id);

  const allRelations = db.prepare(`
    SELECT r.id as relation_id, r.relation_type, r.created_by, r.created_at,
           r.from_issue_id, r.to_issue_id,
           i.id, i.number, i.title, i.status
    FROM issue_relations r JOIN issues i ON i.id = CASE
      WHEN r.from_issue_id = ? THEN r.to_issue_id
      ELSE r.from_issue_id
    END
    WHERE r.from_issue_id = ? OR r.to_issue_id = ?
  `).all(issue.id, issue.id, issue.id) as any[];

  const blocks = allRelations.filter((relation) => relation.relation_type === 'blocks' && relation.from_issue_id === issue.id);
  const blocked_by = allRelations.filter((relation) => relation.relation_type === 'blocks' && relation.to_issue_id === issue.id);
  const related_to = allRelations.filter((relation) => relation.relation_type === 'related_to');
  const is_blocked = blocked_by.some((relation: any) => !['done', 'closed'].includes(relation.status));

  return {
    ...issue,
    comments: commentsWithReactions,
    reactions,
    parent_number,
    parent_title,
    children,
    blocks,
    blocked_by,
    related_to,
    is_blocked,
  };
}

export function listIssues(
  db: Database.Database,
  projectId: string,
  filters: ListIssuesFilters
): IssueListResult {
  const { status, assigned_to, label, q, sort, page, per_page, milestone_id } = filters;

  let sql = `SELECT issues.*, (SELECT COUNT(*) FROM issue_comments WHERE issue_id = issues.id AND event_type = 'comment') as comment_count, (SELECT COUNT(*) > 0 FROM issue_relations r JOIN issues blocker ON blocker.id = r.from_issue_id WHERE r.to_issue_id = issues.id AND r.relation_type = 'blocks' AND blocker.status NOT IN ('done', 'closed')) as is_blocked FROM issues WHERE project_id = ?`;
  const params: any[] = [projectId];

  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (assigned_to) { sql += ' AND assigned_to = ?'; params.push(assigned_to); }
  if (label) { sql += " AND (',' || labels || ',') LIKE ?"; params.push(`%,${label},%`); }
  if (milestone_id) { sql += ' AND milestone_id = ?'; params.push(milestone_id); }
  if (q) { sql += ' AND (title LIKE ? OR body LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }

  const sortMap: Record<string, string> = {
    newest: 'created_at DESC',
    oldest: 'created_at ASC',
    updated: 'updated_at DESC',
    priority: 'priority DESC, created_at DESC',
    comments: "(SELECT COUNT(*) FROM issue_comments WHERE issue_id = issues.id AND event_type = 'comment') DESC",
  };
  sql += ` ORDER BY ${sortMap[sort || ''] || 'created_at DESC'}`;

  const parsedLimit = Number.parseInt(per_page || '100', 10);
  const limit = Math.min(Number.isFinite(parsedLimit) ? parsedLimit : 100, 200);
  const parsedPage = Number.parseInt(page || '1', 10);
  const offset = (Math.max(Number.isFinite(parsedPage) ? parsedPage : 1, 1) - 1) * limit;
  const countSql = sql.replace(/SELECT issues\.\*.*?FROM issues/, 'SELECT COUNT(*) as total FROM issues');
  const total = (db.prepare(countSql).get(...params) as any)?.total || 0;

  sql += ` LIMIT ${limit} OFFSET ${offset}`;
  const issues = db.prepare(sql).all(...params).map((issue: any) => ({
    ...issue,
    is_blocked: !!issue.is_blocked,
  }));

  return {
    issues,
    total,
    page: Math.floor(offset / limit) + 1,
    per_page: limit,
    total_pages: Math.ceil(total / limit),
  };
}

export function getIssueCounts(db: Database.Database, projectId: string): Record<string, number> {
  const rows = db.prepare(
    'SELECT status, COUNT(*) as count FROM issues WHERE project_id = ? GROUP BY status'
  ).all(projectId) as { status: string; count: number }[];
  const counts: Record<string, number> = { open: 0, in_progress: 0, pending: 0, done: 0, closed: 0 };
  let total = 0;
  for (const row of rows) {
    counts[row.status] = row.count;
    total += row.count;
  }
  return { ...counts, total };
}

export function createIssue(db: Database.Database, projectId: string, input: CreateIssueInput): any {
  const { title, body, created_by, assigned_to, labels, parent_id } = input;
  if (!title || !created_by) throw new MissingIssueCreateFieldsError();

  const result = db.transaction(() => {
    const id = uuidv4();
    const priority = resolvePriority(db, created_by, projectId);
    const resolvedParentId = parent_id || resolveImplicitParentId(db, projectId, body);
    const last = db.prepare(
      'SELECT MAX(number) as n FROM issues WHERE project_id = ?'
    ).get(projectId) as { n: number | null };
    const number = (last?.n || 0) + 1;

    if (resolvedParentId) {
      const parent = db.prepare('SELECT id, project_id FROM issues WHERE id = ?').get(resolvedParentId) as any;
      if (!parent) throw new IssueParentNotFoundError();
      if (parent.project_id !== projectId) throw new IssueParentProjectMismatchError();
    }

    db.prepare(`
      INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, labels, parent_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `).run(id, projectId, number, title, body || '', created_by, assigned_to || null, priority, labels || '', resolvedParentId || null);

    const created = getIssueOrThrow(db, id);
    let updatedParent: any | null = null;

    if (resolvedParentId) {
      const parent = db.prepare('SELECT id, status FROM issues WHERE id = ?').get(resolvedParentId) as any;
      const eventStmt = db.prepare(
        'INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)'
      );
      if (parent && !['done', 'closed', 'pending'].includes(parent.status)) {
        db.prepare("UPDATE issues SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(resolvedParentId);
        eventStmt.run(
          uuidv4(),
          resolvedParentId,
          'system',
          `changed status from ${parent.status} to pending (child issue #${number} created)`,
          'status_change',
          JSON.stringify({ from: parent.status, to: 'pending', child_number: number })
        );
        updatedParent = getIssueOrThrow(db, resolvedParentId);
      } else if (parent && parent.status === 'pending') {
        eventStmt.run(
          uuidv4(),
          resolvedParentId,
          'system',
          `New child issue #${number} added`,
          'status_change',
          JSON.stringify({ child_number: number })
        );
      }
    }

    return { created, updatedParent };
  })();

  if (result.updatedParent) {
    broadcastToProject(projectId, {
      type: 'issue_updated',
      projectId,
      data: { issue: result.updatedParent },
    });
  }

  broadcastToProject(projectId, {
    type: 'issue_created',
    projectId,
    data: { issue: result.created },
  });

  if (created_by === 'user') {
    autoStartAssignedAgentForIssue(db, projectId, result.created.number, assigned_to, 'issue-create-assignment');
  }

  if (body) {
    parseMentionsAndStartAgents(db, body, projectId, result.created.id, result.created.number, title, created_by);
  }

  triggerControllerOnDemand(db, projectId, result.created.number, created_by, {
    reason: 'issue-created',
    forceUrgent: created_by === 'user' && (!assigned_to || assigned_to === 'all'),
  });

  return result.created;
}

export function getIssueDetail(db: Database.Database, issueId: string): any {
  const issue = db.prepare(
    'SELECT i.*, p.color as project_color FROM issues i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?'
  ).get(issueId) as any;
  if (!issue) throw new IssueNotFoundError();
  return buildIssueDetail(db, issue);
}

export function getIssueByNumberDetail(db: Database.Database, projectId: string, issueNumber: number): any {
  if (!Number.isFinite(issueNumber)) throw new IssueNotFoundError();
  const issue = db.prepare(
    'SELECT i.*, p.color as project_color FROM issues i LEFT JOIN projects p ON p.id = i.project_id WHERE i.project_id = ? AND i.number = ?'
  ).get(projectId, issueNumber) as any;
  if (!issue) throw new IssueNotFoundError();
  return buildIssueDetail(db, issue);
}

export function updateIssue(db: Database.Database, issueId: string, input: UpdateIssueInput): any {
  const { status, assigned_to, title, body, labels, milestone_id, actor } = input;
  const actorId = actor || 'user';
  if (status && !isIssueStatus(status)) throw new InvalidIssueStatusError();

  const result = db.transaction(() => {
    const existing = getIssueOrThrow(db, issueId);
    const eventStmt = db.prepare(
      'INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)'
    );

    if (status && status !== existing.status) {
      eventStmt.run(
        uuidv4(),
        issueId,
        actorId,
        `changed status from ${existing.status} to ${status}`,
        'status_change',
        JSON.stringify({ from: existing.status, to: status })
      );
    }
    if (assigned_to !== undefined && assigned_to !== existing.assigned_to) {
      const agentRow = assigned_to
        ? db.prepare('SELECT name FROM agents WHERE id = ?').get(assigned_to) as { name: string } | undefined
        : null;
      const assigneeName = agentRow ? agentRow.name : (assigned_to || 'nobody');
      eventStmt.run(
        uuidv4(),
        issueId,
        actorId,
        `assigned to ${assigneeName}`,
        'assignment',
        JSON.stringify({ from: existing.assigned_to, to: assigned_to })
      );
    }
    if (labels !== undefined && labels !== existing.labels) {
      eventStmt.run(
        uuidv4(),
        issueId,
        actorId,
        'changed labels',
        'label_change',
        JSON.stringify({ from: existing.labels, to: labels })
      );
    }

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
    `).run(title ?? null, body ?? null, assigned_to ?? null, status ?? null, labels ?? null, milestone_id ?? null, resetAck ? 1 : 0, issueId);

    if (status && (status === 'open' || status === 'in_progress')
        && (existing.status === 'done' || existing.status === 'closed')
        && assigned_to === undefined && existing.assigned_to === 'user') {
      db.prepare("UPDATE issues SET assigned_to = NULL, updated_at = datetime('now') WHERE id = ?")
        .run(issueId);
      eventStmt.run(
        uuidv4(),
        issueId,
        actorId,
        'unassigned from user (issue reopened, needs reassignment)',
        'assignment',
        JSON.stringify({ from: 'user', to: null, reason: 'reopen' })
      );
    }

    const updated = getIssueOrThrow(db, issueId);
    let parentIssueForTrigger: any | null = null;
    let refreshedParent: any | null = null;

    if ((status === 'done' || status === 'closed') && updated.parent_id) {
      const siblings = db.prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN status IN ('done','closed') THEN 1 ELSE 0 END) as completed FROM issues WHERE parent_id = ?"
      ).get(updated.parent_id) as any;
      const parentIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(updated.parent_id) as any;

      if (siblings.total > 0 && siblings.total === siblings.completed && parentIssue) {
        const childIssues = db.prepare(
          'SELECT number, title, status FROM issues WHERE parent_id = ? ORDER BY number ASC'
        ).all(updated.parent_id) as Array<{ number: number; title: string; status: string }>;
        const summaryLines = childIssues.map((child) => `- #${child.number} [${child.status}] ${child.title}`).join('\n');
        const summaryBody = `All ${siblings.total} sub-issues completed:\n${summaryLines}`;
        eventStmt.run(
          uuidv4(),
          updated.parent_id,
          'system',
          summaryBody,
          'status_change',
          JSON.stringify({ all_children_complete: true, child_count: siblings.total })
        );

        if (parentIssue.status === 'pending') {
          eventStmt.run(
            uuidv4(),
            updated.parent_id,
            'system',
            'changed status from pending to in_progress (all child issues completed, awaiting review)',
            'status_change',
            JSON.stringify({ from: 'pending', to: 'in_progress', all_children_complete: true })
          );
          db.prepare("UPDATE issues SET status = 'in_progress', updated_at = datetime('now'), acknowledged_at = NULL WHERE id = ?")
            .run(updated.parent_id);
        } else {
          db.prepare("UPDATE issues SET updated_at = datetime('now'), acknowledged_at = NULL WHERE id = ?")
            .run(updated.parent_id);
        }

        parentIssueForTrigger = parentIssue;
        refreshedParent = getIssueOrThrow(db, updated.parent_id);
      } else if (parentIssue) {
        eventStmt.run(
          uuidv4(),
          updated.parent_id,
          'system',
          `Child #${updated.number} completed (${siblings.completed}/${siblings.total} done).`,
          'status_change',
          JSON.stringify({ child_number: updated.number, completed: siblings.completed, total: siblings.total })
        );
        db.prepare("UPDATE issues SET updated_at = datetime('now') WHERE id = ?").run(updated.parent_id);
      }
    }

    if ((status === 'done' || status === 'closed') && !updated.parent_id
        && existing.created_by === 'user' && actorId !== 'user'
        && existing.assigned_to !== 'user') {
      db.prepare("UPDATE issues SET assigned_to = 'user', acknowledged_at = NULL, updated_at = datetime('now') WHERE id = ?")
        .run(issueId);
      eventStmt.run(
        uuidv4(),
        issueId,
        'system',
        'assigned to user for review (task completed)',
        'assignment',
        JSON.stringify({ from: existing.assigned_to, to: 'user' })
      );
    }

    return {
      existing,
      updated,
      parentIssueForTrigger,
      refreshedParent,
      finalIssue: getIssueOrThrow(db, issueId),
    };
  })();

  broadcastToProject(result.updated.project_id, {
    type: 'issue_updated',
    projectId: result.updated.project_id,
    data: { issue: result.updated },
  });

  if (result.parentIssueForTrigger) {
    triggerControllerOnDemand(db, result.updated.project_id, result.parentIssueForTrigger.number, 'system', {
      reason: 'all-children-complete',
    });
  }

  if (result.refreshedParent) {
    broadcastToProject(result.updated.project_id, {
      type: 'issue_updated',
      projectId: result.updated.project_id,
      data: { issue: result.refreshedParent },
    });
  }

  triggerControllerOnDemand(db, result.updated.project_id, result.updated.number, actorId, {
    reason: 'issue-updated',
  });

  if (actorId === 'user' && assigned_to && assigned_to !== result.existing.assigned_to) {
    autoStartAssignedAgentForIssue(db, result.updated.project_id, result.updated.number, assigned_to, 'issue-update-assignment');
  }

  return result.finalIssue;
}

export function deleteIssue(db: Database.Database, issueId: string): void {
  const issue = getIssueOrThrow(db, issueId);
  if (issue.status !== 'open') throw new IssueDeleteStatusConflictError();

  const childCount = (db.prepare(
    'SELECT COUNT(*) as c FROM issues WHERE parent_id = ?'
  ).get(issueId) as any).c;
  if (childCount > 0) throw new IssueHasChildrenDeleteConflictError(childCount);

  db.prepare('DELETE FROM issues WHERE id = ?').run(issueId);
}

export function acknowledgeIssue(db: Database.Database, issueId: string): any {
  getIssueOrThrow(db, issueId);
  db.prepare("UPDATE issues SET acknowledged_at = datetime('now') WHERE id = ?").run(issueId);
  return getIssueOrThrow(db, issueId);
}

export function unacknowledgeIssue(db: Database.Database, issueId: string): any {
  getIssueOrThrow(db, issueId);
  db.prepare('UPDATE issues SET acknowledged_at = NULL WHERE id = ?').run(issueId);
  return getIssueOrThrow(db, issueId);
}

export function searchProjectIssues(db: Database.Database, projectId: string, query: string): { issues: any[]; comments: any[] } {
  const q = `%${query}%`;
  const issues = db.prepare(
    'SELECT * FROM issues WHERE project_id = ? AND (title LIKE ? OR body LIKE ?) ORDER BY updated_at DESC LIMIT 50'
  ).all(projectId, q, q);
  const comments = db.prepare(
    "SELECT c.*, i.number as issue_number, i.title as issue_title FROM issue_comments c JOIN issues i ON c.issue_id = i.id WHERE i.project_id = ? AND c.body LIKE ? AND c.event_type = 'comment' ORDER BY c.created_at DESC LIMIT 20"
  ).all(projectId, q);
  return { issues, comments };
}
