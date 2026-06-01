import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Agent, Project } from '../../types';
import logger from '../../logger';
import { tryHandleWithoutLLM } from '../pre-controller';
import { eventBus } from '../../events';
import { autoStartAgentForDispatchableIssues } from './agent-autostart';

export function parseMentionedAgentNames(text: string): string[] {
  if (!text) return [];
  const mentionPattern = /@([\w-]+)/g;
  const mentions = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(text)) !== null) {
    mentions.add(match[1]);
  }
  return [...mentions];
}

export function findFirstMentionedAgent(text: string, agents: Agent[]): Agent | undefined {
  const mentionPattern = /@([\w-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(text)) !== null) {
    const agent = agents.find((candidate) => candidate.name === match![1]);
    if (agent) return agent;
  }
  return undefined;
}

function nameOfAgent(agentId: string, agents: Agent[]): string {
  const agent = agents.find((candidate) => candidate.id === agentId);
  return agent ? agent.name : agentId;
}

function buildMentionTaskPrompt(input: {
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  mentionText: string;
  authorId: string;
  agentName: string;
}): string {
  return [
    `You were mentioned as @${input.agentName} on issue #${input.issueNumber}.`,
    '',
    `Issue ID: ${input.issueId}`,
    `Issue title: ${input.issueTitle}`,
    `Mentioned by: ${input.authorId}`,
    '',
    'Source text:',
    input.mentionText,
    '',
    'Review the issue context through the HAICO issue APIs, then make progress on the requested work. Leave a substantive issue comment before finishing.',
  ].join('\n');
}

export function parseMentionsAndStartAgents(
  db: Database.Database,
  text: string,
  projectId: string,
  issueId: string,
  issueNumber: number,
  issueTitle: string,
  authorId: string
): void {
  const mentions = parseMentionedAgentNames(text);
  if (mentions.length === 0) return;

  const agents = db.prepare('SELECT * FROM agents WHERE project_id = ?').all(projectId) as Agent[];

  for (const agentName of mentions) {
    const agent = agents.find((candidate) => candidate.name === agentName);
    if (!agent) continue;

    const taskId = uuidv4();
    const prompt = buildMentionTaskPrompt({
      issueId,
      issueNumber,
      issueTitle,
      mentionText: text,
      authorId,
      agentName: agent.name,
    });
    eventBus.publish('task.requested', {
      type: 'task.requested',
      projectId,
      payload: {
        taskId,
        agentId: agent.id,
        source: 'issue-mention',
        sourceRef: issueId,
        taskType: 'issue-work',
        reason: `@${agent.name} mentioned on issue #${issueNumber}`,
        prompt,
        priority: 10,
        metadata: {
          issue_id: issueId,
          issue_number: issueNumber,
          issue_title: issueTitle,
          mentioned_agent_name: agent.name,
          triggered_by: authorId,
        },
        dedupeKey: null,
        forceNewSession: false,
        scheduledAt: null,
        auditComment: {
          issueId,
          body: `Task queued for @${agent.name} from mention on issue #${issueNumber}`,
        },
      },
      meta: { correlationId: taskId, timestamp: Date.now(), source: 'issue/automation.parseMentionsAndStartAgents' },
    });
  }
}

export function triggerControllerOnDemand(
  db: Database.Database,
  projectId: string,
  triggerIssueNumber?: number,
  actorId?: string,
  opts?: { reason?: string; forceUrgent?: boolean }
): void {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project || project.status === 'paused') return;

  if (tryHandleWithoutLLM(projectId, triggerIssueNumber)) return;

  const controller = db.prepare(
    'SELECT * FROM agents WHERE project_id = ? AND is_controller = 1'
  ).get(projectId) as Agent | undefined;
  if (!controller || controller.paused) return;

  if (actorId && actorId === controller.id) return;

  const isUserAction = actorId === 'user' || actorId === 'system' || opts?.forceUrgent;

  if (!isUserAction && actorId && triggerIssueNumber) {
    const issue = db.prepare(
      'SELECT assigned_to, status FROM issues WHERE project_id = ? AND number = ?'
    ).get(projectId, triggerIssueNumber) as { assigned_to: string | null; status: string } | undefined;

    if (issue) {
      if (issue.assigned_to === actorId && issue.status !== 'pending') return;
      if (issue.status === 'done' || issue.status === 'closed') return;
    }
  }

  eventBus.publish('controller.trigger_requested', {
    type: 'controller.trigger_requested',
    projectId,
    payload: {
      triggerIssueNumber,
      priority: isUserAction ? 'urgent' : 'normal',
      reason: opts?.reason || (isUserAction ? 'user-action' : 'agent-event'),
      actorId,
    },
    meta: { correlationId: uuidv4(), timestamp: Date.now(), source: 'issue/automation.triggerControllerOnDemand' },
  });
}

export function autoStartAssignedAgentForIssue(
  db: Database.Database,
  projectId: string,
  issueNumber: number,
  assignedTo: string | undefined | null,
  source: string
): void {
  if (!assignedTo || assignedTo === 'user' || assignedTo === 'all') return;

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project) return;
  const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND project_id = ?').get(assignedTo, projectId) as Agent | undefined;
  if (!agent) return;

  const result = autoStartAgentForDispatchableIssues(db, project, agent, { source });
  logger.debug({
    projectId,
    issueNumber,
    assignedTo,
    source,
    taskId: result.taskId,
    reason: result.reason,
    activeIssueCount: result.activeIssueCount,
    currentBatchIssueNumbers: result.currentBatchIssueNumbers,
  }, result.started ? 'issue.assigned_task_created' : 'issue.assigned_task_skipped');
}

export function autoStartAgentFromUserComment(
  db: Database.Database,
  project: Project,
  issueNumber: number,
  agent: Agent,
  input: {
    issueId: string;
    issueTitle: string;
    commentId: string;
    commentBody: string;
  }
): void {
  if (project.status === 'paused') return;

  const prompt = [
    `A user comment routed issue #${issueNumber} to you.`,
    '',
    `Issue ID: ${input.issueId}`,
    `Issue title: ${input.issueTitle}`,
    `Comment ID: ${input.commentId}`,
    '',
    'User comment:',
    input.commentBody,
    '',
    'Inspect the issue through the HAICO issue APIs, respond to the user comment, and update issue state if needed.',
  ].join('\n');

  const taskId = uuidv4();
  eventBus.publish('task.requested', {
    type: 'task.requested',
    projectId: project.id,
    payload: {
      taskId,
      agentId: agent.id,
      source: 'user-comment',
      sourceRef: input.commentId,
      taskType: 'issue-work',
      reason: `User comment routed issue #${issueNumber} to ${agent.name}`,
      prompt,
      priority: 10,
      metadata: {
        issue_id: input.issueId,
        issue_number: issueNumber,
        issue_title: input.issueTitle,
        comment_id: input.commentId,
        routed_agent_id: agent.id,
      },
      dedupeKey: ['issue-user-comment', project.id, agent.id, input.commentId].join(':'),
      forceNewSession: false,
      scheduledAt: null,
    },
    meta: { correlationId: taskId, timestamp: Date.now(), source: 'issue/automation.autoStartAgentFromUserComment' },
  });
}
