import Database from 'better-sqlite3';
import { Project } from '../../types';
import { listLatestProjectCostRows, sumCostRows } from './costs';
import { ProjectNotFoundError } from './errors';

export interface ProjectExportResult {
  fileName: string;
  data: any;
}

export interface ProjectIssuesCsvResult {
  fileName: string;
  csv: string;
}

function getProjectOrThrow(db: Database.Database, projectId: string): Project {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project) throw new ProjectNotFoundError();
  return project;
}

export function buildProjectExport(db: Database.Database, projectId: string): ProjectExportResult {
  const project = getProjectOrThrow(db, projectId);
  const agents = db.prepare('SELECT id, name, role, is_controller, status, started_at, finished_at, created_at FROM agents WHERE project_id = ?').all(projectId);
  const issues = db.prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY number').all(projectId);
  const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ?').all(projectId);
  const totals = sumCostRows(listLatestProjectCostRows(db, projectId));

  return {
    fileName: `${project.name || 'project'}-export.json`,
    data: {
      exported_at: new Date().toISOString(),
      project,
      agents,
      issues,
      milestones,
      cost_summary: {
        total_cost_usd: totals.cost_usd,
        total_input_tokens: totals.input_tokens,
        total_output_tokens: totals.output_tokens,
      },
    },
  };
}

function escapeCsvValue(value: unknown): string {
  const text = String(value ?? '');
  return text.includes(',') || text.includes('"') || text.includes('\n')
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

export function buildProjectIssuesCsv(db: Database.Database, projectId: string): ProjectIssuesCsvResult {
  const project = getProjectOrThrow(db, projectId);
  const issues = db.prepare(
    'SELECT number, title, status, priority, labels, assigned_to, created_by, created_at, updated_at FROM issues WHERE project_id = ? ORDER BY number'
  ).all(projectId) as any[];

  const csvHeader = 'number,title,status,priority,labels,assigned_to,created_by,created_at,updated_at';
  const csvRows = issues.map((issue) => [
    issue.number,
    issue.title,
    issue.status,
    issue.priority,
    issue.labels,
    issue.assigned_to,
    issue.created_by,
    issue.created_at,
    issue.updated_at,
  ].map(escapeCsvValue).join(','));

  return {
    fileName: `${project.name || 'project'}-issues.csv`,
    csv: [csvHeader, ...csvRows].join('\n'),
  };
}
