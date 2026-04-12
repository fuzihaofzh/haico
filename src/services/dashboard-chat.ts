import { spawnSync } from 'child_process';
import fs from 'fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'path';
import { config } from '../config';
import { getDatabase } from '../db/database';
import { resolveCommandType } from './command-profiles';
import { classifyToolExecutionFailure, inspectToolReadiness } from './tool-readiness';

export interface DashboardChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DashboardChatInput {
  message: string;
  messages?: DashboardChatMessage[];
  project_id?: string | null;
  command_profile_id?: string | null;
  command?: string | null;
  command_type?: string | null;
}

export interface DashboardChatToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface DashboardChatResult {
  message: string;
  tool_calls: DashboardChatToolCall[];
  command: {
    template: string;
    type: string | null;
    profile_id: string | null;
    profile_name: string;
  };
}

interface CommandSelection {
  template: string;
  type: string | null;
  profileId: string | null;
  profileName: string;
}

interface JsonResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string;
  rawText: string;
}

interface ChatProjectSummary {
  id: string;
  name: string;
  description: string;
  status: string;
  is_remote: boolean;
  remote_instance_name: string | null;
  remote_base_url: string | null;
  can_manage: boolean;
  permission_level: string | null;
  color: string | null;
  updated_at: string | null;
  stats: {
    agents: number;
    running: number;
    agentError: number;
    issues: number;
    openIssues: number;
    controllerAgentId: string | null;
  };
}

interface ChatToolContext {
  fastify: FastifyInstance;
  request: FastifyRequest;
  command: CommandSelection;
  availableProjects: ChatProjectSummary[];
}

type ParsedProjectId =
  | { kind: 'local'; projectId: string }
  | { kind: 'remote'; instanceId: string; projectId: string };

type ParsedIssueId =
  | { kind: 'local'; issueId: string }
  | { kind: 'remote'; instanceId: string; issueId: string };

type AssistantEnvelope =
  | { type: 'answer'; message: string }
  | { type: 'tool_call'; tool: string; arguments: Record<string, unknown> };

const MAX_CHAT_STEPS = 8;
const MAX_HISTORY_MESSAGES = 12;
const MAX_TOOL_RESULT_CHARS = 6000;
const DEFAULT_CHAT_TIMEOUT_MS = 180000;

function getDashboardChatTimeoutMs(commandType: string | null): number {
  const configured = Number.parseInt(String(process.env.HAICO_DASHBOARD_CHAT_TIMEOUT_MS || ''), 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  if (commandType === 'codex') return 240000;
  if (commandType === 'claude') return 180000;
  if (commandType === 'gemini') return 180000;
  return DEFAULT_CHAT_TIMEOUT_MS;
}

function trimString(value: unknown): string {
  return String(value || '').trim();
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

function shellQuoteLiteral(value: string): string {
  if (!value) return "''";
  if (/^[A-Za-z0-9_./:=+,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
    const eqIndex = value.indexOf('=');
    return `${value.slice(0, eqIndex)}=${shellQuoteLiteral(value.slice(eqIndex + 1))}`;
  }
  return shellQuoteLiteral(value);
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

function resolveExecutableOnPath(binary: string): string | null {
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

function resolveCodexScriptPath(commandToken: string): string | null {
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

function normalizeMessages(messages: DashboardChatMessage[] | undefined, latestMessage: string): DashboardChatMessage[] {
  const normalized = Array.isArray(messages)
    ? messages
      .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
      .map((message) => ({
        role: message.role,
        content: trimString(message.content),
      }))
      .filter((message) => message.content)
    : [];

  if (!normalized.length || normalized[normalized.length - 1].role !== 'user' || normalized[normalized.length - 1].content !== latestMessage) {
    normalized.push({ role: 'user', content: latestMessage });
  }

  return normalized.slice(-MAX_HISTORY_MESSAGES);
}

function forwardHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (typeof request.headers.cookie === 'string' && request.headers.cookie.trim()) {
    headers.cookie = request.headers.cookie;
  }
  if (typeof request.headers.authorization === 'string' && request.headers.authorization.trim()) {
    headers.authorization = request.headers.authorization;
  }
  return headers;
}

async function injectJson<T>(
  fastify: FastifyInstance,
  request: FastifyRequest,
  input: { method?: string; url: string; payload?: unknown }
): Promise<JsonResult<T>> {
  const response: any = await (fastify.inject as any)({
    method: input.method || (input.payload === undefined ? 'GET' : 'POST'),
    url: input.url,
    payload: input.payload === undefined ? undefined : JSON.stringify(input.payload),
    headers: input.payload === undefined
      ? forwardHeaders(request)
      : { ...forwardHeaders(request), 'content-type': 'application/json' },
  });

  const rawText = String(response.body || response.payload || '');
  let data: T | null = null;
  if (rawText) {
    try {
      data = JSON.parse(rawText) as T;
    } catch {
      data = null;
    }
  }

  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    data,
    error: response.statusCode >= 200 && response.statusCode < 300
      ? ''
      : String((data as any)?.error || rawText || `Request failed with ${response.statusCode}`),
    rawText,
  };
}

function parseRemoteProjectId(value: string): ParsedProjectId | null {
  const match = /^remote:([^:]+):(.+)$/.exec(trimString(value));
  if (!match) return null;
  return { kind: 'remote', instanceId: match[1], projectId: match[2] };
}

function parseRemoteIssueId(value: string): ParsedIssueId | null {
  const match = /^remote-issue:([^:]+):(.+)$/.exec(trimString(value));
  if (!match) return null;
  return { kind: 'remote', instanceId: match[1], issueId: match[2] };
}

function parseProjectId(value: unknown): ParsedProjectId | null {
  const normalized = trimString(value);
  if (!normalized) return null;
  return parseRemoteProjectId(normalized) || { kind: 'local', projectId: normalized };
}

function parseIssueId(value: unknown): ParsedIssueId | null {
  const normalized = trimString(value);
  if (!normalized) return null;
  return parseRemoteIssueId(normalized) || { kind: 'local', issueId: normalized };
}

function buildProjectApiPath(projectId: unknown, suffix = ''): string {
  const parsed = parseProjectId(projectId);
  if (!parsed) return '';
  if (parsed.kind === 'remote') {
    return `/api/remote-projects/${encodeURIComponent(parsed.instanceId)}/${encodeURIComponent(parsed.projectId)}${suffix}`;
  }
  return `/api/projects/${encodeURIComponent(parsed.projectId)}${suffix}`;
}

function buildIssueApiPath(issueId: unknown, suffix = ''): string {
  const parsed = parseIssueId(issueId);
  if (!parsed) return '';
  if (parsed.kind === 'remote') {
    return `/api/remote-issues/${encodeURIComponent(parsed.instanceId)}/${encodeURIComponent(parsed.issueId)}${suffix}`;
  }
  return `/api/issues/${encodeURIComponent(parsed.issueId)}${suffix}`;
}

function inferLanguageLabel(text: string): string {
  if (/[\u4e00-\u9fff]/.test(text)) return 'Chinese';
  if (/[ぁ-んァ-ヶ]/.test(text)) return 'Japanese';
  if (/[가-힣]/.test(text)) return 'Korean';
  return 'same as the user';
}

function summarizeProject(project: any): ChatProjectSummary {
  return {
    id: trimString(project?.id),
    name: trimString(project?.name),
    description: trimString(project?.description),
    status: trimString(project?.status) || 'active',
    is_remote: Boolean(project?.is_remote),
    remote_instance_name: trimString(project?.remote_instance_name) || null,
    remote_base_url: trimString(project?.remote_base_url) || null,
    can_manage: Boolean(project?.can_manage),
    permission_level: trimString(project?.permission_level) || null,
    color: trimString(project?.color) || null,
    updated_at: trimString(project?.updated_at) || null,
    stats: {
      agents: Number(project?.stats?.agents || 0),
      running: Number(project?.stats?.running || 0),
      agentError: Number(project?.stats?.agentError || 0),
      issues: Number(project?.stats?.issues || 0),
      openIssues: Number(project?.stats?.openIssues || 0),
      controllerAgentId: trimString(project?.stats?.controllerAgentId) || null,
    },
  };
}

async function loadAccessibleProjects(ctx: ChatToolContext): Promise<ChatProjectSummary[]> {
  const [localRes, remoteRes] = await Promise.all([
    injectJson<any[]>(ctx.fastify, ctx.request, { url: '/api/projects?with_stats=1' }),
    injectJson<{ projects?: any[] }>(ctx.fastify, ctx.request, { url: '/api/remote-projects' }),
  ]);

  if (!localRes.ok) {
    throw new Error(localRes.error || 'Failed to load accessible projects');
  }

  const localProjects = Array.isArray(localRes.data) ? localRes.data : [];
  const remoteProjects = Array.isArray(remoteRes.data?.projects) ? remoteRes.data?.projects : [];
  return localProjects.concat(remoteProjects).map(summarizeProject);
}

function truncateForPrompt(value: unknown, maxChars = MAX_TOOL_RESULT_CHARS): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...truncated...`;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function scoreProjectMatch(project: ChatProjectSummary, query: string): number {
  const q = trimString(query).toLowerCase();
  if (!q) return 1;
  const name = project.name.toLowerCase();
  const desc = project.description.toLowerCase();
  if (name === q) return 100;
  if (name.includes(q)) return 80;
  if (desc.includes(q)) return 50;
  const terms = q.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 20;
    if (desc.includes(term)) score += 10;
  }
  return score;
}

function extractJsonObject(text: string): string | null {
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

function normalizeCliStream(text: string): string {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function isLowSignalCliLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^Node\.js v\d+\.\d+\.\d+$/i.test(trimmed)) return true;
  if (/^file:\/\/\S+$/i.test(trimmed)) return true;
  if (/^\s*at\s.+\(.+\)\s*$/i.test(trimmed)) return true;
  if (/^\s*at\s+\S+\s*$/i.test(trimmed)) return true;
  return false;
}

function extractErrorWindow(text: string): string {
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

function scoreCliBlock(block: string): number {
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

function extractMeaningfulCliText(text: string): string {
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

function pickCliOutput(stdout: string, stderr: string): { full: string; meaningful: string } {
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

function parseAssistantEnvelope(rawOutput: string): AssistantEnvelope {
  const jsonText = extractJsonObject(rawOutput);
  if (!jsonText) {
    const fallbackMessage = trimString(rawOutput);
    if (!fallbackMessage) {
      throw new Error('The CLI returned an empty response');
    }
    return { type: 'answer', message: fallbackMessage };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText) as any;
  } catch {
    const fallbackMessage = trimString(rawOutput);
    if (!fallbackMessage) {
      throw new Error('The CLI response could not be parsed');
    }
    return { type: 'answer', message: fallbackMessage };
  }
  const type = trimString(parsed?.type || parsed?.mode).toLowerCase();
  if (type === 'answer' || type === 'final') {
    const message = trimString(parsed?.message || parsed?.content || parsed?.answer);
    if (!message) {
      throw new Error('The assistant answer envelope was missing "message"');
    }
    return { type: 'answer', message };
  }

  if (type === 'tool_call' || type === 'tool') {
    const tool = trimString(parsed?.tool || parsed?.name);
    const args = parsed?.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
      ? parsed.arguments
      : {};
    if (!tool) {
      throw new Error('The tool envelope was missing "tool"');
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

  throw new Error('The CLI returned an unknown action envelope');
}

function buildCliCommand(commandTemplate: string, commandType: string | null): { command: string; binary: string } {
  const binary = extractCommandBinary(commandTemplate);
  const lowerCommand = trimString(commandTemplate).toLowerCase();

  if (commandType === 'claude') {
    return { command: `${commandTemplate} -p`, binary };
  }
  if (commandType === 'gemini' || lowerCommand.startsWith('gemini')) {
    return { command: `${commandTemplate} --output-format text -p`, binary };
  }
  if (commandType === 'codex') {
    const words = shellWords(commandTemplate);
    const hasExplicitExec = words.includes('exec');
    const codexIndex = words.findIndex((word) => {
      const base = path.basename(word).toLowerCase();
      return base === 'codex' || base === 'codex.js';
    });
    if (codexIndex >= 0) {
      const codexScriptPath = resolveCodexScriptPath(words[codexIndex]);
      if (codexScriptPath) {
        const launcherIndex = codexIndex > 0 && /^node(?:\.exe)?$/i.test(path.basename(words[codexIndex - 1]))
          ? codexIndex - 1
          : -1;
        const rewrittenWords = [
          ...words.slice(0, launcherIndex >= 0 ? launcherIndex : codexIndex),
          process.execPath,
          codexScriptPath,
          ...words.slice(codexIndex + 1),
        ];
        if (!hasExplicitExec) {
          rewrittenWords.push('exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-');
        }
        return {
          command: rewrittenWords.map(shellQuote).join(' '),
          binary: 'codex',
        };
      }
    }
    if (hasExplicitExec) {
      return { command: commandTemplate, binary: 'codex' };
    }
    return {
      command: `${commandTemplate} exec --sandbox workspace-write --skip-git-repo-check -`,
      binary: 'codex',
    };
  }
  return { command: commandTemplate, binary };
}

function runCliTurn(commandTemplate: string, commandType: string | null, prompt: string): string {
  const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const cli = buildCliCommand(commandTemplate, commandType);
  const timeoutMs = getDashboardChatTimeoutMs(commandType);
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
      throw new Error(
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
      commandType: commandType as any,
      binary: cli.binary,
    });
    const message = failure.code === 'execution_failed'
      ? (rawFailureText.slice(0, 240) || `The selected Agent Tool exited with status ${result.status}.`)
      : failure.message;
    const err = new Error(message);
    (err as any).failure = failure;
    throw err;
  }

  const finalText = trimString(output.meaningful || output.full || '');
  if (finalText) return finalText;
  throw new Error('The selected Agent Tool finished but produced no usable output.');
}

function buildProjectCatalogForPrompt(projects: ChatProjectSummary[]): string {
  return JSON.stringify(
    projects.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      status: project.status,
      is_remote: project.is_remote,
      machine: project.remote_instance_name || null,
      remote_base_url: project.remote_base_url || null,
      can_manage: project.can_manage,
      running_agents: project.stats.running,
      total_agents: project.stats.agents,
      open_issues: project.stats.openIssues,
      total_issues: project.stats.issues,
      updated_at: project.updated_at,
    })),
    null,
    2,
  );
}

function buildChatPrompt(input: {
  projects: ChatProjectSummary[];
  selectedProject: ChatProjectSummary | null;
  messages: DashboardChatMessage[];
  toolResults: Array<{ tool: string; arguments: Record<string, unknown>; result: unknown }>;
  latestMessage: string;
}): string {
  const languageLabel = inferLanguageLabel(input.latestMessage);
  const toolSection = input.toolResults.length
    ? input.toolResults.map((item, index) => (
      `Tool result ${index + 1}\nTool: ${item.tool}\nArguments: ${JSON.stringify(item.arguments, null, 2)}\nResult:\n${truncateForPrompt(item.result)}`
    )).join('\n\n')
    : '(none yet)';

  return `You are HAICO's dashboard chat assistant.

Core rules:
- Reply in ${languageLabel}. If the user switches language, switch too.
- You are operating inside the HAICO dashboard, not inside a coding workspace.
- Use tools whenever the user asks about projects, issues, agents, status, progress, creation, updates, comments, deletion, or delegation.
- Never invent project IDs, issue IDs, agent IDs, status, or progress.
- Do not do long-running work yourself. If the user requests implementation, investigation, coding, research, monitoring, terminal work, file edits, or anything that should be carried out by HAICO agents, create a delegated issue instead of pretending to do it directly.
- Prefer assigning long-running tasks to the controller unless the user clearly names a specific agent and that agent exists.
- Destructive actions like delete_project and delete_issue require explicit confirmation from the user in the latest message. If the confirmation is not explicit, do not call the delete tool. Ask a short confirmation question instead.
- If the user asks for project progress, first identify the right project, then use get_project_progress and any extra issue lookups needed before answering.
- Keep answers concise and operational. Mention the exact project or issue you used.

Available tools:
- search_projects {"query": string?, "limit": number?}
- get_project {"project_id": string}
- get_project_progress {"project_id": string, "limit": number?}
- list_project_agents {"project_id": string}
- list_project_issues {"project_id": string, "status": string?, "assigned_to": string?, "q": string?, "limit": number?}
- get_issue {"issue_id": string}
- get_issue_by_number {"project_id": string, "issue_number": number|string}
- create_issue {"project_id": string, "title": string, "body": string, "assigned_to": string?, "labels": string?, "parent_id": string?}
- update_issue {"issue_id": string, "status": string?, "assigned_to": string?, "title": string?, "body": string?, "labels": string?}
- add_issue_comment {"issue_id": string, "body": string}
- delete_issue {"issue_id": string, "confirm": boolean}
- create_project_from_request {"request": string, "target_instance_id": string?}
- update_project {"project_id": string, "name": string?, "description": string?, "task_description": string?, "status": string?, "color": string?}
- delete_project {"project_id": string, "confirm": boolean}
- delegate_task {"project_id": string, "title": string, "details": string, "agent_id": string?, "agent_name": string?}

Current accessible projects:
${buildProjectCatalogForPrompt(input.projects)}

Selected project preference:
${input.selectedProject ? JSON.stringify(input.selectedProject, null, 2) : 'null'}

Conversation so far:
${JSON.stringify(input.messages, null, 2)}

Tool outputs from this turn:
${toolSection}

Return ONLY one JSON object in one of these shapes:
{"type":"answer","message":"..."}
{"type":"tool_call","tool":"search_projects","arguments":{"query":"google"}}
`;
}

function buildIssuePayloadResult(data: any) {
  return {
    id: trimString(data?.id),
    number: Number(data?.number || 0),
    title: trimString(data?.title),
    status: trimString(data?.status),
    assigned_to: trimString(data?.assigned_to) || null,
    created_by: trimString(data?.created_by) || null,
    priority: Number(data?.priority || 0),
    parent_id: trimString(data?.parent_id) || null,
    updated_at: trimString(data?.updated_at) || null,
    project_id: trimString(data?.project_id) || null,
    is_remote: Boolean(data?.is_remote),
    remote_instance_name: trimString(data?.remote_instance_name) || null,
  };
}

async function getProjectDetail(ctx: ChatToolContext, projectId: string): Promise<any> {
  const result = await injectJson<any>(ctx.fastify, ctx.request, {
    url: buildProjectApiPath(projectId),
  });
  if (!result.ok) throw new Error(result.error || 'Failed to load project');
  return result.data || {};
}

async function listProjectAgents(ctx: ChatToolContext, projectId: string): Promise<any[]> {
  const result = await injectJson<any[]>(ctx.fastify, ctx.request, {
    url: buildProjectApiPath(projectId, '/agents'),
  });
  if (!result.ok) throw new Error(result.error || 'Failed to load project agents');
  const agents = Array.isArray(result.data) ? result.data : [];
  return agents.map((agent) => ({
    id: trimString(agent?.id),
    name: trimString(agent?.name),
    role: trimString(agent?.role),
    is_controller: Boolean(agent?.is_controller),
    status: trimString(agent?.status),
    paused: Boolean(agent?.paused),
    parent_agent_id: trimString(agent?.parent_agent_id) || null,
  }));
}

async function executeChatTool(ctx: ChatToolContext, tool: string, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case 'search_projects': {
      const query = trimString(args.query);
      const limit = clampLimit(args.limit, 10, 25);
      const projects = query
        ? ctx.availableProjects
          .map((project) => ({ project, score: scoreProjectMatch(project, query) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || b.project.stats.openIssues - a.project.stats.openIssues)
          .slice(0, limit)
          .map((entry) => entry.project)
        : ctx.availableProjects.slice(0, limit);
      return {
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          description: project.description,
          status: project.status,
          is_remote: project.is_remote,
          machine: project.remote_instance_name,
          open_issues: project.stats.openIssues,
          total_issues: project.stats.issues,
          running_agents: project.stats.running,
          total_agents: project.stats.agents,
          updated_at: project.updated_at,
        })),
      };
    }

    case 'get_project': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new Error('project_id is required');
      const project = await getProjectDetail(ctx, projectId);
      return summarizeProject(project);
    }

    case 'get_project_progress': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new Error('project_id is required');
      const limit = clampLimit(args.limit, 12, 25);
      const [projectRes, countsRes, agentsRes, issuesRes] = await Promise.all([
        injectJson<any>(ctx.fastify, ctx.request, { url: buildProjectApiPath(projectId) }),
        injectJson<any>(ctx.fastify, ctx.request, { url: buildProjectApiPath(projectId, '/issues/counts') }),
        injectJson<any[]>(ctx.fastify, ctx.request, { url: buildProjectApiPath(projectId, '/agents') }),
        injectJson<any>(ctx.fastify, ctx.request, {
          url: `${buildProjectApiPath(projectId, '/issues')}?sort=updated&per_page=${limit}`,
        }),
      ]);
      if (!projectRes.ok) throw new Error(projectRes.error || 'Failed to load project');
      if (!countsRes.ok) throw new Error(countsRes.error || 'Failed to load project issue counts');
      if (!agentsRes.ok) throw new Error(agentsRes.error || 'Failed to load project agents');
      if (!issuesRes.ok) throw new Error(issuesRes.error || 'Failed to load project issues');

      const counts = countsRes.data || {};
      const issues = Array.isArray(issuesRes.data?.issues) ? issuesRes.data?.issues : [];
      const agents = Array.isArray(agentsRes.data) ? agentsRes.data : [];
      const completed = Number(counts.done || 0) + Number(counts.closed || 0);
      const total = Number(counts.total || 0);

      return {
        project: summarizeProject(projectRes.data || {}),
        progress: {
          total_issues: total,
          completed_issues: completed,
          completion_ratio: total > 0 ? Number((completed / total).toFixed(3)) : 0,
          open: Number(counts.open || 0),
          in_progress: Number(counts.in_progress || 0),
          pending: Number(counts.pending || 0),
          done: Number(counts.done || 0),
          closed: Number(counts.closed || 0),
        },
        agents: agents.map((agent) => ({
          id: trimString(agent?.id),
          name: trimString(agent?.name),
          is_controller: Boolean(agent?.is_controller),
          status: trimString(agent?.status),
          paused: Boolean(agent?.paused),
          parent_agent_id: trimString(agent?.parent_agent_id) || null,
        })),
        recent_issues: issues.map(buildIssuePayloadResult),
      };
    }

    case 'list_project_agents': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new Error('project_id is required');
      return { agents: await listProjectAgents(ctx, projectId) };
    }

    case 'list_project_issues': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new Error('project_id is required');
      const params = new URLSearchParams();
      const status = trimString(args.status);
      const assignedTo = trimString(args.assigned_to);
      const q = trimString(args.q);
      const limit = clampLimit(args.limit, 20, 50);
      if (status) params.set('status', status);
      if (assignedTo) params.set('assigned_to', assignedTo);
      if (q) params.set('q', q);
      params.set('per_page', String(limit));
      params.set('sort', 'updated');
      const result = await injectJson<any>(ctx.fastify, ctx.request, {
        url: `${buildProjectApiPath(projectId, '/issues')}?${params.toString()}`,
      });
      if (!result.ok) throw new Error(result.error || 'Failed to load project issues');
      const issues = Array.isArray(result.data?.issues) ? result.data?.issues : [];
      return {
        total: Number(result.data?.total || issues.length || 0),
        issues: issues.map(buildIssuePayloadResult),
      };
    }

    case 'get_issue': {
      const issueId = trimString(args.issue_id);
      if (!issueId) throw new Error('issue_id is required');
      const result = await injectJson<any>(ctx.fastify, ctx.request, { url: buildIssueApiPath(issueId) });
      if (!result.ok) throw new Error(result.error || 'Failed to load issue');
      const data = result.data || {};
      return {
        ...buildIssuePayloadResult(data),
        body: trimString(data?.body),
        comments: Array.isArray(data?.comments)
          ? data.comments.slice(-12).map((comment: any) => ({
            id: trimString(comment?.id),
            author_id: trimString(comment?.author_id),
            event_type: trimString(comment?.event_type || 'comment'),
            body: trimString(comment?.body),
            created_at: trimString(comment?.created_at) || null,
          }))
          : [],
        children: Array.isArray(data?.children)
          ? data.children.map((child: any) => ({
            id: trimString(child?.id),
            number: Number(child?.number || 0),
            title: trimString(child?.title),
            status: trimString(child?.status),
            assigned_to: trimString(child?.assigned_to) || null,
          }))
          : [],
      };
    }

    case 'get_issue_by_number': {
      const projectId = trimString(args.project_id);
      const issueNumber = trimString(args.issue_number);
      if (!projectId || !issueNumber) throw new Error('project_id and issue_number are required');
      const result = await injectJson<any>(ctx.fastify, ctx.request, {
        url: `${buildProjectApiPath(projectId, `/issues/number/${encodeURIComponent(issueNumber)}`)}`,
      });
      if (!result.ok) throw new Error(result.error || 'Failed to resolve issue by number');
      const data = result.data || {};
      return {
        ...buildIssuePayloadResult(data),
        body: trimString(data?.body),
      };
    }

    case 'create_issue': {
      const projectId = trimString(args.project_id);
      const title = trimString(args.title);
      const body = trimString(args.body);
      if (!projectId || !title || !body) {
        throw new Error('project_id, title, and body are required');
      }
      const payload = {
        title,
        body,
        created_by: 'user',
        assigned_to: trimString(args.assigned_to) || undefined,
        labels: trimString(args.labels) || undefined,
        parent_id: trimString(args.parent_id) || undefined,
      };
      const result = await injectJson<any>(ctx.fastify, ctx.request, {
        method: 'POST',
        url: buildProjectApiPath(projectId, '/issues'),
        payload,
      });
      if (!result.ok) throw new Error(result.error || 'Failed to create issue');
      return {
        created: true,
        issue: buildIssuePayloadResult(result.data || {}),
      };
    }

    case 'update_issue': {
      const issueId = trimString(args.issue_id);
      if (!issueId) throw new Error('issue_id is required');
      const payload: Record<string, unknown> = {};
      ['status', 'assigned_to', 'title', 'body', 'labels'].forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(args, field)) {
          payload[field] = args[field] ?? null;
        }
      });
      if (Object.keys(payload).length === 0) {
        throw new Error('At least one updatable field is required');
      }
      const result = await injectJson<any>(ctx.fastify, ctx.request, {
        method: 'PUT',
        url: buildIssueApiPath(issueId),
        payload,
      });
      if (!result.ok) throw new Error(result.error || 'Failed to update issue');
      return {
        updated: true,
        issue: buildIssuePayloadResult(result.data || {}),
      };
    }

    case 'add_issue_comment': {
      const issueId = trimString(args.issue_id);
      const body = trimString(args.body);
      if (!issueId || !body) throw new Error('issue_id and body are required');
      const result = await injectJson<any>(ctx.fastify, ctx.request, {
        method: 'POST',
        url: buildIssueApiPath(issueId, '/comments'),
        payload: { author_id: 'user', body },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to add issue comment');
      return {
        created: true,
        comment: {
          id: trimString(result.data?.id),
          body: trimString(result.data?.body),
          created_at: trimString(result.data?.created_at) || null,
        },
      };
    }

    case 'delete_issue': {
      const issueId = trimString(args.issue_id);
      if (!issueId) throw new Error('issue_id is required');
      if (args.confirm !== true) {
        throw new Error('delete_issue requires confirm=true');
      }
      const result = await injectJson<any>(ctx.fastify, ctx.request, {
        method: 'DELETE',
        url: buildIssueApiPath(issueId),
      });
      if (!result.ok) throw new Error(result.error || 'Failed to delete issue');
      return { deleted: true, issue_id: issueId };
    }

    case 'create_project_from_request': {
      const requestText = trimString(args.request);
      const targetInstanceId = trimString(args.target_instance_id) || 'localhost';
      if (!requestText) throw new Error('request is required');
      const generated = await injectJson<any>(ctx.fastify, ctx.request, {
        method: 'POST',
        url: '/api/generate-project',
        payload: {
          description: requestText,
          tool_path: ctx.command.template,
          command_type: ctx.command.type,
          target_instance_id: targetInstanceId,
        },
      });
      if (!generated.ok) throw new Error(generated.error || 'Failed to generate project metadata');
      const createPayload = {
        ...(generated.data || {}),
        target_instance_id: targetInstanceId,
        command_template: ctx.command.template,
        command_type: ctx.command.type,
      };
      const created = await injectJson<any>(ctx.fastify, ctx.request, {
        method: 'POST',
        url: '/api/projects',
        payload: createPayload,
      });
      if (!created.ok) throw new Error(created.error || 'Failed to create project');
      return {
        created: true,
        project: summarizeProject(created.data || {}),
      };
    }

    case 'update_project': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new Error('project_id is required');
      const payload: Record<string, unknown> = {};
      ['name', 'description', 'task_description', 'status', 'color'].forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(args, field)) {
          payload[field] = args[field] ?? null;
        }
      });
      if (Object.keys(payload).length === 0) {
        throw new Error('At least one updatable field is required');
      }
      const result = await injectJson<any>(ctx.fastify, ctx.request, {
        method: 'PUT',
        url: buildProjectApiPath(projectId),
        payload,
      });
      if (!result.ok) throw new Error(result.error || 'Failed to update project');
      return {
        updated: true,
        project: summarizeProject(result.data || {}),
      };
    }

    case 'delete_project': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new Error('project_id is required');
      if (args.confirm !== true) {
        throw new Error('delete_project requires confirm=true');
      }
      const result = await injectJson<any>(ctx.fastify, ctx.request, {
        method: 'DELETE',
        url: buildProjectApiPath(projectId),
      });
      if (!result.ok) throw new Error(result.error || 'Failed to delete project');
      return { deleted: true, project_id: projectId };
    }

    case 'delegate_task': {
      const projectId = trimString(args.project_id);
      const title = trimString(args.title);
      const details = trimString(args.details);
      if (!projectId || !title || !details) {
        throw new Error('project_id, title, and details are required');
      }

      const agents = await listProjectAgents(ctx, projectId);
      const explicitAgentId = trimString(args.agent_id);
      const explicitAgentName = trimString(args.agent_name).toLowerCase();
      const matchedAgent = explicitAgentId
        ? agents.find((agent) => agent.id === explicitAgentId) || null
        : (explicitAgentName
          ? agents.find((agent) => agent.name.toLowerCase() === explicitAgentName) || null
          : null);
      const fallbackAgent = matchedAgent || agents.find((agent) => agent.is_controller) || null;
      const createResult = await executeChatTool(ctx, 'create_issue', {
        project_id: projectId,
        title,
        body: details,
        assigned_to: fallbackAgent?.id || undefined,
      } as Record<string, unknown>) as any;
      return {
        delegated: true,
        assigned_agent: fallbackAgent
          ? { id: fallbackAgent.id, name: fallbackAgent.name, is_controller: fallbackAgent.is_controller }
          : null,
        issue: createResult.issue,
      };
    }

    default:
      throw new Error(`Unknown tool "${tool}"`);
  }
}

function resolveCommandSelection(input: DashboardChatInput): CommandSelection {
  const db = getDatabase();
  const requestedProfileId = trimString(input.command_profile_id);

  if (requestedProfileId) {
    const profile = db.prepare(
      'SELECT id, name, command, type FROM command_profiles WHERE id = ?'
    ).get(requestedProfileId) as
      | { id: string; name: string; command: string; type: string }
      | undefined;
    if (!profile) {
      throw new Error('Selected Agent Tool was not found');
    }
    return {
      template: trimString(profile.command),
      type: resolveCommandType(profile.type, profile.command),
      profileId: profile.id,
      profileName: trimString(profile.name) || 'Agent Tool',
    };
  }

  const inlineCommand = trimString(input.command);
  if (inlineCommand) {
    return {
      template: inlineCommand,
      type: resolveCommandType(input.command_type, inlineCommand),
      profileId: null,
      profileName: 'Custom command',
    };
  }

  const firstProfile = db.prepare(
    'SELECT id, name, command, type FROM command_profiles ORDER BY lower(name), created_at LIMIT 1'
  ).get() as
    | { id: string; name: string; command: string; type: string }
    | undefined;
  if (firstProfile) {
    return {
      template: trimString(firstProfile.command),
      type: resolveCommandType(firstProfile.type, firstProfile.command),
      profileId: firstProfile.id,
      profileName: trimString(firstProfile.name) || 'Agent Tool',
    };
  }

  return {
    template: config.defaultCommandTemplate,
    type: resolveCommandType(input.command_type, config.defaultCommandTemplate),
    profileId: null,
    profileName: 'Default CLI',
  };
}

export async function runDashboardChatTurn(
  fastify: FastifyInstance,
  request: FastifyRequest,
  input: DashboardChatInput,
): Promise<DashboardChatResult> {
  const latestMessage = trimString(input.message);
  if (!latestMessage) {
    throw new Error('message is required');
  }

  const command = resolveCommandSelection(input);
  const readiness = inspectToolReadiness({
    commandTemplate: command.template,
    commandType: command.type,
  });
  if (!readiness.binary_found) {
    throw new Error(
      readiness.issues.find((issue) => issue.code === 'missing_cli')?.detail
      || `Tool "${readiness.binary}" is not installed`
    );
  }
  if (readiness.auth.status === 'missing') {
    throw new Error(readiness.auth.message);
  }

  const seedContext: ChatToolContext = {
    fastify,
    request,
    command,
    availableProjects: [],
  };
  seedContext.availableProjects = await loadAccessibleProjects(seedContext);
  const selectedProjectId = trimString(input.project_id);
  const selectedProject = selectedProjectId
    ? seedContext.availableProjects.find((project) => project.id === selectedProjectId) || null
    : null;
  const messages = normalizeMessages(input.messages, latestMessage);
  const toolCalls: DashboardChatToolCall[] = [];
  const toolResults: Array<{ tool: string; arguments: Record<string, unknown>; result: unknown }> = [];

  for (let step = 0; step < MAX_CHAT_STEPS; step += 1) {
    const prompt = buildChatPrompt({
      projects: seedContext.availableProjects,
      selectedProject,
      messages,
      toolResults,
      latestMessage,
    });
    const rawOutput = runCliTurn(command.template, command.type, prompt);
    const envelope = parseAssistantEnvelope(rawOutput);

    if (envelope.type === 'answer') {
      return {
        message: envelope.message,
        tool_calls: toolCalls,
        command: {
          template: command.template,
          type: command.type,
          profile_id: command.profileId,
          profile_name: command.profileName,
        },
      };
    }

    toolCalls.push({
      tool: envelope.tool,
      arguments: envelope.arguments,
    });

    try {
      const result = await executeChatTool(seedContext, envelope.tool, envelope.arguments);
      toolResults.push({
        tool: envelope.tool,
        arguments: envelope.arguments,
        result,
      });
    } catch (error: any) {
      toolResults.push({
        tool: envelope.tool,
        arguments: envelope.arguments,
        result: { error: String(error?.message || error || 'Tool failed') },
      });
    }
  }

  return {
    message: 'I hit the tool-call limit for this turn. Please narrow the request or specify the exact project or issue you want me to operate on.',
    tool_calls: toolCalls,
    command: {
      template: command.template,
      type: command.type,
      profile_id: command.profileId,
      profile_name: command.profileName,
    },
  };
}
