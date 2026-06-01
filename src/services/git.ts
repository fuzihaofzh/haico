import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export function expandHomePath(dir: string): string {
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

export function isGitRepository(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

function gitExec(cmd: string, cwd: string, timeout = 2000): string {
  return execSync(cmd, { cwd, timeout, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export interface GitUncommittedFile {
  status: string;
  file: string;
}

export interface GitStatusResult {
  branch: string | null;
  hasUncommitted: boolean;
  uncommittedFiles: GitUncommittedFile[];
  diffStat: string;
}

export function getGitStatus(dir: string): GitStatusResult {
  try {
    const branch = gitExec('git branch --show-current', dir) || gitExec('git rev-parse --short HEAD', dir);

    const statusOutput = execSync('git status --porcelain', { cwd: dir, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    const statusLines = statusOutput.split('\n').filter((line) => line.length > 0);
    const hasUncommitted = statusLines.length > 0;

    let diffStat = '';
    if (hasUncommitted) {
      try { diffStat = gitExec('git diff --stat', dir); } catch {}
    }

    const uncommittedFiles = statusLines.map((line) => {
      const status = line.slice(0, 2).trim();
      const file = line.slice(3);
      return { status, file };
    });

    return { branch: branch || null, hasUncommitted, uncommittedFiles, diffStat };
  } catch {
    return { branch: null, hasUncommitted: false, uncommittedFiles: [], diffStat: '' };
  }
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  date: string;
}

export function getGitLog(dir: string, limit: number): GitLogEntry[] {
  try {
    const output = gitExec(`git log --format='%H|%s|%ai' -n ${limit}`, dir);
    if (!output) return [];
    return output.split('\n').map((line) => {
      const parts = line.split('|');
      const hash = parts[0] || '';
      return {
        hash,
        shortHash: hash.slice(0, 7),
        message: parts[1] || '',
        date: parts.slice(2).join('|'),
      };
    });
  } catch {
    return [];
  }
}

export interface GitLogWithAuthorEntry extends GitLogEntry {
  author: string;
}

export function getGitLogWithAuthor(dir: string, limit: number): GitLogWithAuthorEntry[] {
  try {
    const output = gitExec(`git log --format='%H|%an|%s|%ai' -n ${limit}`, dir);
    if (!output) return [];
    const entries: GitLogWithAuthorEntry[] = [];
    for (const line of output.split('\n')) {
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const hash = parts[0];
      entries.push({
        hash,
        shortHash: hash.slice(0, 7),
        author: parts[1],
        message: parts[2],
        date: parts.slice(3).join('|'),
      });
    }
    return entries;
  } catch {
    return [];
  }
}
