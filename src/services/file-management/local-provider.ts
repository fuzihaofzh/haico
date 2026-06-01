import * as fs from 'fs/promises';
import type { Stats } from 'fs';
import * as path from 'path';
import { FileStat, StorageProvider } from './types';
import { expandHomePath } from './paths';
import { decodeTextFile } from './text-decode';
import {
  PathOutsideRootError,
  PathResolutionError,
  FileNotFoundError,
  FileAccessDeniedError,
  FileOperationFailedError,
  DirectoryExpectedError,
  FileExpectedError,
  BinaryFileError,
} from './errors';

export class LocalStorageProvider implements StorageProvider {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(expandHomePath(rootDir));
  }

  private resolve(relativePath: string): string {
    try {
      const candidate = path.resolve(this.rootDir, relativePath || '.');
      const rootPrefix = this.rootDir.endsWith(path.sep) ? this.rootDir : `${this.rootDir}${path.sep}`;
      if (candidate !== this.rootDir && !candidate.startsWith(rootPrefix)) {
        throw new PathOutsideRootError();
      }
      return candidate;
    } catch (error) {
      if (error instanceof PathOutsideRootError) throw error;
      throw new PathResolutionError();
    }
  }

  private toRelative(absolutePath: string): string {
    if (absolutePath === this.rootDir) return '';
    return path.relative(this.rootDir, absolutePath).split(path.sep).join('/');
  }

  private toFileStat(name: string, absolutePath: string, stat: Stats): FileStat {
    return {
      name,
      path: this.toRelative(absolutePath),
      type: stat.isDirectory() ? 'dir' : 'file',
      size: stat.size,
      modified: stat.mtime.toISOString(),
    };
  }

  async readdir(dirPath: string, options?: { showHidden?: boolean }): Promise<FileStat[]> {
    const abs = this.resolve(dirPath);
    const showHidden = options?.showHidden ?? false;

    try {
      const targetStat = await fs.stat(abs);
      if (!targetStat.isDirectory()) {
        throw new DirectoryExpectedError(dirPath);
      }

      const dirents = await fs.readdir(abs, { withFileTypes: true });
      const visible = dirents.filter((entry) => showHidden || !entry.name.startsWith('.'));

      const entries: FileStat[] = [];
      for (const entry of visible) {
        try {
          const entryAbs = path.join(abs, entry.name);
          const entryStat = await fs.stat(entryAbs);
          entries.push(this.toFileStat(entry.name, entryAbs, entryStat));
        } catch {
          // skip inaccessible entries
        }
      }

      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return new Date(b.modified).getTime() - new Date(a.modified).getTime();
      });

      return entries;
    } catch (error) {
      this.mapFsError(error, dirPath);
    }
  }

  async readFile(filePath: string): Promise<Buffer> {
    const abs = this.resolve(filePath);
    try {
      return await fs.readFile(abs);
    } catch (error) {
      this.mapFsError(error, filePath);
    }
  }

  async readTextFile(filePath: string): Promise<string> {
    const abs = this.resolve(filePath);
    try {
      const buffer = await fs.readFile(abs);
      const content = decodeTextFile(buffer);
      if (content === null) {
        throw new BinaryFileError();
      }
      return content;
    } catch (error) {
      if (error instanceof BinaryFileError) throw error;
      this.mapFsError(error, filePath);
    }
  }

  async writeFile(filePath: string, content: string | Buffer, options?: { encoding?: string }): Promise<FileStat> {
    const abs = this.resolve(filePath);
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, options?.encoding as BufferEncoding | undefined);
      const savedStat = await fs.stat(abs);
      return this.toFileStat(path.basename(abs), abs, savedStat);
    } catch (error) {
      this.mapFsError(error, filePath);
    }
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    const abs = this.resolve(dirPath);
    try {
      await fs.mkdir(abs, { recursive: options?.recursive ?? true });
    } catch (error) {
      this.mapFsError(error, dirPath);
    }
  }

  async unlink(filePath: string): Promise<void> {
    const abs = this.resolve(filePath);
    try {
      await fs.unlink(abs);
    } catch (error) {
      this.mapFsError(error, filePath);
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const abs = this.resolve(filePath);
    try {
      const s = await fs.stat(abs);
      return this.toFileStat(path.basename(abs), abs, s);
    } catch (error) {
      this.mapFsError(error, filePath);
    }
  }

  async materializeLocalPath(filePath: string): Promise<string> {
    return this.resolve(filePath);
  }

  async releaseLocalPath(_localPath: string): Promise<void> {
    // Local files need no cleanup
  }

  private mapFsError(error: unknown, filePath: string): never {
    if (
      error instanceof PathOutsideRootError
      || error instanceof PathResolutionError
      || error instanceof FileNotFoundError
      || error instanceof FileAccessDeniedError
      || error instanceof FileOperationFailedError
      || error instanceof DirectoryExpectedError
      || error instanceof FileExpectedError
      || error instanceof BinaryFileError
    ) {
      throw error;
    }

    if (!(error instanceof Error)) {
      throw new FileOperationFailedError(filePath);
    }

    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code === 'ENOENT') {
      throw new FileNotFoundError(filePath);
    }
    if (fsError.code === 'EACCES' || fsError.code === 'EPERM') {
      throw new FileAccessDeniedError(filePath);
    }
    if (fsError.code === 'EISDIR') {
      throw new FileExpectedError(filePath);
    }
    if (fsError.code === 'ENOTDIR') {
      throw new DirectoryExpectedError(filePath);
    }
    throw new FileOperationFailedError(filePath);
  }
}
