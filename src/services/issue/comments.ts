import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { eventBus } from '../../events';
import {
  IssueCommentNotFoundError,
  IssueNotFoundError,
  MissingIssueCommentFieldsError,
} from './errors';
import { attachCommentReactions } from './utils';

export interface AddIssueCommentInput {
  author_id?: string;
  body?: string;
  silent?: boolean;
  event_type?: string;
  meta?: Record<string, unknown>;
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
  const { author_id, body, silent, event_type, meta } = input;
  if (!author_id || !body) throw new MissingIssueCommentFieldsError();

  const result = db.transaction(() => {
    const issue = getIssueOrThrow(db, issueId);
    const id = uuidv4();
    if (event_type || meta) {
      db.prepare('INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, issueId, author_id, body, event_type || 'comment', meta ? JSON.stringify(meta) : null);
    } else {
      db.prepare('INSERT INTO issue_comments (id, issue_id, author_id, body) VALUES (?, ?, ?, ?)')
        .run(id, issueId, author_id, body);
    }
    db.prepare("UPDATE issues SET updated_at = datetime('now'), acknowledged_at = NULL WHERE id = ?").run(issueId);
    const comment = getCommentOrThrow(db, id);
    return { issue, comment };
  })();

  if (!silent) {
    eventBus.publish('comment.added', {
      type: 'comment.added',
      projectId: result.issue.project_id,
      payload: {
        issueId,
        issueNumber: result.issue.number,
        issueTitle: result.issue.title,
        commentId: result.comment.id,
        authorId: author_id,
        body,
        issueStatus: result.issue.status,
        assignedTo: result.issue.assigned_to,
      },
      meta: { correlationId: uuidv4(), timestamp: Date.now(), source: 'issue/comments' },
    });
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
