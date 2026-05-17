import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Agent, Issue, Project } from '../../types';
import { config } from '../../config';
import logger from '../../logger';
import { autoStartAgentForDispatchableIssues } from './agent-autostart';
import { enqueueControllerTrigger } from '../controller';
import { getAgentWakeupDecision, recordAgentWakeup } from '../agent-wakeup-guard';
import { tryHandleWithoutLLM } from '../pre-controller';
import { buildSystemPrompt } from '../system-prompt';
import { isAgentRunning, startAgentProcess } from '../process-manager';

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
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId) as Issue | undefined;
  const eventStmt = db.prepare(
    'INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)'
  );

  for (const agentName of mentions) {
    const agent = agents.find((candidate) => candidate.name === agentName);
    if (!agent) continue;

    if (!agent.paused && agent.status !== 'running' && !isAgentRunning(agent.id)) {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
      if (project && project.status !== 'paused') {
        const wakeDecision = issue
          ? getAgentWakeupDecision(agent, [issue], { source: 'issue-mention', allowStatuses: ['idle', 'error'] })
          : { allowed: agent.status === 'idle', reason: 'issue-mention: no issue context', signature: '', activityKey: '', activeIssueCount: 0, currentBatchIssueNumbers: [] };
        if (!wakeDecision.allowed) {
          logger.debug({
            projectId,
            issueId,
            issueNumber,
            agentId: agent.id,
            reason: wakeDecision.reason,
          }, 'issue.mention_autostart_skipped');
          continue;
        }

        const prompt = `You were mentioned (@${agentName}) in issue #${issueNumber} "${issueTitle}". Review the issue and take action.\n\nContext: ${text.slice(0, 500)}`;
        const commandTemplate = agent.command_template || project.command_template || config.defaultCommandTemplate;
        const isRaw = /^\s*(bash|sh|zsh)\s+-c\b/.test(commandTemplate);
        const systemPrompt = isRaw ? undefined : buildSystemPrompt(agent, project);
        const run = startAgentProcess(agent, prompt, commandTemplate, systemPrompt);
        recordAgentWakeup(agent.id, wakeDecision.signature, 'issue-mention', wakeDecision.activityKey);
        logger.info({
          projectId,
          issueId,
          issueNumber,
          agentId: agent.id,
          runId: run.runId,
          triggeredBy: authorId,
        }, 'issue.mention_autostarted');

        eventStmt.run(
          uuidv4(),
          issueId,
          'system',
          `auto-started ${agent.name} (mentioned by ${authorId === 'user' ? 'user' : nameOfAgent(authorId, agents)})`,
          'status_change',
          JSON.stringify({ mention: agentName, agent_id: agent.id, triggered_by: authorId })
        );
      }
    }
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

  enqueueControllerTrigger(project, {
    issueNumber: triggerIssueNumber,
    priority: isUserAction ? 'urgent' : 'normal',
    reason: opts?.reason || (isUserAction ? 'user-action' : 'agent-event'),
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

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(assignedTo) as Agent | undefined;
  if (!agent || agent.paused || agent.status === 'running' || isAgentRunning(agent.id)) return;

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project || project.status === 'paused') return;

  const result = autoStartAgentForDispatchableIssues(db, project, agent, {
    source,
    allowStatuses: ['idle', 'error'],
  });
  if (!result.started) {
    logger.debug({
      projectId,
      issueNumber,
      agentId: agent.id,
      reason: result.reason,
      activeIssueCount: result.activeIssueCount,
    }, 'issue.assigned_autostart_skipped');
  }
}

export function autoStartAgentFromUserComment(
  db: Database.Database,
  project: Project,
  issueNumber: number,
  agent: Agent
): void {
  if (agent.paused || agent.status === 'running' || isAgentRunning(agent.id)) return;

  if (agent.is_controller) {
    enqueueControllerTrigger(project, {
      issueNumber,
      priority: 'urgent',
      reason: 'user-comment-to-controller',
      skipActivityCheck: true,
    });
    return;
  }

  const result = autoStartAgentForDispatchableIssues(db, project, agent, {
    source: 'user-comment-reassignment',
    allowStatuses: ['idle', 'error'],
  });
  if (!result.started) {
    logger.debug({
      projectId: project.id,
      issueNumber,
      agentId: agent.id,
      reason: result.reason,
      activeIssueCount: result.activeIssueCount,
    }, 'issue.user_comment_autostart_skipped');
  }
}
