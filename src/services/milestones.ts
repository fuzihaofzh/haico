import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  MilestoneNotFoundError,
  MissingMilestoneTitleError,
} from './issue/errors';
import { buildSqlPlaceholders } from './issue/utils';

export interface CreateMilestoneInput {
  title?: string;
  description?: string;
  due_date?: string;
}

export interface UpdateMilestoneInput {
  title?: string;
  description?: string;
  due_date?: string;
  status?: string;
}

function getMilestoneOrThrow(db: Database.Database, milestoneId: string): any {
  const milestone = db.prepare('SELECT * FROM milestones WHERE id = ?').get(milestoneId);
  if (!milestone) throw new MilestoneNotFoundError();
  return milestone;
}

export function listMilestones(db: Database.Database, projectId: string): any[] {
  const milestones = db.prepare(
    'SELECT * FROM milestones WHERE project_id = ? ORDER BY created_at DESC'
  ).all(projectId) as any[];
  if (milestones.length === 0) return milestones;

  const milestoneIds = milestones.map((milestone) => milestone.id);
  const placeholders = buildSqlPlaceholders(milestoneIds);
  const stats = db.prepare(
    `SELECT milestone_id, COUNT(*) as total,
            SUM(CASE WHEN status IN ('done','closed') THEN 1 ELSE 0 END) as closed
     FROM issues WHERE milestone_id IN (${placeholders}) GROUP BY milestone_id`
  ).all(...milestoneIds) as any[];
  const statsMap = new Map(stats.map((stat) => [stat.milestone_id, stat]));

  return milestones.map((milestone) => {
    const stat = statsMap.get(milestone.id);
    const total = stat?.total || 0;
    const closed = stat?.closed || 0;
    return {
      ...milestone,
      total_issues: total,
      closed_issues: closed,
      progress: total > 0 ? Math.round((closed / total) * 100) : 0,
    };
  });
}

export function createMilestone(db: Database.Database, projectId: string, input: CreateMilestoneInput): any {
  const { title, description, due_date } = input;
  if (!title) throw new MissingMilestoneTitleError();

  const id = uuidv4();
  db.prepare(
    'INSERT INTO milestones (id, project_id, title, description, due_date) VALUES (?, ?, ?, ?, ?)'
  ).run(id, projectId, title, description || '', due_date || null);
  return getMilestoneOrThrow(db, id);
}

export function updateMilestone(db: Database.Database, milestoneId: string, input: UpdateMilestoneInput): any {
  getMilestoneOrThrow(db, milestoneId);
  db.prepare(
    'UPDATE milestones SET title = COALESCE(?, title), description = COALESCE(?, description), due_date = COALESCE(?, due_date), status = COALESCE(?, status) WHERE id = ?'
  ).run(input.title ?? null, input.description ?? null, input.due_date ?? null, input.status ?? null, milestoneId);
  return getMilestoneOrThrow(db, milestoneId);
}

export function deleteMilestone(db: Database.Database, milestoneId: string): void {
  getMilestoneOrThrow(db, milestoneId);
  db.transaction(() => {
    db.prepare('UPDATE issues SET milestone_id = NULL WHERE milestone_id = ?').run(milestoneId);
    db.prepare('DELETE FROM milestones WHERE id = ?').run(milestoneId);
  })();
}
