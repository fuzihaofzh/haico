import Database from 'better-sqlite3';
import { trimString } from '../command-profiles';
import { getProjectPermission } from '../project-access/projects';
import type { ProjectPermission } from '../project-access/types';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../projects/core';
import { listProjectAgents as listProjectAgentsSvc } from '../agents/core';
import {
  createIssue,
  deleteIssue,
  getIssueByNumberDetail,
  getIssueCounts,
  getIssueDetail,
  listIssues,
  updateIssue,
} from '../issue/core';

import { addIssueComment } from '../issue/comments';
import { generateProjectMetadata } from '../projects/metadata';
import {
  fetchRemoteProjects,
  loadRemoteInstances,
  requestRemoteJsonPath,
  createRemoteProject,
  generateRemoteProjectMetadata,
} from '../remote-instances';
import type { RemoteInstanceRecord } from '../remote-instances';
import { DashChatToolError } from './errors';
import type {
  ChatProjectSummary,
  ChatToolContext,
  ParsedIssueId,
  ParsedProjectId,
} from './types';

// ── ID parsing ───────────────────────────────────────────────

export function parseRemoteProjectId(value: string): ParsedProjectId | null {
  const match = /^remote:([^:]+):(.+)$/.exec(trimString(value));
  if (!match) return null;
  return { kind: 'remote', instanceId: match[1], projectId: match[2] };
}

export function parseRemoteIssueId(value: string): ParsedIssueId | null {
  const match = /^remote-issue:([^:]+):(.+)$/.exec(trimString(value));
  if (!match) return null;
  return { kind: 'remote', instanceId: match[1], issueId: match[2] };
}

export function parseProjectId(value: unknown): ParsedProjectId | null {
  const normalized = trimString(value);
  if (!normalized) return null;
  return parseRemoteProjectId(normalized) || { kind: 'local', projectId: normalized };
}

export function parseIssueId(value: unknown): ParsedIssueId | null {
  const normalized = trimString(value);
  if (!normalized) return null;
  return parseRemoteIssueId(normalized) || { kind: 'local', issueId: normalized };
}

// ── Remote instance helpers ──────────────────────────────────

function getRemoteInstance(db: Database.Database, instanceId: string): RemoteInstanceRecord | null {
  const instances = loadRemoteInstances(db);
  return instances.find((i) => i.id === instanceId && i.enabled) || null;
}

// ── Project summarization ────────────────────────────────────

export function summarizeLocalProject(project: any, permission: ProjectPermission): ChatProjectSummary {
  return {
    id: trimString(project?.id),
    name: trimString(project?.name),
    description: trimString(project?.description),
    status: trimString(project?.status) || 'active',
    is_remote: false,
    remote_instance_name: null,
    remote_base_url: null,
    can_manage: permission.canManage,
    permission_level: permission.level,
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

export function summarizeRemoteProject(
  project: any,
  instanceId: string,
  instance: RemoteInstanceRecord,
): ChatProjectSummary {
  return {
    id: `remote:${instanceId}:${trimString(project?.id)}`,
    name: trimString(project?.name),
    description: trimString(project?.description),
    status: trimString(project?.status) || 'active',
    is_remote: true,
    remote_instance_name: instance.name || instance.id,
    remote_base_url: instance.base_url || null,
    can_manage: true,
    permission_level: trimString(project?.permission_level) || 'remote',
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

// ── Utility helpers ──────────────────────────────────────────

export function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

export function scoreProjectMatch(project: ChatProjectSummary, query: string): number {
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

export function buildIssuePayloadResult(data: any) {
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

// ── Accessible projects loader ───────────────────────────────

export async function loadAccessibleProjects(ctx: ChatToolContext): Promise<ChatProjectSummary[]> {
  const { db, userContext } = ctx;

  // Local projects
  const localRaw = listProjects(db, userContext, { withStats: true });
  const local: ChatProjectSummary[] = localRaw.map((p: any) =>
    summarizeLocalProject(p, getProjectPermission(db, p.id, userContext.user)),
  );

  // Remote projects
  const instances = loadRemoteInstances(db).filter((i) => i.enabled);
  const remote: ChatProjectSummary[] = [];
  for (const instance of instances) {
    const result = await fetchRemoteProjects(instance);
    if (result.status !== 'ok') continue;
    for (const rp of result.projects) {
      remote.push(summarizeRemoteProject(rp, instance.id, instance));
    }
  }

  return [...local, ...remote];
}

// ── Agent list helper (with local/remote dispatch) ───────────

async function listAgentsForProject(
  ctx: ChatToolContext,
  projectIdInput: unknown,
): Promise<any[]> {
  const parsed = parseProjectId(projectIdInput);
  if (!parsed) throw new DashChatToolError('project_id is required');

  if (parsed.kind === 'local') {
    const agents = listProjectAgentsSvc(parsed.projectId);
    return agents.map((agent: any) => ({
      id: trimString(agent?.id),
      name: trimString(agent?.name),
      role: trimString(agent?.role),
      is_controller: Boolean(agent?.is_controller),
      status: trimString(agent?.status),
      paused: Boolean(agent?.paused),
      parent_agent_id: trimString(agent?.parent_agent_id) || null,
    }));
  }

  const instance = getRemoteInstance(ctx.db, parsed.instanceId);
  if (!instance) throw new DashChatToolError('Remote instance not found');
  const result = await requestRemoteJsonPath<any[]>(
    instance,
    `/api/projects/${encodeURIComponent(parsed.projectId)}/agents`,
  );
  if (!result.ok) throw new DashChatToolError(result.error || 'Failed to load remote agents');
  const agents = Array.isArray(result.data) ? result.data : [];
  return agents.map((agent: any) => ({
    id: `remote-agent:${parsed.instanceId}:${trimString(agent?.id)}`,
    name: trimString(agent?.name),
    role: trimString(agent?.role),
    is_controller: Boolean(agent?.is_controller),
    status: trimString(agent?.status),
    paused: Boolean(agent?.paused),
    parent_agent_id: agent?.parent_agent_id
      ? `remote-agent:${parsed.instanceId}:${trimString(agent.parent_agent_id)}`
      : null,
  }));
}

// ── Tool executor ────────────────────────────────────────────

export async function executeChatTool(
  ctx: ChatToolContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { db, userContext } = ctx;

  switch (tool) {
    // ── search_projects ──────────────────────────
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

    // ── get_project ──────────────────────────────
    case 'get_project': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new DashChatToolError('project_id is required');
      const parsed = parseProjectId(projectId);
      if (!parsed) throw new DashChatToolError('Invalid project_id');

      if (parsed.kind === 'local') {
        const perm = getProjectPermission(db, parsed.projectId, userContext.user);
        const project = getProject(db, parsed.projectId, perm);
        return summarizeLocalProject(project, perm);
      }

      const instance = getRemoteInstance(db, parsed.instanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const result = await requestRemoteJsonPath<any>(
        instance,
        `/api/projects/${encodeURIComponent(parsed.projectId)}`,
      );
      if (!result.ok) throw new DashChatToolError(result.error || 'Failed to load remote project');
      return summarizeRemoteProject(result.data || {}, parsed.instanceId, instance);
    }

    // ── get_project_progress ─────────────────────
    case 'get_project_progress': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new DashChatToolError('project_id is required');
      const parsed = parseProjectId(projectId);
      if (!parsed) throw new DashChatToolError('Invalid project_id');
      const limit = clampLimit(args.limit, 12, 25);

      if (parsed.kind === 'local') {
        const perm = getProjectPermission(db, parsed.projectId, userContext.user);
        const [project, counts, agents, issues] = await Promise.all([
          Promise.resolve(getProject(db, parsed.projectId, perm)),
          Promise.resolve(getIssueCounts(db, parsed.projectId)),
          Promise.resolve(listProjectAgentsSvc(parsed.projectId)),
          Promise.resolve(listIssues(db, parsed.projectId, {
            sort: 'updated',
            per_page: String(limit),
          })),
        ]);

        const total = Number(counts.total || 0);
        const completed = Number(counts.done || 0) + Number(counts.closed || 0);
        return {
          project: summarizeLocalProject(project, perm),
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
          agents: agents.map((agent: any) => ({
            id: trimString(agent?.id),
            name: trimString(agent?.name),
            is_controller: Boolean(agent?.is_controller),
            status: trimString(agent?.status),
            paused: Boolean(agent?.paused),
            parent_agent_id: trimString(agent?.parent_agent_id) || null,
          })),
          recent_issues: (issues.issues || []).map(buildIssuePayloadResult),
        };
      }

      const instance = getRemoteInstance(db, parsed.instanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const basePath = `/api/projects/${encodeURIComponent(parsed.projectId)}`;
      const [projectRes, countsRes, agentsRes, issuesRes] = await Promise.all([
        requestRemoteJsonPath<any>(instance, basePath),
        requestRemoteJsonPath<any>(instance, `${basePath}/issues/counts`),
        requestRemoteJsonPath<any[]>(instance, `${basePath}/agents`),
        requestRemoteJsonPath<any>(instance, `${basePath}/issues?sort=updated&per_page=${limit}`),
      ]);
      if (!projectRes.ok) throw new DashChatToolError(projectRes.error || 'Failed to load remote project');
      if (!countsRes.ok) throw new DashChatToolError(countsRes.error || 'Failed to load remote issue counts');
      if (!agentsRes.ok) throw new DashChatToolError(agentsRes.error || 'Failed to load remote agents');
      if (!issuesRes.ok) throw new DashChatToolError(issuesRes.error || 'Failed to load remote issues');

      const remoteCounts = countsRes.data || {};
      const remoteIssues = Array.isArray(issuesRes.data?.issues) ? issuesRes.data?.issues : [];
      const remoteAgents = Array.isArray(agentsRes.data) ? agentsRes.data : [];
      const remoteTotal = Number(remoteCounts.total || 0);
      const remoteCompleted = Number(remoteCounts.done || 0) + Number(remoteCounts.closed || 0);
      return {
        project: summarizeRemoteProject(projectRes.data || {}, parsed.instanceId, instance),
        progress: {
          total_issues: remoteTotal,
          completed_issues: remoteCompleted,
          completion_ratio: remoteTotal > 0 ? Number((remoteCompleted / remoteTotal).toFixed(3)) : 0,
          open: Number(remoteCounts.open || 0),
          in_progress: Number(remoteCounts.in_progress || 0),
          pending: Number(remoteCounts.pending || 0),
          done: Number(remoteCounts.done || 0),
          closed: Number(remoteCounts.closed || 0),
        },
        agents: remoteAgents.map((agent: any) => ({
          id: `remote-agent:${parsed.instanceId}:${trimString(agent?.id)}`,
          name: trimString(agent?.name),
          is_controller: Boolean(agent?.is_controller),
          status: trimString(agent?.status),
          paused: Boolean(agent?.paused),
          parent_agent_id: agent?.parent_agent_id
            ? `remote-agent:${parsed.instanceId}:${trimString(agent.parent_agent_id)}`
            : null,
        })),
        recent_issues: remoteIssues.map(buildIssuePayloadResult),
      };
    }

    // ── list_project_agents ──────────────────────
    case 'list_project_agents': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new DashChatToolError('project_id is required');
      return { agents: await listAgentsForProject(ctx, projectId) };
    }

    // ── list_project_issues ──────────────────────
    case 'list_project_issues': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new DashChatToolError('project_id is required');
      const parsed = parseProjectId(projectId);
      if (!parsed) throw new DashChatToolError('Invalid project_id');
      const status = trimString(args.status);
      const assignedTo = trimString(args.assigned_to);
      const q = trimString(args.q);
      const limit = clampLimit(args.limit, 20, 50);

      if (parsed.kind === 'local') {
        const filters: Record<string, unknown> = { sort: 'updated', per_page: String(limit) };
        if (status) filters.status = status;
        if (assignedTo) filters.assigned_to = assignedTo;
        if (q) filters.q = q;
        const result = listIssues(db, parsed.projectId, filters as any);
        return {
          total: result.total,
          issues: (result.issues || []).map(buildIssuePayloadResult),
        };
      }

      const instance = getRemoteInstance(db, parsed.instanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (assignedTo) params.set('assigned_to', assignedTo);
      if (q) params.set('q', q);
      params.set('per_page', String(limit));
      params.set('sort', 'updated');
      const result = await requestRemoteJsonPath<any>(
        instance,
        `/api/projects/${encodeURIComponent(parsed.projectId)}/issues?${params.toString()}`,
      );
      if (!result.ok) throw new DashChatToolError(result.error || 'Failed to load remote issues');
      const remoteIssues = Array.isArray(result.data?.issues) ? result.data?.issues : [];
      return {
        total: Number(result.data?.total || remoteIssues.length || 0),
        issues: remoteIssues.map(buildIssuePayloadResult),
      };
    }

    // ── get_issue ────────────────────────────────
    case 'get_issue': {
      const issueId = trimString(args.issue_id);
      if (!issueId) throw new DashChatToolError('issue_id is required');
      const parsed = parseIssueId(issueId);
      if (!parsed) throw new DashChatToolError('Invalid issue_id');

      if (parsed.kind === 'local') {
        const data = getIssueDetail(db, parsed.issueId) as any;
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

      const instance = getRemoteInstance(db, parsed.instanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const result = await requestRemoteJsonPath<any>(
        instance,
        `/api/issues/${encodeURIComponent(parsed.issueId)}`,
      );
      if (!result.ok) throw new DashChatToolError(result.error || 'Failed to load remote issue');
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

    // ── get_issue_by_number ──────────────────────
    case 'get_issue_by_number': {
      const projectId = trimString(args.project_id);
      const issueNumber = trimString(args.issue_number);
      if (!projectId || !issueNumber) throw new DashChatToolError('project_id and issue_number are required');
      const parsed = parseProjectId(projectId);
      if (!parsed) throw new DashChatToolError('Invalid project_id');

      if (parsed.kind === 'local') {
        const data = getIssueByNumberDetail(db, parsed.projectId, Number(issueNumber)) as any;
        return { ...buildIssuePayloadResult(data), body: trimString(data?.body) };
      }

      const instance = getRemoteInstance(db, parsed.instanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const result = await requestRemoteJsonPath<any>(
        instance,
        `/api/projects/${encodeURIComponent(parsed.projectId)}/issues/number/${encodeURIComponent(issueNumber)}`,
      );
      if (!result.ok) throw new DashChatToolError(result.error || 'Failed to resolve remote issue by number');
      const data = result.data || {};
      return { ...buildIssuePayloadResult(data), body: trimString(data?.body) };
    }

    // ── create_issue ─────────────────────────────
    case 'create_issue': {
      const projectId = trimString(args.project_id);
      const title = trimString(args.title);
      const body = trimString(args.body);
      if (!projectId || !title || !body) {
        throw new DashChatToolError('project_id, title, and body are required');
      }
      const parsed = parseProjectId(projectId);
      if (!parsed) throw new DashChatToolError('Invalid project_id');

      if (parsed.kind === 'local') {
        const created = createIssue(db, parsed.projectId, {
          title,
          body,
          created_by: 'user',
          assigned_to: trimString(args.assigned_to) || undefined,
          labels: trimString(args.labels) || undefined,
          parent_id: trimString(args.parent_id) || undefined,
        });
        return { created: true, issue: buildIssuePayloadResult(created) };
      }

      const instance = getRemoteInstance(db, parsed.instanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const result = await requestRemoteJsonPath<any>(
        instance,
        `/api/projects/${encodeURIComponent(parsed.projectId)}/issues`,
        {
          method: 'POST',
          body: {
            title,
            body,
            created_by: 'user',
            assigned_to: trimString(args.assigned_to) || undefined,
            labels: trimString(args.labels) || undefined,
            parent_id: trimString(args.parent_id) || undefined,
          },
        },
      );
      if (!result.ok) throw new DashChatToolError(result.error || 'Failed to create remote issue');
      return { created: true, issue: buildIssuePayloadResult(result.data || {}) };
    }

    // ── update_issue ─────────────────────────────
    case 'update_issue': {
      const issueId = trimString(args.issue_id);
      if (!issueId) throw new DashChatToolError('issue_id is required');
      const parsed = parseIssueId(issueId);
      if (!parsed) throw new DashChatToolError('Invalid issue_id');

      const payload: Record<string, unknown> = {};
      ['status', 'assigned_to', 'title', 'body', 'labels'].forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(args, field)) {
          payload[field] = args[field] ?? null;
        }
      });
      if (Object.keys(payload).length === 0) {
        throw new DashChatToolError('At least one updatable field is required');
      }

      if (parsed.kind === 'local') {
        const updated = updateIssue(db, parsed.issueId, payload);
        return { updated: true, issue: buildIssuePayloadResult(updated) };
      }

      const instance = getRemoteInstance(db, parsed.instanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const result = await requestRemoteJsonPath<any>(
        instance,
        `/api/issues/${encodeURIComponent(parsed.issueId)}`,
        { method: 'PUT', body: payload },
      );
      if (!result.ok) throw new DashChatToolError(result.error || 'Failed to update remote issue');
      return { updated: true, issue: buildIssuePayloadResult(result.data || {}) };
    }

    // ── add_issue_comment ────────────────────────
    case 'add_issue_comment': {
      const issueId = trimString(args.issue_id);
      const body = trimString(args.body);
      if (!issueId || !body) throw new DashChatToolError('issue_id and body are required');
      const parsed = parseIssueId(issueId);
      if (!parsed) throw new DashChatToolError('Invalid issue_id');

      if (parsed.kind === 'local') {
        const comment = addIssueComment(db, parsed.issueId, { author_id: 'user', body });
        return {
          created: true,
          comment: {
            id: trimString((comment as any)?.id),
            body: trimString((comment as any)?.body),
            created_at: trimString((comment as any)?.created_at) || null,
          },
        };
      }

      const instance = getRemoteInstance(db, parsed.instanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const result = await requestRemoteJsonPath<any>(
        instance,
        `/api/issues/${encodeURIComponent(parsed.issueId)}/comments`,
        { method: 'POST', body: { author_id: 'user', body } },
      );
      if (!result.ok) throw new DashChatToolError(result.error || 'Failed to add remote issue comment');
      return {
        created: true,
        comment: {
          id: trimString(result.data?.id),
          body: trimString(result.data?.body),
          created_at: trimString(result.data?.created_at) || null,
        },
      };
    }

    // ── delete_issue ─────────────────────────────
    case 'delete_issue': {
      const issueId = trimString(args.issue_id);
      if (!issueId) throw new DashChatToolError('issue_id is required');
      if (args.confirm !== true) {
        throw new DashChatToolError('delete_issue requires confirm=true');
      }
      const parsed = parseIssueId(issueId);
      if (!parsed) throw new DashChatToolError('Invalid issue_id');

      if (parsed.kind === 'local') {
        deleteIssue(db, parsed.issueId);
        return { deleted: true, issue_id: parsed.issueId };
      }

      const instance = getRemoteInstance(db, parsed.instanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const result = await requestRemoteJsonPath<any>(
        instance,
        `/api/issues/${encodeURIComponent(parsed.issueId)}`,
        { method: 'DELETE' },
      );
      if (!result.ok) throw new DashChatToolError(result.error || 'Failed to delete remote issue');
      return { deleted: true, issue_id: issueId };
    }

    // ── create_project_from_request ──────────────
    case 'create_project_from_request': {
      const requestText = trimString(args.request);
      const targetInstanceId = trimString(args.target_instance_id) || 'localhost';
      if (!requestText) throw new DashChatToolError('request is required');

      if (targetInstanceId === 'localhost') {
        const generated = generateProjectMetadata({
          description: requestText,
          tool_path: ctx.command.template,
          command_type: ctx.command.type,
        });
        const created = createProject(db, {
          ...generated,
          command_template: ctx.command.template,
          command_type: ctx.command.type,
        }, userContext);
        const perm = getProjectPermission(db, (created as any).id, userContext.user);
        return { created: true, project: summarizeLocalProject(created, perm) };
      }

      const instance = getRemoteInstance(db, targetInstanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const generated = await generateRemoteProjectMetadata(instance, {
        description: requestText,
        tool_path: ctx.command.template,
        command_type: ctx.command.type,
      });
      if (!generated.ok) throw new DashChatToolError(generated.error || 'Failed to generate remote project metadata');
      const remoteCreated = await createRemoteProject(instance, {
        ...(generated.data || {}),
        command_template: ctx.command.template,
        command_type: ctx.command.type,
      } as any);
      if (!remoteCreated.ok) throw new DashChatToolError(remoteCreated.error || 'Failed to create remote project');
      return {
        created: true,
        project: summarizeRemoteProject(remoteCreated.data || {}, targetInstanceId, instance),
      };
    }

    // ── update_project ───────────────────────────
    case 'update_project': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new DashChatToolError('project_id is required');
      const parsed = parseProjectId(projectId);
      if (!parsed) throw new DashChatToolError('Invalid project_id');

      const payload: Record<string, unknown> = {};
      ['name', 'description', 'task_description', 'status', 'color'].forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(args, field)) {
          payload[field] = args[field] ?? null;
        }
      });
      if (Object.keys(payload).length === 0) {
        throw new DashChatToolError('At least one updatable field is required');
      }

      if (parsed.kind === 'local') {
        const perm = getProjectPermission(db, parsed.projectId, userContext.user);
        const updated = updateProject(db, parsed.projectId, payload as any, perm);
        return { updated: true, project: summarizeLocalProject(updated, perm) };
      }

      const instance = getRemoteInstance(db, parsed.instanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const result = await requestRemoteJsonPath<any>(
        instance,
        `/api/projects/${encodeURIComponent(parsed.projectId)}`,
        { method: 'PUT', body: payload },
      );
      if (!result.ok) throw new DashChatToolError(result.error || 'Failed to update remote project');
      return {
        updated: true,
        project: summarizeRemoteProject(result.data || {}, parsed.instanceId, instance),
      };
    }

    // ── delete_project ───────────────────────────
    case 'delete_project': {
      const projectId = trimString(args.project_id);
      if (!projectId) throw new DashChatToolError('project_id is required');
      if (args.confirm !== true) {
        throw new DashChatToolError('delete_project requires confirm=true');
      }
      const parsed = parseProjectId(projectId);
      if (!parsed) throw new DashChatToolError('Invalid project_id');

      if (parsed.kind === 'local') {
        const perm = getProjectPermission(db, parsed.projectId, userContext.user);
        deleteProject(db, parsed.projectId, perm);
        return { deleted: true, project_id: parsed.projectId };
      }

      const instance = getRemoteInstance(db, parsed.instanceId);
      if (!instance) throw new DashChatToolError('Remote instance not found');
      const result = await requestRemoteJsonPath<any>(
        instance,
        `/api/projects/${encodeURIComponent(parsed.projectId)}`,
        { method: 'DELETE' },
      );
      if (!result.ok) throw new DashChatToolError(result.error || 'Failed to delete remote project');
      return { deleted: true, project_id: projectId };
    }

    // ── delegate_task ────────────────────────────
    case 'delegate_task': {
      const projectId = trimString(args.project_id);
      const title = trimString(args.title);
      const details = trimString(args.details);
      if (!projectId || !title || !details) {
        throw new DashChatToolError('project_id, title, and details are required');
      }

      const agents = await listAgentsForProject(ctx, projectId);
      const explicitAgentId = trimString(args.agent_id);
      const explicitAgentName = trimString(args.agent_name).toLowerCase();
      const matchedAgent = explicitAgentId
        ? agents.find((agent: any) => agent.id === explicitAgentId) || null
        : (explicitAgentName
          ? agents.find((agent: any) => agent.name.toLowerCase() === explicitAgentName) || null
          : null);
      const fallbackAgent = matchedAgent || agents.find((agent: any) => agent.is_controller) || null;
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
      throw new DashChatToolError(`Unknown tool "${tool}"`);
  }
}
