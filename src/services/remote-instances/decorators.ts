import type { RemoteInstanceRecord } from './core';

function parseRemoteProjectCompositeId(value: unknown): { instanceId: string; remoteProjectId: string } | null {
  const match = /^remote:([^:]+):(.+)$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    instanceId: match[1],
    remoteProjectId: match[2],
  };
}

function prefixRemoteIssueId(instanceId: string, remoteIssueId: unknown): string {
  return `remote-issue:${instanceId}:${String(remoteIssueId || '')}`;
}

function prefixRemoteCommentId(instanceId: string, remoteCommentId: unknown): string {
  return `remote-comment:${instanceId}:${String(remoteCommentId || '')}`;
}

function prefixRemoteAgentId(instanceId: string, remoteAgentId: unknown): string {
  return `remote-agent:${instanceId}:${String(remoteAgentId || '')}`;
}

function parseRemoteAgentCompositeId(value: unknown): { instanceId: string; remoteAgentId: string } | null {
  const match = /^remote-agent:([^:]+):(.+)$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    instanceId: match[1],
    remoteAgentId: match[2],
  };
}

function stripRemoteAgentId(value: unknown): string {
  const parsed = parseRemoteAgentCompositeId(value);
  return parsed ? parsed.remoteAgentId : String(value || '').trim();
}

function prefixRemoteApprovalId(instanceId: string, remoteApprovalId: unknown): string {
  return `remote-approval:${instanceId}:${String(remoteApprovalId || '')}`;
}

function prefixRemoteKnowledgeId(instanceId: string, remoteKnowledgeId: unknown): string {
  return `remote-knowledge:${instanceId}:${String(remoteKnowledgeId || '')}`;
}

function parseRemoteIssueCompositeId(value: unknown): { instanceId: string; remoteIssueId: string } | null {
  const match = /^remote-issue:([^:]+):(.+)$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    instanceId: match[1],
    remoteIssueId: match[2],
  };
}

function stripRemoteIssueId(value: unknown): string {
  const parsed = parseRemoteIssueCompositeId(value);
  return parsed ? parsed.remoteIssueId : String(value || '').trim();
}

export function decorateRemoteNotificationIssue(instance: RemoteInstanceRecord, issue: any) {
  const remoteIssueId = String(issue?.id || '');
  const remoteProjectId = String(issue?.project_id || '');
  return {
    ...issue,
    id: prefixRemoteIssueId(instance.id, remoteIssueId),
    remote_issue_id: remoteIssueId,
    project_id: `remote:${instance.id}:${remoteProjectId}`,
    remote_project_id: remoteProjectId,
    remote_instance_id: instance.id,
    remote_instance_name: instance.name,
    remote_base_url: instance.base_url,
    remote_project_url: `${instance.base_url}/projects/${encodeURIComponent(remoteProjectId)}`,
    remote_issue_url: `${instance.base_url}/projects/${encodeURIComponent(remoteProjectId)}/issues/${encodeURIComponent(issue?.number || '')}`,
    is_remote: true,
    project_name: String(issue?.project_name || instance.name),
  };
}

export function decorateRemoteNotificationComment(instance: RemoteInstanceRecord, comment: any) {
  return {
    ...comment,
    id: prefixRemoteCommentId(instance.id, comment?.id || ''),
    remote_comment_id: String(comment?.id || ''),
    issue_id: prefixRemoteIssueId(instance.id, comment?.issue_id || ''),
    remote_issue_id: String(comment?.issue_id || ''),
    project_id: comment?.project_id ? `remote:${instance.id}:${String(comment.project_id)}` : '',
    remote_project_id: String(comment?.project_id || ''),
    remote_instance_id: instance.id,
    is_remote: true,
  };
}

export function decorateRemoteIssueDetail(instance: RemoteInstanceRecord, issue: any) {
  const remoteIssueId = String(issue?.id || '');
  const remoteProjectId = String(issue?.project_id || '');
  const decorateRelation = (relation: any) => ({
    ...relation,
    project_id: `remote:${instance.id}:${remoteProjectId}`,
    source_issue_id: relation?.source_issue_id ? prefixRemoteIssueId(instance.id, relation.source_issue_id) : relation?.source_issue_id,
    target_issue_id: relation?.target_issue_id ? prefixRemoteIssueId(instance.id, relation.target_issue_id) : relation?.target_issue_id,
  });
  return {
    ...issue,
    id: prefixRemoteIssueId(instance.id, remoteIssueId),
    remote_issue_id: remoteIssueId,
    project_id: `remote:${instance.id}:${remoteProjectId}`,
    remote_project_id: remoteProjectId,
    remote_instance_id: instance.id,
    remote_instance_name: instance.name,
    remote_base_url: instance.base_url,
    remote_project_url: `${instance.base_url}/projects/${encodeURIComponent(remoteProjectId)}`,
    remote_issue_url: `${instance.base_url}/projects/${encodeURIComponent(remoteProjectId)}/issues/${encodeURIComponent(issue?.number || '')}`,
    is_remote: true,
    parent_id: issue?.parent_id ? prefixRemoteIssueId(instance.id, issue.parent_id) : issue?.parent_id,
    comments: Array.isArray(issue?.comments) ? issue.comments.map((comment: any) => ({
      ...comment,
      remote_comment_id: String(comment?.id || ''),
    })) : [],
    reactions: Array.isArray(issue?.reactions) ? issue.reactions : [],
    children: Array.isArray(issue?.children) ? issue.children.map((child: any) => ({
      ...child,
      id: child?.id ? prefixRemoteIssueId(instance.id, child.id) : child?.id,
      project_id: `remote:${instance.id}:${remoteProjectId}`,
    })) : [],
    blocks: Array.isArray(issue?.blocks) ? issue.blocks.map(decorateRelation) : [],
    blocked_by: Array.isArray(issue?.blocked_by) ? issue.blocked_by.map(decorateRelation) : [],
    related_to: Array.isArray(issue?.related_to) ? issue.related_to.map(decorateRelation) : [],
  };
}

export function decorateRemoteAgent(instance: RemoteInstanceRecord, remoteProjectId: string, agent: any) {
  const actualRemoteProjectId = String(agent?.project_id || remoteProjectId || '');
  const remoteAgentId = String(agent?.id || '');
  return {
    ...agent,
    id: prefixRemoteAgentId(instance.id, remoteAgentId),
    remote_agent_id: remoteAgentId,
    project_id: `remote:${instance.id}:${actualRemoteProjectId}`,
    remote_project_id: actualRemoteProjectId,
    remote_instance_id: instance.id,
    remote_instance_name: instance.name,
    is_remote: true,
    parent_agent_id: agent?.parent_agent_id ? prefixRemoteAgentId(instance.id, agent.parent_agent_id) : null,
  };
}

export function decorateRemoteIssueSummary(instance: RemoteInstanceRecord, remoteProjectId: string, issue: any) {
  return decorateRemoteNotificationIssue(instance, {
    ...issue,
    project_id: remoteProjectId || issue?.project_id || '',
  });
}

export function decorateRemoteApproval(instance: RemoteInstanceRecord, remoteProjectId: string, approval: any) {
  const remoteIssueId = approval?.issue_id ? String(approval.issue_id) : '';
  return {
    ...approval,
    id: prefixRemoteApprovalId(instance.id, approval?.id || ''),
    remote_approval_id: String(approval?.id || ''),
    project_id: `remote:${instance.id}:${String(remoteProjectId || approval?.project_id || '')}`,
    remote_project_id: String(remoteProjectId || approval?.project_id || ''),
    issue_id: remoteIssueId ? prefixRemoteIssueId(instance.id, remoteIssueId) : null,
    remote_issue_id: remoteIssueId || null,
    remote_instance_id: instance.id,
    is_remote: true,
  };
}

export function decorateRemoteKnowledgeEntry(instance: RemoteInstanceRecord, remoteProjectId: string, entry: any) {
  return {
    ...entry,
    id: prefixRemoteKnowledgeId(instance.id, entry?.id || ''),
    remote_knowledge_id: String(entry?.id || ''),
    project_id: `remote:${instance.id}:${String(remoteProjectId || entry?.project_id || '')}`,
    remote_project_id: String(remoteProjectId || entry?.project_id || ''),
    remote_instance_id: instance.id,
    is_remote: true,
  };
}

export function decorateRemoteActivityEvent(instance: RemoteInstanceRecord, remoteProjectId: string, event: any) {
  const decorated = {
    ...event,
    project_id: `remote:${instance.id}:${String(remoteProjectId || event?.project_id || '')}`,
    remote_project_id: String(remoteProjectId || event?.project_id || ''),
    remote_instance_id: instance.id,
    is_remote: true,
  };
  if (event?.event_type === 'issue' || event?.event_type === 'comment') {
    decorated.id = prefixRemoteIssueId(instance.id, event?.id || event?.issue_id || '');
  }
  if (event?.event_type === 'agent_run' && event?.object_id) {
    decorated.object_id = prefixRemoteAgentId(instance.id, event.object_id);
  }
  return decorated;
}

export function decorateRemoteWorkflowStatus(instance: RemoteInstanceRecord, remoteProjectId: string, data: any) {
  return {
    ...data,
    agents: Array.isArray(data?.agents) ? data.agents.map((agent: any) => decorateRemoteAgent(instance, remoteProjectId, agent)) : [],
    recent_messages: Array.isArray(data?.recent_messages) ? data.recent_messages.map((message: any) => ({
      ...message,
      from_agent_id: message?.from_agent_id ? prefixRemoteAgentId(instance.id, message.from_agent_id) : '',
      to_agent_id: message?.to_agent_id ? prefixRemoteAgentId(instance.id, message.to_agent_id) : '',
      remote_instance_id: instance.id,
      is_remote: true,
    })) : [],
    pending_approvals: Array.isArray(data?.pending_approvals)
      ? data.pending_approvals.map((approval: any) => decorateRemoteApproval(instance, remoteProjectId, approval))
      : [],
  };
}

export function buildRemoteProxyPath(pathname: string, query: Record<string, unknown> | undefined): string {
  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const normalized = String(value).trim();
    if (!normalized) return;
    params.set(key, normalized);
  });
  const queryString = params.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

export { parseRemoteProjectCompositeId, prefixRemoteIssueId, prefixRemoteCommentId, prefixRemoteAgentId, parseRemoteAgentCompositeId, stripRemoteAgentId, prefixRemoteApprovalId, prefixRemoteKnowledgeId, parseRemoteIssueCompositeId, stripRemoteIssueId };
