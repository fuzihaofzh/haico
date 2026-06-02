import { eventBus } from '../bus';
import { createAgentTaskWithId } from '../../services/tasks/core';
import { addIssueComment } from '../../services/issue/comments';
import { getDatabase } from '../../db/database';
import type { TaskRequestedEvent } from '../events';

export function registerTaskCreationSubscribers(): void {
  eventBus.subscribe('task.requested', (event) => {
    const p = event.payload as TaskRequestedEvent['payload'];
    const task = createAgentTaskWithId(p.taskId, p.agentId, {
      source: p.source,
      source_ref: p.sourceRef,
      task_type: p.taskType,
      reason: p.reason,
      prompt: p.prompt,
      priority: p.priority,
      metadata: p.metadata,
      dedupe_key: p.dedupeKey,
      force_new_session: p.forceNewSession,
      scheduled_at: p.scheduledAt,
    });

    if (p.auditComment) {
      const db = getDatabase();
      addIssueComment(db, p.auditComment.issueId, {
        author_id: 'system',
        body: p.auditComment.body,
        silent: true,
        event_type: 'status_change',
        meta: { task_id: task.id, source: p.source, ...p.metadata },
      });
    }
  });
}
