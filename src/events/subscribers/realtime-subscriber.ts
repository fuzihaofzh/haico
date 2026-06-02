import { eventBus } from '../bus';
import { broadcastToProject } from '../../realtime';
import { getDatabase } from '../../db/database';
import type { IssueUpdatedEvent, AgentStatusChangedEvent, AgentCreatedEvent, AgentDeletedEvent, AgentMessageUpdatedEvent, ProjectDeletedEvent, SummaryCreatedEvent, SummaryUpdatedEvent, SummaryBlockUpdatedEvent, SummaryGeneratedEvent, SummaryFinalizedEvent } from '../events';

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

  eventBus.subscribe('issue.deleted', (event) => {
    broadcastToProject(event.projectId, {
      type: 'issue_deleted',
      projectId: event.projectId,
      data: { issueId: event.payload.issueId, issueNumber: event.payload.issueNumber },
    });
  });

  eventBus.subscribe('agent.status_changed', (event) => {
    const p = event.payload as AgentStatusChangedEvent['payload'];
    broadcastToProject(event.projectId, {
      type: 'agent_status',
      projectId: event.projectId,
      data: {
        agentId: p.agentId,
        status: p.status,
        ...(p.paused !== undefined ? { paused: p.paused } : {}),
        ...(p.taskId ? { taskId: p.taskId } : {}),
        ...(p.taskRunId ? { taskRunId: p.taskRunId } : {}),
      },
    });
  });

  eventBus.subscribe('agent.message_sent', (event) => {
    broadcastToProject(event.projectId, {
      type: 'agent_message',
      projectId: event.projectId,
      data: { message: event.payload.message, from: event.payload.fromAgentName, to: event.payload.toAgentName },
    });
  });

  eventBus.subscribe('agent.created', (event) => {
    const p = event.payload as AgentCreatedEvent['payload'];
    broadcastToProject(event.projectId, {
      type: 'agent_created',
      projectId: event.projectId,
      data: { agentId: p.agentId, agentName: p.agentName, isController: p.isController },
    });
  });

  eventBus.subscribe('agent.deleted', (event) => {
    const p = event.payload as AgentDeletedEvent['payload'];
    broadcastToProject(event.projectId, {
      type: 'agent_deleted',
      projectId: event.projectId,
      data: { agentId: p.agentId, agentName: p.agentName },
    });
  });

  eventBus.subscribe('project.deleted', (event) => {
    broadcastToProject(event.projectId, {
      type: 'project_deleted',
      projectId: event.projectId,
      data: { projectId: event.projectId },
    });
  });

  eventBus.subscribe('agent.message_updated', (event) => {
    const p = event.payload as AgentMessageUpdatedEvent['payload'];
    const db = getDatabase();
    let messageData: any = null;
    if (p.message) {
      messageData = p.message;
    } else if ((p as any).messageId) {
      db.prepare("UPDATE agent_messages SET status = 'read' WHERE id = ? AND to_agent_id = ?")
        .run((p as any).messageId, (p as any).agentId);
      const row = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get((p as any).messageId);
      if (row) messageData = row;
    }
    if (messageData) {
      broadcastToProject(event.projectId, {
        type: 'agent_message',
        projectId: event.projectId,
        data: { message: messageData, status: p.status },
      });
    }
  });

  eventBus.subscribe('summary.created', (event) => {
    const p = event.payload as SummaryCreatedEvent['payload'];
    broadcastToProject(event.projectId, {
      type: 'executive_summary_created',
      projectId: event.projectId,
      data: p.summary as Record<string, any>,
    });
  });

  eventBus.subscribe('summary.updated', (event) => {
    const p = event.payload as SummaryUpdatedEvent['payload'];
    broadcastToProject(event.projectId, {
      type: 'executive_summary_updated',
      projectId: event.projectId,
      data: p.summary as Record<string, any>,
    });
  });

  eventBus.subscribe('summary.deleted', (event) => {
    broadcastToProject(event.projectId, {
      type: 'executive_summary_deleted',
      projectId: event.projectId,
      data: { id: event.payload.summaryId },
    });
  });

  eventBus.subscribe('summary.block_updated', (event) => {
    const p = event.payload as SummaryBlockUpdatedEvent['payload'];
    broadcastToProject(event.projectId, {
      type: 'executive_summary_block_updated',
      projectId: event.projectId,
      data: { summary_id: p.summaryId, block: p.block as Record<string, any> },
    });
  });

  eventBus.subscribe('summary.generated', (event) => {
    const p = event.payload as SummaryGeneratedEvent['payload'];
    broadcastToProject(event.projectId, {
      type: 'executive_summary_generated',
      projectId: event.projectId,
      data: p.summary as Record<string, any>,
    });
  });

  eventBus.subscribe('summary.finalized', (event) => {
    const p = event.payload as SummaryFinalizedEvent['payload'];
    broadcastToProject(event.projectId, {
      type: 'executive_summary_finalized',
      projectId: event.projectId,
      data: p.summary as Record<string, any>,
    });
  });
}
