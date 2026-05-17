import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { getDatabase } from '../../db/database';
import { getAgentOrThrow } from './core';

function expandWorkingDirectory(dir: string): string {
  if (dir.startsWith('~/')) {
    return path.join(os.homedir(), dir.slice(2));
  }
  return dir;
}

export function getAgentGitStatus(agentId: string): any {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);

  let dir = agent.working_directory;
  if (!dir) return { branch: null, recent_commits: [], has_uncommitted: false, diff_stat: '' };
  dir = expandWorkingDirectory(dir);

  try {
    const gitExec = (cmd: string) => execSync(cmd, { cwd: dir!, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

    const branch = gitExec('git branch --show-current') || gitExec('git rev-parse --short HEAD');

    const logOutput = gitExec("git log --format='%H|%s|%ai' -n 5");
    const recent_commits = logOutput ? logOutput.split('\n').map((line) => {
      const parts = line.split('|');
      return { hash: parts[0]?.slice(0, 7) || '', message: parts[1] || '', date: parts.slice(2).join('|') };
    }) : [];

    const statusOutput = execSync('git status --porcelain', { cwd: dir!, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    const statusLines = statusOutput.split('\n').filter((line) => line.length > 0);
    const has_uncommitted = statusLines.length > 0;

    let diff_stat = '';
    if (has_uncommitted) {
      try { diff_stat = gitExec('git diff --stat'); } catch {}
    }

    const uncommitted_files = statusLines.map((line) => {
      const status = line.slice(0, 2).trim();
      const file = line.slice(3);
      return { status, file };
    });

    return { branch, recent_commits, has_uncommitted, diff_stat, uncommitted_files };
  } catch {
    return { branch: null, recent_commits: [], has_uncommitted: false, diff_stat: '' };
  }
}
