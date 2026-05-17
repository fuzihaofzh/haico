import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Agent, Project } from '../../types';
import { broadcastToProject } from '../../realtime';
import {
  IssueCommentNotFoundError,
  IssueNotFoundError,
  MissingIssueCommentFieldsError,
} from './errors';
import { attachCommentReactions } from './utils';
import {
  autoStartAgentFromUserComment,
  findFirstMentionedAgent,
  parseMentionsAndStartAgents,
  triggerControllerOnDemand,
} from './automation';

const FALLBACK_CONTROLLER_ID = 'b9b6362c-2d59-40cd-9ffc-fd871a7e811e';

export interface AddIssueCommentInput {
  author_id?: string;
  body?: string;
}

export interface UpdateIssueCommentInput {
  body?: string;
}

function getIssueOrThrow(db: Database.Database, issueId: string): any {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId) as any;
  if (!issue) throw new IssueNotFoundError();
  return issue;
}

function getCommentOrThrow(db: Database.Database, commentId: string): any {
  const comment = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(commentId) as any;
  if (!comment) throw new IssueCommentNotFoundError();
  return comment;
}

function handleUserCommentReassignment(db: Database.Database, issue: any, body: string, issueId: string): void {
  const agents = db.prepare('SELECT * FROM agents WHERE project_id = ?').all(issue.project_id) as Agent[];
  const targetAgent = findFirstMentionedAgent(body, agents);
  const controllerAgent = agents.find((agent) => agent.is_controller);
  const newAssignee = targetAgent ? targetAgent.id : (controllerAgent?.id || FALLBACK_CONTROLLER_ID);

  db.prepare('UPDATE issues SET assigned_to = ? WHERE id = ?').run(newAssignee, issueId);

  if (issue.status === 'done' || issue.status === 'closed') {
    db.prepare("UPDATE issues SET status = 'open' WHERE id = ?").run(issueId);
  }

  const agentToStart = targetAgent || (controllerAgent as Agent | undefined);
  if (!agentToStart) return;

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(issue.project_id) as Project | undefined;
  if (!project || project.status === 'paused') return;

  autoStartAgentFromUserComment(db, project, issue.number, agentToStart);
}

export function listIssueComments(db: Database.Database, issueId: string, sinceCreatedAt?: string): any[] {
  const comments = sinceCreatedAt
    ? db.prepare(
      'SELECT * FROM issue_comments WHERE issue_id = ? AND created_at >= ? ORDER BY created_at'
    ).all(issueId, sinceCreatedAt) as any[]
    : db.prepare(
      'SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at'
    ).all(issueId) as any[];
  return attachCommentReactions(db, comments);
}

export function addIssueComment(db: Database.Database, issueId: string, input: AddIssueCommentInput): any {
  const { author_id, body } = input;
  if (!author_id || !body) throw new MissingIssueCommentFieldsError();

  const result = db.transaction(() => {
    const issue = getIssueOrThrow(db, issueId);
    const id = uuidv4();
    db.prepare('INSERT INTO issue_comments (id, issue_id, author_id, body) VALUES (?, ?, ?, ?)')
      .run(id, issueId, author_id, body);
    db.prepare("UPDATE issues SET updated_at = datetime('now'), acknowledged_at = NULL WHERE id = ?").run(issueId);
    const comment = getCommentOrThrow(db, id);
    return { issue, comment };
  })();

  broadcastToProject(result.issue.project_id, {
    type: 'comment_added',
    projectId: result.issue.project_id,
    data: { comment: result.comment, issueId, issueNumber: result.issue.number },
  });

  parseMentionsAndStartAgents(db, body, result.issue.project_id, issueId, result.issue.number, result.issue.title, author_id);

  triggerControllerOnDemand(db, result.issue.project_id, result.issue.number, author_id, {
    reason: 'comment-added',
  });

  if (author_id === 'user') {
    handleUserCommentReassignment(db, result.issue, body, issueId);
  }

  return result.comment;
}

export function updateIssueComment(db: Database.Database, commentId: string, input: UpdateIssueCommentInput): any {
  getCommentOrThrow(db, commentId);
  db.prepare('UPDATE issue_comments SET body = ? WHERE id = ?').run(input.body, commentId);
  return getCommentOrThrow(db, commentId);
}

export function deleteIssueComment(db: Database.Database, commentId: string): void {
  getCommentOrThrow(db, commentId);
  db.prepare('DELETE FROM issue_comments WHERE id = ?').run(commentId);
}
