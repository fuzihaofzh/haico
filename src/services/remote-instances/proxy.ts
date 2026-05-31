import type { CreateProjectInput } from '../../types';
import type { ToolReadinessSummary } from '../tool-readiness';
import logger from '../../logger';
import {
  REMOTE_FETCH_TIMEOUT_MS,
  type RemoteInstanceRecord,
  type RemoteInstanceAuthResult,
  type RemoteInstanceProbeResult,
  type RemoteJsonResult,
  type AggregatedRemoteProject,
  type RemoteNotificationsPayload,
  buildRemoteHeaders,
  toAggregatedRemoteProject,
} from './core';

function isoNow(): string {
  return new Date().toISOString();
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
    if (!params.username) {
      throw new Error('Remote username is required');
    }
    const body = { username: params.username, password: params.password };
    const res = await fetch(new URL('/api/auth/login', params.baseUrl), {
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


