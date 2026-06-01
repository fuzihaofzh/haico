import Database from 'better-sqlite3';
import { Agent } from '../../types';
import { expandHomePath, getGitLogWithAuthor, isGitRepository } from '../git';
import { parseBoundedLimit, parseJson } from './utils';

export function getProjectActivity(
  db: Database.Database,
  projectId: string,
  limitInput?: unknown
): any[] {
  const limit = parseBoundedLimit(limitInput, 50, 200);

  const issues = db.prepare(
    "SELECT 'issue' as event_type, id, number, title, status, created_by as actor, created_at as time FROM issues WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(projectId, limit) as any[];

  const comments = db.prepare(
    "SELECT 'comment' as event_type, c.id, c.body, c.author_id as actor, c.created_at as time, i.number as issue_number, i.title as issue_title FROM issue_comments c JOIN issues i ON c.issue_id = i.id WHERE i.project_id = ? ORDER BY c.created_at DESC LIMIT ?"
  ).all(projectId, limit) as any[];

  const agentRuns = db.prepare(
    `SELECT 'agent_run' as event_type,
            tr.id,
            a.name,
            tr.status as agent_status,
            COALESCE(tr.finished_at, tr.started_at, tr.created_at) as time
     FROM task_runs tr
     JOIN agents a ON a.id = tr.agent_id
     WHERE tr.project_id = ?
     ORDER BY COALESCE(tr.finished_at, tr.started_at, tr.created_at) DESC
     LIMIT ?`
  ).all(projectId, limit) as any[];

  return [...issues, ...comments, ...agentRuns]
    .sort((a: any, b: any) => b.time > a.time ? 1 : -1)
    .slice(0, limit);
}

export function getProjectGitLog(
  db: Database.Database,
  projectId: string,
  limitInput?: unknown
): Array<{ hash: string; short_hash: string; author: string; message: string; date: string; repo_path: string; agent_name: string }> {
  const limit = parseBoundedLimit(limitInput, 20, 100);
  const agents = db.prepare('SELECT id, name, working_directory FROM agents WHERE project_id = ?').all(projectId) as Agent[];
  const seen = new Set<string>();
  const commits: Array<{ hash: string; short_hash: string; author: string; message: string; date: string; repo_path: string; agent_name: string }> = [];

  const dirToAgents = new Map<string, string[]>();
  for (const agent of agents) {
    let dir = agent.working_directory;
    if (!dir) continue;
    dir = expandHomePath(dir);
    if (!dirToAgents.has(dir)) dirToAgents.set(dir, []);
    dirToAgents.get(dir)!.push(agent.name);
  }

  for (const [dir, agentNames] of dirToAgents) {
    if (!isGitRepository(dir)) continue;
    const log = getGitLogWithAuthor(dir, limit);
    for (const entry of log) {
      if (seen.has(entry.hash)) continue;
      seen.add(entry.hash);
      commits.push({
        hash: entry.hash,
        short_hash: entry.shortHash,
        author: entry.author,
        message: entry.message,
        date: entry.date,
        repo_path: dir,
        agent_name: agentNames[0],
      });
    }
  }

  commits.sort((a, b) => b.date > a.date ? 1 : -1);
  return commits.slice(0, limit);
}

export function listProjectOrchestrationRuns(
  db: Database.Database,
  projectId: string,
  limitInput?: unknown
): any[] {
  const limit = parseBoundedLimit(limitInput, 20, 100);
  const rows = db.prepare(
    "SELECT id, project_id, engine, decision, controller_agent_id, controller_started, controller_run_id, controller_pid, dispatch_count, dispatch_summary, reasons, backoff_ms, backoff_reason, backoff_label, actions, dispatch_results, created_at FROM orchestration_runs WHERE project_id = ? ORDER BY id DESC LIMIT ?"
  ).all(projectId, limit) as any[];

  return rows.map((row) => ({
    ...row,
    controller_started: !!row.controller_started,
    backoff_ms: Number(row.backoff_ms || 0),
    backoff_reason: String(row.backoff_reason || ''),
    backoff_label: String(row.backoff_label || ''),
    reasons: parseJson<string[]>(row.reasons, []),
    actions: parseJson<any[]>(row.actions, []),
    dispatch_results: parseJson<any[]>(row.dispatch_results, []),
  }));
}
