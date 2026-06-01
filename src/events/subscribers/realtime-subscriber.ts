import { eventBus } from '../bus';
import { broadcastToProject } from '../../realtime';
import { getDatabase } from '../../db/database';
import type { IssueUpdatedEvent } from '../events';

export function registerRealtimeSubscribers(): void {
  eventBus.subscribe('issue.created', (event) => {
    const db = getDatabase();
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(event.payload.issueId);
    if (issue) {
      broadcastToProject(event.projectId, {
        type: 'issue_created',
        projectId: event.projectId,
        data: { issue },
      });
    }
  });

  eventBus.subscribe('issue.updated', (event) => {
    const db = getDatabase();
    const p = event.payload as IssueUpdatedEvent['payload'];
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(p.issueId);
    if (issue) {
      broadcastToProject(event.projectId, {
        type: 'issue_updated',
        projectId: event.projectId,
        data: { issue },
      });
    }

    if (p.refreshedParentId) {
      const parent = db.prepare('SELECT * FROM issues WHERE id = ?').get(p.refreshedParentId);
      if (parent) {
        broadcastToProject(event.projectId, {
          type: 'issue_updated',
          projectId: event.projectId,
          data: { issue: parent },
        });
      }
    }
  });

  eventBus.subscribe('comment.added', (event) => {
    const db = getDatabase();
    const comment = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(event.payload.commentId);
    if (comment) {
      broadcastToProject(event.projectId, {
        type: 'comment_added',
        projectId: event.projectId,
        data: { comment, issueId: event.payload.issueId, issueNumber: event.payload.issueNumber },
      });
    }
  });

  eventBus.subscribe('issue.relation_changed', (event) => {
    const db = getDatabase();
    const sourceIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(event.payload.sourceIssueId);
    if (sourceIssue) {
      broadcastToProject(event.projectId, {
        type: 'issue_updated',
        projectId: event.projectId,
        data: { issue: sourceIssue },
      });
    }
  });
}
