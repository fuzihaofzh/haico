import { eventBus } from '../bus';
import { autoStartAssignedAgentForIssue, parseMentionsAndStartAgents, autoStartAgentFromUserComment } from '../../services/issue/automation';
import { getDatabase } from '../../db/database';
import { Agent, Project } from '../../types';
import type { IssueCreatedEvent, IssueUpdatedEvent, CommentAddedEvent } from '../events';

const FALLBACK_CONTROLLER_ID = 'b9b6362c-2d59-40cd-9ffc-fd871a7e811e';

export function registerAgentSubscribers(): void {
  eventBus.subscribe('issue.created', (event) => {
    const p = event.payload as IssueCreatedEvent['payload'];
    const { createdBy, assignedTo, issueNumber, issueId, title, body } = p;
    const db = getDatabase();

    if (createdBy === 'user' && assignedTo) {
      autoStartAssignedAgentForIssue(db, event.projectId, issueNumber, assignedTo, 'issue-create-assignment');
    }
    if (body) {
      parseMentionsAndStartAgents(db, body, event.projectId, issueId, issueNumber, title, createdBy);
    }
  });

  eventBus.subscribe('issue.updated', (event) => {
    const p = event.payload as IssueUpdatedEvent['payload'];
    const { actor, issueNumber, changes } = p;
    const db = getDatabase();

    if (actor === 'user' && changes?.assignedTo?.to) {
      autoStartAssignedAgentForIssue(
        db, event.projectId, issueNumber,
        changes.assignedTo.to as string,
        'issue-update-assignment'
      );
    }
  });

  eventBus.subscribe('comment.added', (event) => {
    const p = event.payload as CommentAddedEvent['payload'];
    const { authorId, body, issueId, issueNumber, issueTitle, commentId } = p;
    const db = getDatabase();

    parseMentionsAndStartAgents(db, body, event.projectId, issueId, issueNumber, issueTitle, authorId);

    if (authorId === 'user') {
      const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId) as any;
      if (issue) {
        const agents = db.prepare('SELECT * FROM agents WHERE project_id = ?').all(issue.project_id) as Agent[];
        const mentionPattern = /@([\w-]+)/g;
        let match: RegExpExecArray | null;
        let targetAgent: Agent | undefined;
        while ((match = mentionPattern.exec(body)) !== null) {
          const found = agents.find((a) => a.name === match![1]);
          if (found) { targetAgent = found; break; }
        }
        const controllerAgent = agents.find((a) => a.is_controller);

        const newAssignee = targetAgent?.id || controllerAgent?.id || FALLBACK_CONTROLLER_ID;
        if (newAssignee && newAssignee !== issue.assigned_to) {
          db.prepare('UPDATE issues SET assigned_to = ? WHERE id = ?').run(newAssignee, issueId);
        }

        if (issue.status === 'done' || issue.status === 'closed') {
          db.prepare("UPDATE issues SET status = 'open' WHERE id = ?").run(issueId);
        }

        const agentToStart = targetAgent || controllerAgent;
        if (agentToStart && !targetAgent) {
          const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(issue.project_id) as Project | undefined;
          if (project && project.status !== 'paused') {
            autoStartAgentFromUserComment(db, project, issue.number, agentToStart, {
              issueId,
              issueTitle: issue.title,
              commentId,
              commentBody: body,
            });
          }
        }
      }
    }
  });
}
