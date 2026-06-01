import Database from 'better-sqlite3';
import * as path from 'path';
import { Agent } from '../../types';
import { getAgent } from './core';
import { LocalStorageProvider, FileNotFoundError, FileAccessDeniedError, FileOperationFailedError, DirectoryExpectedError, FileExpectedError, BinaryFileError, PathOutsideRootError, PathResolutionError } from '../file-management';
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
} from './file-errors';
import {
  MAX_AGENT_FILE_SIZE,
  MAX_SERVE_FILE_SIZE,
  MAX_SQLITE_FILE_SIZE,
  MIME_TYPES,
  SERVE_CONTENT_TYPES,
  SQLITE_EXTENSIONS,
} from './file-policy';
import {
  AgentFileDownloadResult,
  AgentFileListEntry,
  AgentFileListResult,
  AgentFileSaveResult,
  AgentFileServeResult,
  AgentFileUploadResponse,
  AgentFileUploadResult,
} from './file-types';

function getStorageForAgent(agentId: string): LocalStorageProvider {
  const agent = getAgent(agentId);
  if (!agent.working_directory) {
    throw new AgentWorkingDirectoryRequiredError();
  }
  return new LocalStorageProvider(agent.working_directory);
}

function mapStorageError(error: unknown): never {
  if (error instanceof PathOutsideRootError) throw new AgentPathOutsideWorkingDirectoryError();
  if (error instanceof PathResolutionError) throw new AgentPathResolutionError();
  if (error instanceof FileNotFoundError) throw new AgentFileNotFoundError();
  if (error instanceof FileAccessDeniedError) throw new AgentFileAccessDeniedError();
  if (error instanceof FileOperationFailedError) throw new AgentFileOperationFailedError();
  if (error instanceof DirectoryExpectedError) throw new AgentDirectoryExpectedError();
  if (error instanceof FileExpectedError) throw new AgentFileExpectedError();
  if (error instanceof BinaryFileError) throw new AgentBinaryPreviewUnsupportedError();
  throw new AgentFileOperationFailedError();
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function listAgentFiles(agentId: string, requestedPath?: string, showHiddenValue?: string): Promise<AgentFileListResult> {
  const storage = getStorageForAgent(agentId);
  const showHidden = showHiddenValue === '1' || showHiddenValue === 'true';

  try {
    const entries = await storage.readdir(requestedPath || '', { showHidden });
    return {
      path: requestedPath || '',
      showHidden,
      entries: entries as AgentFileListEntry[],
    };
  } catch (error) {
    if (error instanceof AgentWorkingDirectoryRequiredError) throw error;
    mapStorageError(error);
  }
}

export async function getAgentFileContent(agentId: string, requestedPath?: string): Promise<string> {
  if (!requestedPath) throw new AgentFilePathRequiredError();

  const storage = getStorageForAgent(agentId);

  try {
    const stat = await storage.stat(requestedPath);
    if (stat.size > MAX_AGENT_FILE_SIZE) {
      throw new AgentFileTooLargeError('File exceeds the 1 MB limit');
    }

    const content = await storage.readTextFile(requestedPath);
    if (Buffer.byteLength(content, 'utf-8') > MAX_AGENT_FILE_SIZE) {
      throw new AgentFileTooLargeError('File exceeds the 1 MB limit');
    }

    return content;
  } catch (error) {
    if (error instanceof AgentFileTooLargeError) throw error;
    if (error instanceof AgentWorkingDirectoryRequiredError) throw error;
    mapStorageError(error);
  }
}

export async function serveAgentFile(agentId: string, requestedPath?: string): Promise<AgentFileServeResult> {
  if (!requestedPath) throw new AgentFilePathRequiredError();

  const storage = getStorageForAgent(agentId);

  try {
    const stat = await storage.stat(requestedPath);
    if (stat.size > MAX_SERVE_FILE_SIZE) {
      throw new AgentFileTooLargeError('File exceeds the 10 MB limit');
    }

    const ext = path.extname(requestedPath).toLowerCase();
    const contentType = SERVE_CONTENT_TYPES[ext];
    if (!contentType) {
      throw new AgentPreviewFileTypeUnsupportedError();
    }

    const buffer = await storage.readFile(requestedPath);
    return {
      buffer,
      contentType,
      applyHtmlPreviewCsp: ext === '.html' || ext === '.htm',
    };
  } catch (error) {
    if (error instanceof AgentFileTooLargeError) throw error;
    if (error instanceof AgentPreviewFileTypeUnsupportedError) throw error;
    if (error instanceof AgentWorkingDirectoryRequiredError) throw error;
    mapStorageError(error);
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

  const storage = getStorageForAgent(agentId);

  try {
    const existing = await storage.stat(filePath).catch(() => null);
    if (existing && existing.type !== 'file') {
      throw new AgentFileExpectedError();
    }

    const saved = await storage.writeFile(filePath, input.content, { encoding: 'utf-8' });
    return {
      success: true,
      path: saved.path,
      size: saved.size,
      modified: saved.modified,
    };
  } catch (error) {
    if (error instanceof AgentFileExpectedError) throw error;
    if (error instanceof AgentFileContentTypeError) throw error;
    if (error instanceof AgentFileTooLargeError) throw error;
    if (error instanceof AgentWorkingDirectoryRequiredError) throw error;
    mapStorageError(error);
  }
}

export async function saveAgentUploadedFile(
  agentId: string,
  targetDir: string,
  fileName: string,
  buffer: Buffer
): Promise<AgentFileUploadResult> {
  const storage = getStorageForAgent(agentId);
  const filePath = targetDir ? path.posix.join(targetDir, fileName) : fileName;

  try {
    const saved = await storage.writeFile(filePath, buffer);
    return {
      success: true,
      path: saved.path,
      name: fileName,
      size: saved.size,
    };
  } catch (error) {
    if (error instanceof AgentWorkingDirectoryRequiredError) throw error;
    mapStorageError(error);
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

  const storage = getStorageForAgent(agentId);

  try {
    const buffer = await storage.readFile(requestedPath);
    const ext = path.extname(requestedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const fileName = path.basename(requestedPath);

    return { buffer, contentType, fileName };
  } catch (error) {
    if (error instanceof AgentWorkingDirectoryRequiredError) throw error;
    mapStorageError(error);
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

  const storage = getStorageForAgent(agentId);
  const ext = path.extname(requestedPath).toLowerCase();
  if (!SQLITE_EXTENSIONS.has(ext)) {
    throw new AgentSQLiteFileUnsupportedError();
  }

  try {
    const stat = await storage.stat(requestedPath);
    if (stat.type !== 'file') {
      throw new AgentFileExpectedError();
    }
    if (stat.size > MAX_SQLITE_FILE_SIZE) {
      throw new AgentFileTooLargeError('SQLite file exceeds 50 MB limit');
    }

    const localPath = await storage.materializeLocalPath(requestedPath);
    const sqliteDb = new Database(localPath, { readonly: true, fileMustExist: true });
    try {
      const tables = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];

      if (!tableName) {
        const tableInfo = tables.map((table) => {
          const countRow = sqliteDb.prepare(`SELECT COUNT(*) as count FROM ${quoteSqliteIdentifier(table.name)}`).get() as { count: number };
          return { name: table.name, rowCount: countRow.count };
        });
        return { tables: tableInfo, path: requestedPath, size: stat.size };
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
      await storage.releaseLocalPath(localPath);
    }
  } catch (error) {
    if (error instanceof AgentFileExpectedError) throw error;
    if (error instanceof AgentFileTooLargeError) throw error;
    if (error instanceof AgentSQLiteFileUnsupportedError) throw error;
    if (error instanceof AgentSQLiteTableNotFoundError) throw error;
    if (error instanceof AgentWorkingDirectoryRequiredError) throw error;
    mapStorageError(error);
  }
}
