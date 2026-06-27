import * as fs from 'fs/promises';
import * as path from 'path';
import { expandHomePath } from '../file-management/paths';

export interface DirectoryEntry {
  name: string;
  relative_path: string;
  absolute_path: string;
}

export interface DirectoryRoot {
  id: string;
  label: string;
  path: string;
}

/**
 * List all subdirectories under a given absolute path.
 * Returns only directories (no files), sorted by name.
 */
export async function listSubdirectories(absPath: string): Promise<DirectoryEntry[]> {
  const resolved = path.resolve(expandHomePath(absPath));
  const dirents = await fs.readdir(resolved, { withFileTypes: true });
  const entries: DirectoryEntry[] = [];

  for (const entry of dirents) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) continue;
    const entryAbs = path.join(resolved, entry.name);
    entries.push({
      name: entry.name,
      relative_path: entry.name,
      absolute_path: entryAbs,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Get the default set of directory roots for browsing.
 * These are the directories a user might want to pick as a working directory root.
 */
export function getDefaultDirectoryRoots(): DirectoryRoot[] {
  const home = process.env.HOME || process.env.USERPROFILE || '/';
  const roots: DirectoryRoot[] = [
    { id: 'home', label: 'Home', path: expandHomePath(home) },
  ];

  // Add common project directories if they exist
  const common = ['/workspace', '/projects', '/data'];
  for (const dir of common) {
    try {
      if (require('fs').existsSync(dir)) {
        roots.push({ id: `root-${dir.replace(/[^a-zA-Z0-9]/g, '-')}`, label: dir, path: dir });
      }
    } catch {
      // ignore
    }
  }

  return roots;
}

/**
 * Resolve a path relative to a root and list its subdirectories.
 */
export async function browseDirectories(rootPath: string, relativePath: string): Promise<{
  entries: DirectoryEntry[];
  relative_path: string;
  absolute_path: string;
}> {
  const resolved = path.resolve(expandHomePath(rootPath), relativePath || '.');

  // Security: ensure resolved path is within rootPath
  const rootPrefix = path.resolve(expandHomePath(rootPath));
  if (!resolved.startsWith(rootPrefix)) {
    throw new Error('Path is outside the root directory');
  }

  const entries = await listSubdirectories(resolved);

  // Compute relative path from root
  const rel = resolved === rootPrefix ? '' : path.relative(rootPrefix, resolved);

  return {
    entries,
    relative_path: rel,
    absolute_path: resolved,
  };
}
