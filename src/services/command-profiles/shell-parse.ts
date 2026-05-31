import fs from 'fs';
import path from 'path';

export function trimString(value: unknown): string {
  return String(value || '').trim();
}

export function shellWords(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) words.push(current);
  return words;
}

export function shellQuoteLiteral(value: string): string {
  if (!value) return "''";
  if (/^[A-Za-z0-9_./:=+,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
    const eqIndex = value.indexOf('=');
    return `${value.slice(0, eqIndex)}=${shellQuoteLiteral(value.slice(eqIndex + 1))}`;
  }
  return shellQuoteLiteral(value);
}

export function extractCommandBinary(commandTemplate: string): string {
  const words = shellWords(commandTemplate);
  if (!words.length) return '';

  let index = 0;
  if (words[0] === 'env') {
    index = 1;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index])) {
      index += 1;
    }
    if (words[index] === '--') index += 1;
  }

  return words[index] || words[0];
}

export function resolveExecutableOnPath(binary: string): string | null {
  const normalized = trimString(binary);
  if (!normalized) return null;

  if (normalized.includes('/') || normalized.startsWith('.')) {
    return fs.existsSync(normalized) ? normalized : null;
  }

  const pathValue = trimString(process.env.PATH);
  if (!pathValue) return null;

  for (const dir of pathValue.split(path.delimiter)) {
    const candidate = path.join(dir, normalized);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveCodexScriptPath(commandToken: string): string | null {
  const resolvedPath = resolveExecutableOnPath(commandToken);
  if (!resolvedPath) return null;

  try {
    const realPath = fs.realpathSync(resolvedPath);
    if (path.basename(realPath) === 'codex.js') {
      return realPath;
    }
    if (path.basename(realPath) === 'codex') {
      const jsSibling = `${realPath}.js`;
      if (fs.existsSync(jsSibling)) {
        return jsSibling;
      }
    }
  } catch {
    return null;
  }

  return null;
}
