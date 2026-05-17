import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { Agent } from '../../types';
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
    "SELECT 'agent_run' as event_type, a.id, a.name, a.status as agent_status, a.started_at as time FROM agents a WHERE a.project_id = ? AND a.started_at IS NOT NULL ORDER BY a.started_at DESC LIMIT ?"
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
    if (dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(2));
    if (!dirToAgents.has(dir)) dirToAgents.set(dir, []);
    dirToAgents.get(dir)!.push(agent.name);
  }

  for (const [dir, agentNames] of dirToAgents) {
    try {
      if (!fs.existsSync(path.join(dir, '.git')) && !fs.existsSync(dir)) continue;
      const output = execSync(
        `git log --format='%H|%an|%s|%ai' -n ${limit}`,
        { cwd: dir, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (!output) continue;
      for (const line of output.split('\n')) {
        const parts = line.split('|');
        if (parts.length < 4) continue;
        const hash = parts[0];
        if (seen.has(hash)) continue;
        seen.add(hash);
        commits.push({
          hash,
          short_hash: hash.slice(0, 7),
          author: parts[1],
          message: parts[2],
          date: parts.slice(3).join('|'),
          repo_path: dir,
          agent_name: agentNames[0],
        });
      }
    } catch {
      // Skip non-git or inaccessible repositories.
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
