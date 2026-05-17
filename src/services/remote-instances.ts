import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { CreateProjectInput } from '../types';
import type { ToolReadinessSummary } from './tool-readiness';
import logger from '../logger';

const REMOTE_INSTANCES_SETTINGS_KEY = 'remote_instances';
const REMOTE_FETCH_TIMEOUT_MS = 5000;
export const LOCAL_REMOTE_INSTANCE_ID = 'localhost';

export interface RemoteInstanceRecord {
  id: string;
  name: string;
  base_url: string;
  api_token: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  last_status: 'unknown' | 'ok' | 'error';
  last_error: string;
}

export interface RemoteInstanceProbeResult {
  ok: boolean;
  projectCount: number;
  error: string;
  checkedAt: string;
}

export interface RemoteInstanceAuthResult {
  token: string;
  user?: {
    id?: string;
    username?: string;
    display_name?: string;
    role?: string;
  } | null;
}

export interface AggregatedRemoteProject {
  id: string;
  remote_project_id: string;
  remote_instance_id: string;
  remote_instance_name: string;
  remote_base_url: string;
  remote_url: string;
  is_remote: true;
  can_manage: boolean;
  permission_level: string;
  owner: Record<string, unknown> | null;
  member_count: number;
  stats: Record<string, unknown>;
  name: string;
  description: string;
  task_description: string;
  status: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface RemoteInstanceOption {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  last_status: RemoteInstanceRecord['last_status'];
  last_error: string;
  available: boolean;
}

export interface RemoteNotificationsPayload {
  user_issues?: any[];
  recent_comments?: any[];
  removed_issue_ids?: string[];
  unread_count?: number;
  pagination?: {
    limit?: number;
    offset?: number;
    total?: number;
    has_more?: boolean;
    incremental?: boolean;
  };
}

interface RemoteJsonResult<T = any> {
  ok: boolean;
  status: number;
  statusText: string;
  data: T | null;
  error: string;
}

type StoredRemoteInstancesPayload = {
  instances?: RemoteInstanceRecord[];
};

function isoNow(): string {
  return new Date().toISOString();
}

function normalizeStoredInstance(input: Partial<RemoteInstanceRecord>): RemoteInstanceRecord {
  return {
    id: String(input.id || randomUUID()),
    name: String(input.name || '').trim(),
    base_url: String(input.base_url || '').trim(),
    api_token: String(input.api_token || ''),
    enabled: input.enabled !== false,
    created_at: String(input.created_at || isoNow()),
    updated_at: String(input.updated_at || isoNow()),
    last_checked_at: input.last_checked_at || null,
    last_status: input.last_status === 'ok' || input.last_status === 'error' ? input.last_status : 'unknown',
    last_error: String(input.last_error || ''),
  };
}

export function loadRemoteInstances(db: Database.Database): RemoteInstanceRecord[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(REMOTE_INSTANCES_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return [];

  try {
    const parsed = JSON.parse(row.value) as StoredRemoteInstancesPayload | RemoteInstanceRecord[];
    const instances = Array.isArray(parsed) ? parsed : parsed.instances;
    if (!Array.isArray(instances)) return [];
    return instances.map(normalizeStoredInstance);
  } catch {
    return [];
  }
}

export function saveRemoteInstances(db: Database.Database, instances: RemoteInstanceRecord[]): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(REMOTE_INSTANCES_SETTINGS_KEY, JSON.stringify({ instances }));
}

export function isLocalTargetInstanceId(value: unknown): boolean {
  const normalized = String(value || '').trim();
  return !normalized || normalized === LOCAL_REMOTE_INSTANCE_ID;
}

export function findRemoteInstanceById(
  db: Database.Database,
  remoteInstanceId: string
): RemoteInstanceRecord | null {
  const targetId = String(remoteInstanceId || '').trim();
  if (!targetId) return null;
  return loadRemoteInstances(db).find((instance) => instance.id === targetId) || null;
}

export function serializeRemoteInstanceOption(instance: RemoteInstanceRecord): RemoteInstanceOption {
  return {
    id: instance.id,
    name: instance.name,
    base_url: instance.base_url,
    enabled: instance.enabled,
    last_status: instance.last_status,
    last_error: instance.last_error,
    available: instance.enabled && Boolean(instance.api_token),
  };
}

export function normalizeRemoteInstanceName(value: unknown): string {
  return String(value || '').trim();
}

export function normalizeRemoteInstanceBaseUrl(value: unknown): string {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }

  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Remote instance URL must use http or https');
  }

  url.hash = '';
  url.search = '';
  if (url.pathname === '/') {
    url.pathname = '';
  } else {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  return url.toString().replace(/\/$/, '');
}

function buildRemoteHeaders(instance: RemoteInstanceRecord): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (instance.api_token) {
    headers.authorization = `Bearer ${instance.api_token}`;
  }
  return headers;
}

function toAggregatedRemoteProject(instance: RemoteInstanceRecord, project: any): AggregatedRemoteProject {
  const remoteProjectId = String(project?.id || '');
  return {
    ...project,
    id: `remote:${instance.id}:${remoteProjectId}`,
    remote_project_id: remoteProjectId,
    remote_instance_id: instance.id,
    remote_instance_name: instance.name,
    remote_base_url: instance.base_url,
    remote_url: `${instance.base_url}/projects/${encodeURIComponent(remoteProjectId)}`,
    is_remote: true,
    can_manage: Boolean(project?.can_manage),
    permission_level: typeof project?.permission_level === 'string' && project.permission_level.trim()
      ? project.permission_level.trim()
      : 'remote',
    owner: project?.owner && typeof project.owner === 'object' ? project.owner : null,
    member_count: Number.isFinite(Number(project?.member_count)) ? Number(project.member_count) : 0,
    stats: project?.stats && typeof project.stats === 'object' ? project.stats : {},
    name: String(project?.name || remoteProjectId || instance.name),
    description: String(project?.description || ''),
    task_description: String(project?.task_description || ''),
    status: String(project?.status || 'active'),
    color: String(project?.color || '#7c8aa5'),
    created_at: String(project?.created_at || ''),
    updated_at: String(project?.updated_at || ''),
  } satisfies AggregatedRemoteProject;
}

async function requestRemoteJson<T>(
  instance: RemoteInstanceRecord,
  pathname: string,
  init: {
    method?: string;
    body?: unknown;
  } = {}
): Promise<RemoteJsonResult<T>> {
  if (!instance.enabled) {
    return {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      data: null,
      error: 'Instance is disabled',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);

  try {
    const headers = buildRemoteHeaders(instance);
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const res = await fetch(new URL(pathname, instance.base_url), {
      method: init.method || (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });

    const text = await res.text().catch(() => '');
    let data: T | null = null;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = null;
      }
    }

    const error = res.ok
      ? ''
      : String(
          (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>) && (data as any).error)
            || text
            || `Remote API returned ${res.status} ${res.statusText}`
        );

    if (!res.ok) {
      logger.warn({
        remoteInstanceId: instance.id,
        pathname,
        method: init.method || (init.body !== undefined ? 'POST' : 'GET'),
        status: res.status,
        statusText: res.statusText,
        error,
      }, 'remote.request_failed');
    }

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      data,
      error,
    };
  } catch (error: any) {
    const message = error?.name === 'AbortError'
      ? 'Connection to remote instance timed out'
      : String(error?.message || error || 'Request failed');
    logger.warn({
      remoteInstanceId: instance.id,
      pathname,
      method: init.method || (init.body !== undefined ? 'POST' : 'GET'),
      error: message,
      timeout: error?.name === 'AbortError',
    }, 'remote.request_failed');
    return {
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      data: null,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function requestRemoteJsonPath<T>(
  instance: RemoteInstanceRecord,
  pathname: string,
  init: {
    method?: string;
    body?: unknown;
  } = {}
): Promise<RemoteJsonResult<T>> {
  return requestRemoteJson<T>(instance, pathname, init);
}

export async function checkRemoteCommandProfile(
  instance: RemoteInstanceRecord,
  input: { command?: string; type?: string | null }
): Promise<RemoteJsonResult<ToolReadinessSummary>> {
  return requestRemoteJson<ToolReadinessSummary>(instance, '/api/command-profiles/check', {
    method: 'POST',
    body: input,
  });
}

export async function generateRemoteProjectMetadata(
  instance: RemoteInstanceRecord,
  input: { description?: string; tool_path?: string; command_type?: string | null }
): Promise<RemoteJsonResult<Record<string, unknown>>> {
  return requestRemoteJson<Record<string, unknown>>(instance, '/api/generate-project', {
    method: 'POST',
    body: input,
  });
}

export async function createRemoteProject(
  instance: RemoteInstanceRecord,
  input: CreateProjectInput
): Promise<RemoteJsonResult<AggregatedRemoteProject>> {
  const result = await requestRemoteJson<any>(instance, '/api/projects', {
    method: 'POST',
    body: input,
  });
  return {
    ...result,
    data: result.ok && result.data ? toAggregatedRemoteProject(instance, result.data) : null,
  };
}

export async function fetchRemoteNotifications(
  instance: RemoteInstanceRecord,
  input: {
    scope?: string;
    limit?: number;
    offset?: number;
    project_id?: string;
    since_updated_at?: string;
  }
): Promise<RemoteJsonResult<RemoteNotificationsPayload>> {
  const params = new URLSearchParams();
  if (input.scope) params.set('scope', String(input.scope));
  if (Number.isFinite(Number(input.limit))) params.set('limit', String(input.limit));
  if (Number.isFinite(Number(input.offset))) params.set('offset', String(input.offset));
  if (input.project_id) params.set('project_id', String(input.project_id));
  if (input.since_updated_at) params.set('since_updated_at', String(input.since_updated_at));
  const pathname = `/api/notifications${params.toString() ? `?${params.toString()}` : ''}`;
  return requestRemoteJson<RemoteNotificationsPayload>(instance, pathname);
}

export async function fetchRemoteIssue(
  instance: RemoteInstanceRecord,
  remoteIssueId: string
): Promise<RemoteJsonResult<any>> {
  return requestRemoteJson<any>(instance, `/api/issues/${encodeURIComponent(remoteIssueId)}`);
}

export async function fetchRemoteProjectAgents(
  instance: RemoteInstanceRecord,
  remoteProjectId: string
): Promise<RemoteJsonResult<any[]>> {
  return requestRemoteJson<any[]>(instance, `/api/projects/${encodeURIComponent(remoteProjectId)}/agents`);
}

export async function acknowledgeRemoteIssue(
  instance: RemoteInstanceRecord,
  remoteIssueId: string
): Promise<RemoteJsonResult<any>> {
  return requestRemoteJson<any>(instance, `/api/issues/${encodeURIComponent(remoteIssueId)}/acknowledge`, {
    method: 'POST',
  });
}

export async function updateRemoteIssue(
  instance: RemoteInstanceRecord,
  remoteIssueId: string,
  input: Record<string, unknown>
): Promise<RemoteJsonResult<any>> {
  return requestRemoteJson<any>(instance, `/api/issues/${encodeURIComponent(remoteIssueId)}`, {
    method: 'PUT',
    body: input,
  });
}

export async function deleteRemoteIssue(
  instance: RemoteInstanceRecord,
  remoteIssueId: string
): Promise<RemoteJsonResult<any>> {
  return requestRemoteJson<any>(instance, `/api/issues/${encodeURIComponent(remoteIssueId)}`, {
    method: 'DELETE',
  });
}

export async function fetchRemoteIssueComments(
  instance: RemoteInstanceRecord,
  remoteIssueId: string,
  input: { since_created_at?: string } = {}
): Promise<RemoteJsonResult<any[]>> {
  const params = new URLSearchParams();
  if (input.since_created_at) params.set('since_created_at', String(input.since_created_at));
  const pathname = `/api/issues/${encodeURIComponent(remoteIssueId)}/comments${params.toString() ? `?${params.toString()}` : ''}`;
  return requestRemoteJson<any[]>(instance, pathname);
}

export async function createRemoteIssueComment(
  instance: RemoteInstanceRecord,
  remoteIssueId: string,
  input: { author_id: string; body: string }
): Promise<RemoteJsonResult<any>> {
  return requestRemoteJson<any>(instance, `/api/issues/${encodeURIComponent(remoteIssueId)}/comments`, {
    method: 'POST',
    body: input,
  });
}

export async function updateRemoteComment(
  instance: RemoteInstanceRecord,
  remoteCommentId: string,
  input: { body: string }
): Promise<RemoteJsonResult<any>> {
  return requestRemoteJson<any>(instance, `/api/comments/${encodeURIComponent(remoteCommentId)}`, {
    method: 'PUT',
    body: input,
  });
}

export async function deleteRemoteComment(
  instance: RemoteInstanceRecord,
  remoteCommentId: string
): Promise<RemoteJsonResult<any>> {
  return requestRemoteJson<any>(instance, `/api/comments/${encodeURIComponent(remoteCommentId)}`, {
    method: 'DELETE',
  });
}

export async function toggleRemoteReaction(
  instance: RemoteInstanceRecord,
  type: string,
  targetId: string,
  input: { user_id: string; emoji: string }
): Promise<RemoteJsonResult<any>> {
  return requestRemoteJson<any>(instance, `/api/reactions/${encodeURIComponent(type)}/${encodeURIComponent(targetId)}`, {
    method: 'POST',
    body: input,
  });
}

export async function resolveRemoteIssueByNumber(
  instance: RemoteInstanceRecord,
  remoteProjectId: string,
  issueNumber: string
): Promise<RemoteJsonResult<any>> {
  return requestRemoteJson<any>(
    instance,
    `/api/projects/${encodeURIComponent(remoteProjectId)}/issues/number/${encodeURIComponent(issueNumber)}`
  );
}

export async function addRemoteIssueRelation(
  instance: RemoteInstanceRecord,
  remoteIssueId: string,
  input: { type: string; target_issue_id: string; actor?: string }
): Promise<RemoteJsonResult<any>> {
  return requestRemoteJson<any>(instance, `/api/issues/${encodeURIComponent(remoteIssueId)}/relations`, {
    method: 'POST',
    body: input,
  });
}

export async function removeRemoteIssueRelation(
  instance: RemoteInstanceRecord,
  remoteIssueId: string,
  relationId: string
): Promise<RemoteJsonResult<any>> {
  return requestRemoteJson<any>(
    instance,
    `/api/issues/${encodeURIComponent(remoteIssueId)}/relations/${encodeURIComponent(relationId)}`,
    { method: 'DELETE' }
  );
}

export async function authenticateRemoteInstance(params: {
  baseUrl: string;
  username?: string;
  password: string;
}): Promise<RemoteInstanceAuthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);

  try {
    const body = params.username
      ? { username: params.username, password: params.password }
      : { password: params.password };
    const authPath = params.username ? '/api/auth/login' : '/api/auth';
    const res = await fetch(new URL(authPath, params.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(String(data?.error || `Remote login failed with ${res.status}`));
    }
    const token = String(data?.token || '').trim();
    if (!token) {
      throw new Error('Remote login succeeded but no token was returned');
    }
    return {
      token,
      user: data?.user || null,
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error('Remote login timed out');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeRemoteInstance(instance: RemoteInstanceRecord): Promise<RemoteInstanceProbeResult> {
  const checkedAt = isoNow();
  if (!instance.enabled) {
    return {
      ok: false,
      projectCount: 0,
      error: 'Instance is disabled',
      checkedAt,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(new URL('/api/projects?with_stats=1', instance.base_url), {
      headers: buildRemoteHeaders(instance),
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn({
        remoteInstanceId: instance.id,
        status: res.status,
        statusText: res.statusText,
      }, 'remote.probe_failed');
      return {
        ok: false,
        projectCount: 0,
        error: `Remote API returned ${res.status} ${res.statusText}`,
        checkedAt,
      };
    }

    const data = await res.json().catch(() => []);
    const projects = Array.isArray(data) ? data : [];
    return {
      ok: true,
      projectCount: projects.length,
      error: '',
      checkedAt,
    };
  } catch (error: any) {
    const message = error?.name === 'AbortError' ? 'Connection timed out' : String(error?.message || error || 'Request failed');
    logger.warn({
      remoteInstanceId: instance.id,
      error: message,
      timeout: error?.name === 'AbortError',
    }, 'remote.probe_failed');
    return {
      ok: false,
      projectCount: 0,
      error: message,
      checkedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function applyProbeToRemoteInstance(
  instance: RemoteInstanceRecord,
  probe: RemoteInstanceProbeResult
): RemoteInstanceRecord {
  return {
    ...instance,
    last_checked_at: probe.checkedAt,
    last_status: probe.ok ? 'ok' : 'error',
    last_error: probe.error,
    updated_at: isoNow(),
  };
}

export function serializeRemoteInstance(instance: RemoteInstanceRecord) {
  return {
    id: instance.id,
    name: instance.name,
    base_url: instance.base_url,
    enabled: instance.enabled,
    created_at: instance.created_at,
    updated_at: instance.updated_at,
    last_checked_at: instance.last_checked_at,
    last_status: instance.last_status,
    last_error: instance.last_error,
    has_api_token: Boolean(instance.api_token),
    api_token_preview: instance.api_token
      ? `${instance.api_token.slice(0, 4)}...${instance.api_token.slice(-4)}`
      : '',
  };
}

export async function fetchRemoteProjects(instance: RemoteInstanceRecord): Promise<{
  projects: AggregatedRemoteProject[];
  status: 'ok' | 'error';
  error: string;
}> {
  if (!instance.enabled) {
    return { projects: [], status: 'error', error: 'Instance is disabled' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(new URL('/api/projects?with_stats=1', instance.base_url), {
      headers: buildRemoteHeaders(instance),
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn({
        remoteInstanceId: instance.id,
        status: res.status,
        statusText: res.statusText,
      }, 'remote.projects_fetch_failed');
      return {
        projects: [],
        status: 'error',
        error: `Remote API returned ${res.status} ${res.statusText}`,
      };
    }

    const data = await res.json().catch(() => []);
    const projects = Array.isArray(data) ? data : [];

    return {
      status: 'ok',
      error: '',
      projects: projects.map((project: any) => toAggregatedRemoteProject(instance, project)),
    };
  } catch (error: any) {
    const message = error?.name === 'AbortError' ? 'Connection timed out' : String(error?.message || error || 'Request failed');
    logger.warn({
      remoteInstanceId: instance.id,
      error: message,
      timeout: error?.name === 'AbortError',
    }, 'remote.projects_fetch_failed');
    return {
      projects: [],
      status: 'error',
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}
