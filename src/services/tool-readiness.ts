import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CommandProfileType } from '../types';
import { resolveCommandType } from './command-profiles';

export interface ToolReadinessIssue {
  code: 'missing_command' | 'missing_cli' | 'auth_missing';
  severity: 'blocking' | 'warning';
  title: string;
  detail: string;
  action_label: string | null;
  action_command: string | null;
}

export interface ToolAuthReadiness {
  status: 'configured' | 'missing' | 'unknown';
  confidence: 'env' | 'heuristic' | 'unknown';
  message: string;
  action_command: string | null;
}

export interface ToolReadinessSummary {
  command: string;
  command_type: CommandProfileType | null;
  tool_label: string;
  binary: string;
  binary_found: boolean;
  binary_path: string | null;
  ready: boolean;
  issues: ToolReadinessIssue[];
  auth: ToolAuthReadiness;
}

function shellWords(input: string): string[] {
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

function extractCommandBinary(commandTemplate: string): string {
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

function resolveBinaryPath(binary: string): string | null {
  if (!binary) return null;
  const shellPath = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const args = shellPath.endsWith('bash')
    ? ['-lc', 'command -v -- "$1"', '_', binary]
    : ['-c', 'command -v -- "$1"', '_', binary];
  const result = spawnSync(shellPath, args, {
    encoding: 'utf-8',
    timeout: 3000,
    env: { ...process.env },
  });
  if (result.status !== 0) return null;
  const output = String(result.stdout || '').trim();
  return output || null;
}

function resolveToolLabel(commandType: CommandProfileType | null, binary: string): string {
  if (commandType === 'claude') return 'Claude Code';
  if (commandType === 'codex') return 'Codex CLI';
  if (commandType === 'gemini') return 'Gemini CLI';
  return binary || 'CLI tool';
}

function getRecommendedLoginCommand(commandType: CommandProfileType | null, binary: string): string | null {
  if (!binary) return null;
  if (commandType === 'codex') return `${binary} login`;
  if (commandType === 'claude') return `${binary} login`;
  if (commandType === 'gemini') return `${binary} auth login`;
  return null;
}

function homePath(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

function fileExists(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function inferAuthReadiness(commandType: CommandProfileType | null, binary: string): ToolAuthReadiness {
  const loginCommand = getRecommendedLoginCommand(commandType, binary);

  if (commandType === 'codex') {
    if (String(process.env.OPENAI_API_KEY || '').trim()) {
      return {
        status: 'configured',
        confidence: 'env',
        message: 'OpenAI credentials detected from OPENAI_API_KEY.',
        action_command: null,
      };
    }

    const storedAuthFiles = [
      homePath('.codex', 'auth.json'),
      homePath('.config', 'codex', 'auth.json'),
      homePath('.config', 'openai', 'auth.json'),
    ];
    if (storedAuthFiles.some(fileExists)) {
      return {
        status: 'configured',
        confidence: 'heuristic',
        message: 'Stored Codex credentials were found on this machine.',
        action_command: null,
      };
    }

    return {
      status: 'missing',
      confidence: 'heuristic',
      message: 'No obvious Codex sign-in was found. If this is a fresh machine, run the login command first.',
      action_command: loginCommand,
    };
  }

  if (commandType === 'claude') {
    if (String(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '').trim()) {
      return {
        status: 'configured',
        confidence: 'env',
        message: 'Anthropic credentials detected from environment variables.',
        action_command: null,
      };
    }

    const storedAuthFiles = [
      homePath('.claude.json'),
      homePath('.claude', '.credentials.json'),
      homePath('.config', 'claude', '.credentials.json'),
      homePath('.config', 'claude', 'credentials.json'),
    ];
    if (storedAuthFiles.some(fileExists)) {
      return {
        status: 'configured',
        confidence: 'heuristic',
        message: 'Stored Claude credentials were found on this machine.',
        action_command: null,
      };
    }

    return {
      status: 'missing',
      confidence: 'heuristic',
      message: 'No obvious Claude sign-in was found. If the CLI asks you to authenticate, run the login command first.',
      action_command: loginCommand,
    };
  }

  if (commandType === 'gemini') {
    if (String(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '').trim()) {
      return {
        status: 'configured',
        confidence: 'env',
        message: 'Gemini credentials detected from environment variables.',
        action_command: null,
      };
    }

    const storedAuthFiles = [
      homePath('.config', 'gemini', 'credentials.json'),
      homePath('.gemini', 'credentials.json'),
    ];
    if (storedAuthFiles.some(fileExists)) {
      return {
        status: 'configured',
        confidence: 'heuristic',
        message: 'Stored Gemini credentials were found on this machine.',
        action_command: null,
      };
    }

    return {
      status: 'missing',
      confidence: 'heuristic',
      message: 'No obvious Gemini sign-in was found on this machine.',
      action_command: loginCommand,
    };
  }

  return {
    status: 'unknown',
    confidence: 'unknown',
    message: 'HAICO cannot verify sign-in for this command automatically.',
    action_command: loginCommand,
  };
}

export function inspectToolReadiness(input: {
  commandTemplate?: string | null;
  commandType?: unknown;
}): ToolReadinessSummary {
  const commandTemplate = String(input.commandTemplate || '').trim();
  const commandType = resolveCommandType(input.commandType, commandTemplate);
  const binary = extractCommandBinary(commandTemplate);
  const binaryPath = resolveBinaryPath(binary);
  const binaryFound = !!binaryPath;
  const toolLabel = resolveToolLabel(commandType, binary);
  const auth: ToolAuthReadiness = binaryFound ? inferAuthReadiness(commandType, binary) : {
    status: 'unknown',
    confidence: 'unknown',
    message: 'Install the CLI before HAICO can inspect login status.',
    action_command: getRecommendedLoginCommand(commandType, binary),
  };

  const issues: ToolReadinessIssue[] = [];

  if (!commandTemplate) {
    issues.push({
      code: 'missing_command',
      severity: 'blocking',
      title: 'No Agent Tool selected',
      detail: 'Open Settings and add an Agent Tool before creating a project.',
      action_label: 'Open Settings',
      action_command: null,
    });
  } else if (!binaryFound) {
    issues.push({
      code: 'missing_cli',
      severity: 'blocking',
      title: `${toolLabel} is not available in PATH`,
      detail: `HAICO could not find "${binary}" on this machine. Install it first, then restart HAICO or your shell if needed.`,
      action_label: 'Install CLI',
      action_command: null,
    });
  }

  if (binaryFound && auth.status === 'missing') {
    issues.push({
      code: 'auth_missing',
      severity: 'warning',
      title: `${toolLabel} may still need login`,
      detail: auth.message,
      action_label: auth.action_command ? 'Login' : null,
      action_command: auth.action_command,
    });
  }

  return {
    command: commandTemplate,
    command_type: commandType,
    tool_label: toolLabel,
    binary,
    binary_found: binaryFound,
    binary_path: binaryPath,
    ready: issues.every((issue) => issue.severity !== 'blocking'),
    issues,
    auth,
  };
}

function combinedErrorText(error: any): string {
  return [
    error?.message,
    typeof error?.stdout === 'string' ? error.stdout : String(error?.stdout || ''),
    typeof error?.stderr === 'string' ? error.stderr : String(error?.stderr || ''),
  ].filter(Boolean).join('\n');
}

export function classifyToolExecutionFailure(input: {
  error: unknown;
  commandType?: CommandProfileType | null;
  binary?: string;
}): {
  code: 'missing_cli' | 'auth_required' | 'timeout' | 'execution_failed';
  message: string;
  action_command: string | null;
} {
  const binary = String(input.binary || '').trim();
  const text = combinedErrorText(input.error).trim();
  const lowerText = text.toLowerCase();
  const loginCommand = getRecommendedLoginCommand(input.commandType || null, binary);

  if (/\b(command not found|not found|enoent|is not recognized as an internal or external command)\b/i.test(text)) {
    return {
      code: 'missing_cli',
      message: binary
        ? `HAICO could not find "${binary}" on this machine. Install it first and make sure it is on PATH.`
        : 'HAICO could not find the selected CLI on this machine.',
      action_command: null,
    };
  }

  if (
    /\b(login|log in|sign in|signin|authenticate|authentication|unauthorized|api key|access token|token required|401)\b/i.test(lowerText)
  ) {
    return {
      code: 'auth_required',
      message: 'The selected CLI appears to need authentication before HAICO can use it.',
      action_command: loginCommand,
    };
  }

  if (/\b(etimedout|timed out|timeout)\b/i.test(lowerText)) {
    return {
      code: 'timeout',
      message: 'The CLI did not respond in time while generating the project setup.',
      action_command: null,
    };
  }

  return {
    code: 'execution_failed',
    message: text.slice(0, 240) || 'The CLI failed while generating the project setup.',
    action_command: null,
  };
}
