import { spawnSync } from 'child_process';
import fs from 'fs';
import { getAdapterRegistry } from '../adapters';
import { trimString } from '../command-profiles';
import { classifyToolExecutionFailure } from '../tool-readiness';
import { DashChatCliError } from './errors';
import type { AssistantEnvelope } from './types';

/**
 * Resolve the timeout for a single CLI turn based on env override or adapter default.
 */
export function getDashboardChatTimeoutMs(commandTemplate: string, commandType: string | null): number {
  const configured = Number.parseInt(String(process.env.HAICO_DASHBOARD_CHAT_TIMEOUT_MS || ''), 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  const adapter = getAdapterRegistry().resolveFromCommand(commandTemplate, commandType);
  return adapter.chatTimeoutMs;
}

// ── JSON extraction ──────────────────────────────────────────

export function extractJsonObject(text: string): string | null {
  const src = String(text || '');
  const fenceMatch = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : src;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }

  return null;
}

// ── CLI output processing ────────────────────────────────────

export function normalizeCliStream(text: string): string {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

export function isLowSignalCliLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^Node\.js v\d+\.\d+\.\d+$/i.test(trimmed)) return true;
  if (/^file:\/\/\S+$/i.test(trimmed)) return true;
  if (/^\s*at\s.+\(.+\)\s*$/i.test(trimmed)) return true;
  if (/^\s*at\s+\S+\s*$/i.test(trimmed)) return true;
  return false;
}

export function extractErrorWindow(text: string): string {
  const lines = normalizeCliStream(text)
    .split('\n')
    .map((line) => line.trimEnd());
  if (!lines.length) return '';

  const errorIdx = lines.findIndex((line) =>
    /(error|failed|exception|traceback|syntaxerror|referenceerror|typeerror|rangeerror|enoent|unauthorized|authentication|cannot|invalid)/i.test(line)
  );
  if (errorIdx === -1) return '';

  const start = Math.max(0, errorIdx - 1);
  let end = Math.min(lines.length, errorIdx + 6);
  while (end < lines.length && lines[end].trim()) {
    end += 1;
  }

  const windowLines = lines
    .slice(start, end)
    .filter((line) => line.trim())
    .filter((line, idx, arr) => !(isLowSignalCliLine(line) && arr.length > 1));
  return windowLines.join('\n').trim();
}

export function scoreCliBlock(block: string): number {
  const trimmed = block.trim();
  if (!trimmed) return -Infinity;
  const lines = trimmed.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim());
  const meaningfulLines = lines.filter((line) => !isLowSignalCliLine(line));
  let score = meaningfulLines.join('\n').length;
  score += meaningfulLines.length * 10;
  if (/(error|failed|exception|traceback|syntaxerror|referenceerror|typeerror|rangeerror|enoent|unauthorized|authentication|cannot|invalid)/i.test(trimmed)) {
    score += 180;
  }
  if (extractJsonObject(trimmed)) {
    score += 240;
  }
  if (lines.length === 1 && isLowSignalCliLine(lines[0])) {
    score -= 220;
  }
  if (meaningfulLines.length === 0) {
    score -= 160;
  }
  return score;
}

export function extractMeaningfulCliText(text: string): string {
  const normalized = normalizeCliStream(text);
  if (!normalized) return '';

  if (extractJsonObject(normalized)) {
    return normalized;
  }

  const errorWindow = extractErrorWindow(normalized);
  if (errorWindow) {
    return errorWindow;
  }

  const blocks = normalized
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length > 1) {
    const bestBlock = blocks
      .map((block) => ({ block, score: scoreCliBlock(block) }))
      .sort((a, b) => b.score - a.score)[0];
    if (bestBlock?.block) {
      return bestBlock.block;
    }
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const meaningfulLines = lines.filter((line) => !isLowSignalCliLine(line));
  if (meaningfulLines.length > 0) {
    const chosen = meaningfulLines.length <= 8 ? meaningfulLines : meaningfulLines.slice(-8);
    return chosen.join('\n').trim();
  }
  if (lines.length <= 8) {
    return lines.join('\n').trim();
  }
  return lines.slice(-8).join('\n').trim();
}

export function pickCliOutput(stdout: string, stderr: string): { full: string; meaningful: string } {
  const stdoutFull = normalizeCliStream(stdout);
  const stderrFull = normalizeCliStream(stderr);
  const combined = [stdoutFull, stderrFull].filter(Boolean).join('\n');

  if (extractJsonObject(stdoutFull)) {
    return { full: stdoutFull, meaningful: stdoutFull };
  }
  if (extractJsonObject(stderrFull)) {
    return { full: stderrFull, meaningful: stderrFull };
  }
  if (extractJsonObject(combined)) {
    return { full: combined, meaningful: combined };
  }

  const stdoutMeaningful = extractMeaningfulCliText(stdoutFull);
  const stderrMeaningful = extractMeaningfulCliText(stderrFull);
  const combinedMeaningful = extractMeaningfulCliText(combined);

  if (stdoutMeaningful) {
    return { full: stdoutFull || combined, meaningful: stdoutMeaningful };
  }
  if (stderrMeaningful) {
    return { full: stderrFull || combined, meaningful: stderrMeaningful };
  }
  return { full: combined, meaningful: combinedMeaningful };
}

// ── Envelope parsing ─────────────────────────────────────────

export function parseAssistantEnvelope(rawOutput: string): AssistantEnvelope {
  const jsonText = extractJsonObject(rawOutput);
  if (!jsonText) {
    const fallbackMessage = trimString(rawOutput);
    if (!fallbackMessage) {
      throw new DashChatCliError('The CLI returned an empty response');
    }
    return { type: 'answer', message: fallbackMessage };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText) as any;
  } catch {
    const fallbackMessage = trimString(rawOutput);
    if (!fallbackMessage) {
      throw new DashChatCliError('The CLI response could not be parsed');
    }
    return { type: 'answer', message: fallbackMessage };
  }
  const type = trimString(parsed?.type || parsed?.mode).toLowerCase();
  if (type === 'answer' || type === 'final') {
    const message = trimString(parsed?.message || parsed?.content || parsed?.answer);
    if (!message) {
      throw new DashChatCliError('The assistant answer envelope was missing "message"');
    }
    return { type: 'answer', message };
  }

  if (type === 'tool_call' || type === 'tool') {
    const tool = trimString(parsed?.tool || parsed?.name);
    const args = parsed?.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
      ? parsed.arguments
      : {};
    if (!tool) {
      throw new DashChatCliError('The tool envelope was missing "tool"');
    }
    return { type: 'tool_call', tool, arguments: args };
  }

  if (trimString(parsed?.tool || parsed?.name)) {
    return {
      type: 'tool_call',
      tool: trimString(parsed?.tool || parsed?.name),
      arguments: parsed?.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
        ? parsed.arguments
        : {},
    };
  }

  throw new DashChatCliError('The CLI returned an unknown action envelope');
}

// ── CLI turn execution ───────────────────────────────────────

export function runCliTurn(commandTemplate: string, commandType: string | null, prompt: string): string {
  const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const adapter = getAdapterRegistry().resolveFromCommand(commandTemplate, commandType);
  const cli = adapter.buildChatCommand(commandTemplate);
  const timeoutMs = getDashboardChatTimeoutMs(commandTemplate, commandType);
  const result = spawnSync(shell, ['-lc', cli.command], {
    input: prompt,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: { ...process.env },
    maxBuffer: 8 * 1024 * 1024,
  });

  const output = pickCliOutput(String(result.stdout || ''), String(result.stderr || ''));

  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    if (error?.code === 'ETIMEDOUT') {
      const partial = trimString(output.meaningful || output.full || '');
      const seconds = Math.round(timeoutMs / 1000);
      throw new DashChatCliError(
        partial
          ? `The selected Agent Tool timed out after ${seconds}s. Partial output:\n${partial.slice(0, 800)}`
          : `The selected Agent Tool timed out after ${seconds}s. Try a smaller request or choose a faster Agent Tool.`
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const rawFailureText = trimString(output.meaningful || output.full || '');
    const failure = classifyToolExecutionFailure({
      error: rawFailureText || `CLI exited with ${result.status}`,
      commandType: adapter.type as any,
      binary: cli.binary,
    });
    const message = failure.code === 'execution_failed'
      ? (rawFailureText.slice(0, 240) || `The selected Agent Tool exited with status ${result.status}.`)
      : failure.message;
    const err = new DashChatCliError(message);
    (err as any).failure = failure;
    throw err;
  }

  const finalText = trimString(output.meaningful || output.full || '');
  if (finalText) return finalText;
  throw new DashChatCliError('The selected Agent Tool finished but produced no usable output.');
}
