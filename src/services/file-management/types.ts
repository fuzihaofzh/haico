export interface FileStat {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  modified: string;
}

export interface StorageProvider {
  readdir(dirPath: string, options?: { showHidden?: boolean }): Promise<FileStat[]>;
  readFile(filePath: string): Promise<Buffer>;
  readTextFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string | Buffer, options?: { encoding?: string }): Promise<FileStat>;
  mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void>;
  unlink(filePath: string): Promise<void>;
  stat(filePath: string): Promise<FileStat>;
  materializeLocalPath(filePath: string): Promise<string>;
  releaseLocalPath(localPath: string): Promise<void>;
}
