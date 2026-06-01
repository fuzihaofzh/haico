import { eventBus } from '../bus';
import { createAgentTaskWithId } from '../../services/tasks/core';
import { getDatabase } from '../../db/database';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../logger';
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
      db.prepare(
        'INSERT INTO issue_comments (id, issue_id, author_id, body, event_type, meta) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        uuidv4(),
        p.auditComment.issueId,
        'system',
        p.auditComment.body,
        'status_change',
        JSON.stringify({ task_id: task.id, source: p.source, ...p.metadata })
      );
    }
  });
}
