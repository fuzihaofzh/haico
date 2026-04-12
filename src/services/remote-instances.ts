import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const REMOTE_INSTANCES_SETTINGS_KEY = 'remote_instances';
const REMOTE_FETCH_TIMEOUT_MS = 5000;

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
  can_manage: false;
  permission_level: 'remote';
  owner: null;
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
    return {
      ok: false,
      projectCount: 0,
      error: error?.name === 'AbortError' ? 'Connection timed out' : String(error?.message || error || 'Request failed'),
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
      projects: projects.map((project: any) => {
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
          can_manage: false,
          permission_level: 'remote',
          owner: null,
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
      }),
    };
  } catch (error: any) {
    return {
      projects: [],
      status: 'error',
      error: error?.name === 'AbortError' ? 'Connection timed out' : String(error?.message || error || 'Request failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}
