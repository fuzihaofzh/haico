import Database from 'better-sqlite3';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TextDecoder } from 'util';
import { Agent } from '../../types';
import { getAgent } from './core';
import {
  AgentBinaryPreviewUnsupportedError,
  AgentDirectoryExpectedError,
  AgentFileAccessDeniedError,
  AgentFileContentTypeError,
  AgentFileExpectedError,
  AgentFileNotFoundError,
  AgentFileOperationFailedError,
  AgentFilePathRequiredError,
  AgentFileTooLargeError,
  AgentPathOutsideWorkingDirectoryError,
  AgentPathResolutionError,
  AgentPreviewFileTypeUnsupportedError,
  AgentSQLiteFileUnsupportedError,
  AgentSQLiteTableNotFoundError,
  AgentUploadMissingFileError,
  AgentWorkingDirectoryRequiredError,
} from './errors';
import {
  MAX_AGENT_FILE_SIZE,
  MAX_SERVE_FILE_SIZE,
  MAX_SQLITE_FILE_SIZE,
  MIME_TYPES,
  SERVE_CONTENT_TYPES,
  SQLITE_EXTENSIONS,
} from './policy';
import {
  AgentFileDownloadResult,
  AgentFileListEntry,
  AgentFileListResult,
  AgentFileSaveResult,
  AgentFileServeResult,
  AgentFileUploadResponse,
  AgentFileUploadResult,
} from './types';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function expandWorkingDirectory(dir: string): string {
  if (dir.startsWith('~/')) {
    return path.join(os.homedir(), dir.slice(2));
  }
  return dir;
}

function resolveAgentFilesystemPath(agent: Agent, requestedPath?: string): { rootDir: string; targetPath: string; relativePath: string } {
  if (!agent.working_directory) {
    throw new AgentWorkingDirectoryRequiredError();
  }

  try {
    const rootDir = path.resolve(expandWorkingDirectory(agent.working_directory));
    const candidate = path.resolve(rootDir, requestedPath || '.');
    const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
    if (candidate !== rootDir && !candidate.startsWith(rootPrefix)) {
      throw new AgentPathOutsideWorkingDirectoryError();
    }

    return {
      rootDir,
      targetPath: candidate,
      relativePath: candidate === rootDir ? '' : path.relative(rootDir, candidate).split(path.sep).join('/'),
    };
  } catch (error) {
    if (isAgentFileServiceError(error)) throw error;
    throw new AgentPathResolutionError();
  }
}

function decodeTextFile(buffer: Buffer): string | null {
  if (!buffer.length) {
    return '';
  }

  if (buffer.includes(0)) {
    return null;
  }

  const sampleSize = Math.min(buffer.length, 1024);
  let controlCharCount = 0;
  for (let i = 0; i < sampleSize; i += 1) {
    const byte = buffer[i];
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      controlCharCount += 1;
    }
  }

  if (controlCharCount / sampleSize > 0.2) {
    return null;
  }

  try {
    return utf8Decoder.decode(buffer);
  } catch {
    return null;
  }
}

function isAgentFileServiceError(error: unknown): boolean {
  return error instanceof AgentWorkingDirectoryRequiredError
    || error instanceof AgentPathOutsideWorkingDirectoryError
    || error instanceof AgentPathResolutionError
    || error instanceof AgentFileNotFoundError
    || error instanceof AgentFileAccessDeniedError
    || error instanceof AgentFileOperationFailedError
    || error instanceof AgentDirectoryExpectedError
    || error instanceof AgentFileExpectedError
    || error instanceof AgentFilePathRequiredError
    || error instanceof AgentFileContentTypeError
    || error instanceof AgentFileTooLargeError
    || error instanceof AgentBinaryPreviewUnsupportedError
    || error instanceof AgentPreviewFileTypeUnsupportedError
    || error instanceof AgentUploadMissingFileError
    || error instanceof AgentSQLiteFileUnsupportedError
    || error instanceof AgentSQLiteTableNotFoundError;
}

function throwAgentFileSystemError(error: unknown): never {
  if (!(error instanceof Error)) {
    throw new AgentFileOperationFailedError();
  }

  const fsError = error as NodeJS.ErrnoException;
  if (fsError.code === 'ENOENT') {
    throw new AgentFileNotFoundError();
  }
  if (fsError.code === 'EACCES' || fsError.code === 'EPERM') {
    throw new AgentFileAccessDeniedError();
  }
  if (fsError.code === 'EISDIR') {
    throw new AgentFileExpectedError();
  }
  throw new AgentFileOperationFailedError();
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function listAgentFiles(agentId: string, requestedPath?: string, showHiddenValue?: string): Promise<AgentFileListResult> {
  const agent = getAgent(agentId);
  const resolvedPath = resolveAgentFilesystemPath(agent, requestedPath);
  const showHidden = showHiddenValue === '1' || showHiddenValue === 'true';

  try {
    const targetStat = await fs.stat(resolvedPath.targetPath);
    if (!targetStat.isDirectory()) {
      throw new AgentDirectoryExpectedError();
    }

    const dirents = await fs.readdir(resolvedPath.targetPath, { withFileTypes: true });
    const visibleEntries = dirents.filter((entry) => showHidden || !entry.name.startsWith('.'));
    const entries = (await Promise.all(visibleEntries.map(async (entry) => {
      const entryPath = path.join(resolvedPath.targetPath, entry.name);
      try {
        const entryStat = await fs.stat(entryPath);
        const relativeEntryPath = resolvedPath.relativePath
          ? path.posix.join(resolvedPath.relativePath, entry.name)
          : entry.name;
        return {
          name: entry.name,
          path: relativeEntryPath,
          type: entry.isDirectory() ? 'dir' as const : 'file' as const,
          size: entryStat.size,
          modified: entryStat.mtime.toISOString(),
        };
      } catch {
        return null;
      }
    }))).filter(Boolean) as AgentFileListEntry[];

    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'dir' ? -1 : 1;
      }
      return new Date(b.modified).getTime() - new Date(a.modified).getTime();
    });

    return {
      path: resolvedPath.relativePath,
      showHidden,
      entries,
    };
  } catch (error) {
    if (isAgentFileServiceError(error)) throw error;
    throwAgentFileSystemError(error);
  }
}

export async function getAgentFileContent(agentId: string, requestedPath?: string): Promise<string> {
  if (!requestedPath) throw new AgentFilePathRequiredError();

  const agent = getAgent(agentId);
  const resolvedPath = resolveAgentFilesystemPath(agent, requestedPath);

  try {
    const targetStat = await fs.stat(resolvedPath.targetPath);
    if (!targetStat.isFile()) {
      throw new AgentFileExpectedError();
    }
    if (targetStat.size > MAX_AGENT_FILE_SIZE) {
      throw new AgentFileTooLargeError('File exceeds the 1 MB limit');
    }

    const buffer = await fs.readFile(resolvedPath.targetPath);
    if (buffer.length > MAX_AGENT_FILE_SIZE) {
      throw new AgentFileTooLargeError('File exceeds the 1 MB limit');
    }

    const content = decodeTextFile(buffer);
    if (content === null) {
      throw new AgentBinaryPreviewUnsupportedError();
    }

    return content;
  } catch (error) {
    if (isAgentFileServiceError(error)) throw error;
    throwAgentFileSystemError(error);
  }
}

export async function serveAgentFile(agentId: string, requestedPath?: string): Promise<AgentFileServeResult> {
  if (!requestedPath) throw new AgentFilePathRequiredError();

  const agent = getAgent(agentId);
  const resolvedPath = resolveAgentFilesystemPath(agent, requestedPath);

  try {
    const targetStat = await fs.stat(resolvedPath.targetPath);
    if (!targetStat.isFile()) {
      throw new AgentFileExpectedError();
    }
    if (targetStat.size > MAX_SERVE_FILE_SIZE) {
      throw new AgentFileTooLargeError('File exceeds the 10 MB limit');
    }

    const ext = path.extname(resolvedPath.targetPath).toLowerCase();
    const contentType = SERVE_CONTENT_TYPES[ext];
    if (!contentType) {
      throw new AgentPreviewFileTypeUnsupportedError();
    }

    const buffer = await fs.readFile(resolvedPath.targetPath);
    return {
      buffer,
      contentType,
      applyHtmlPreviewCsp: ext === '.html' || ext === '.htm',
    };
  } catch (error) {
    if (isAgentFileServiceError(error)) throw error;
    throwAgentFileSystemError(error);
  }
}

export async function saveAgentFileContent(agentId: string, input: { path?: string; content?: string }): Promise<AgentFileSaveResult> {
  const filePath = typeof input?.path === 'string' ? input.path.trim() : '';
  if (!filePath) {
    throw new AgentFilePathRequiredError();
  }

  if (typeof input?.content !== 'string') {
    throw new AgentFileContentTypeError();
  }

  if (Buffer.byteLength(input.content, 'utf-8') > MAX_AGENT_FILE_SIZE) {
    throw new AgentFileTooLargeError('File exceeds the 1 MB limit');
  }

  const agent = getAgent(agentId);
  const resolvedPath = resolveAgentFilesystemPath(agent, filePath);

  try {
    const existing = await fs.stat(resolvedPath.targetPath).catch((statError: NodeJS.ErrnoException) => {
      if (statError.code === 'ENOENT') {
        return null;
      }
      throw statError;
    });
    if (existing && !existing.isFile()) {
      throw new AgentFileExpectedError();
    }

    await fs.writeFile(resolvedPath.targetPath, input.content, 'utf-8');
    const savedStat = await fs.stat(resolvedPath.targetPath);
    return {
      success: true,
      path: resolvedPath.relativePath,
      size: savedStat.size,
      modified: savedStat.mtime.toISOString(),
    };
  } catch (error) {
    if (isAgentFileServiceError(error)) throw error;
    throwAgentFileSystemError(error);
  }
}

export async function saveAgentUploadedFile(
  agentId: string,
  targetDir: string,
  fileName: string,
  buffer: Buffer
): Promise<AgentFileUploadResult> {
  const agent = getAgent(agentId);
  const filePath = targetDir ? path.posix.join(targetDir, fileName) : fileName;
  const resolvedPath = resolveAgentFilesystemPath(agent, filePath);

  try {
    await fs.mkdir(path.dirname(resolvedPath.targetPath), { recursive: true });
    await fs.writeFile(resolvedPath.targetPath, buffer);
    const savedStat = await fs.stat(resolvedPath.targetPath);
    return {
      success: true,
      path: resolvedPath.relativePath,
      name: fileName,
      size: savedStat.size,
    };
  } catch (error) {
    if (isAgentFileServiceError(error)) throw error;
    throwAgentFileSystemError(error);
  }
}

export function finalizeAgentFileUpload(uploaded: AgentFileUploadResult[]): AgentFileUploadResponse {
  if (uploaded.length === 0) {
    throw new AgentUploadMissingFileError();
  }
  if (uploaded.length === 1) {
    return uploaded[0];
  }
  return { success: true, files: uploaded };
}

export async function downloadAgentFile(agentId: string, requestedPath?: string): Promise<AgentFileDownloadResult> {
  if (!requestedPath) throw new AgentFilePathRequiredError();

  const agent = getAgent(agentId);
  const resolvedPath = resolveAgentFilesystemPath(agent, requestedPath);

  try {
    const targetStat = await fs.stat(resolvedPath.targetPath);
    if (!targetStat.isFile()) {
      throw new AgentFileExpectedError();
    }

    const ext = path.extname(resolvedPath.targetPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const fileName = path.basename(resolvedPath.targetPath);
    const buffer = await fs.readFile(resolvedPath.targetPath);

    return { buffer, contentType, fileName };
  } catch (error) {
    if (isAgentFileServiceError(error)) throw error;
    throwAgentFileSystemError(error);
  }
}

export async function previewAgentSqliteFile(
  agentId: string,
  requestedPath?: string,
  tableName?: string,
  limitValue?: string,
  offsetValue?: string
): Promise<any> {
  if (!requestedPath) throw new AgentFilePathRequiredError();

  const agent = getAgent(agentId);
  const resolvedPath = resolveAgentFilesystemPath(agent, requestedPath);
  const ext = path.extname(resolvedPath.targetPath).toLowerCase();
  if (!SQLITE_EXTENSIONS.has(ext)) {
    throw new AgentSQLiteFileUnsupportedError();
  }

  try {
    const targetStat = await fs.stat(resolvedPath.targetPath);
    if (!targetStat.isFile()) {
      throw new AgentFileExpectedError();
    }
    if (targetStat.size > MAX_SQLITE_FILE_SIZE) {
      throw new AgentFileTooLargeError('SQLite file exceeds 50 MB limit');
    }

    const sqliteDb = new Database(resolvedPath.targetPath, { readonly: true, fileMustExist: true });
    try {
      const tables = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];

      if (!tableName) {
        const tableInfo = tables.map((table) => {
          const countRow = sqliteDb.prepare(`SELECT COUNT(*) as count FROM ${quoteSqliteIdentifier(table.name)}`).get() as { count: number };
          return { name: table.name, rowCount: countRow.count };
        });
        return { tables: tableInfo, path: resolvedPath.relativePath, size: targetStat.size };
      }

      if (!tables.some((table) => table.name === tableName)) {
        throw new AgentSQLiteTableNotFoundError(tableName);
      }

      const limit = Math.min(Number.parseInt(limitValue || '100', 10), 500);
      const offset = Math.max(Number.parseInt(offsetValue || '0', 10), 0);
      const quotedTableName = quoteSqliteIdentifier(tableName);
      const columns = sqliteDb.prepare(`PRAGMA table_info(${quotedTableName})`).all() as { name: string; type: string }[];
      const rows = sqliteDb.prepare(`SELECT * FROM ${quotedTableName} LIMIT ? OFFSET ?`).all(limit, offset);
      const countRow = sqliteDb.prepare(`SELECT COUNT(*) as count FROM ${quotedTableName}`).get() as { count: number };

      return {
        table: tableName,
        columns: columns.map((column) => ({ name: column.name, type: column.type })),
        rows,
        totalRows: countRow.count,
        limit,
        offset,
      };
    } finally {
      sqliteDb.close();
    }
  } catch (error) {
    if (isAgentFileServiceError(error)) throw error;
    throwAgentFileSystemError(error);
  }
}
