import * as os from 'os';
import * as path from 'path';

export function expandHomePath(dir: string): string {
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2));
  return dir;
}
