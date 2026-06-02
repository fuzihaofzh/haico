import { eventBus } from '../bus';
import { getDatabase } from '../../db/database';
import type { ProjectDeletedEvent } from '../events';

export function registerProjectDeletionSubscribers(): void {
  eventBus.subscribe('project.deleted', (event) => {
    const db = getDatabase();
    const { agentIds } = (event.payload as ProjectDeletedEvent['payload']);
    const projectId = event.projectId;

    for (const agentId of agentIds) {
      db.prepare('DELETE FROM knowledge_entries WHERE owner_agent_id = ?').run(agentId);
      db.prepare('DELETE FROM executor_sessions WHERE agent_id = ?').run(agentId);
    }

    db.prepare('DELETE FROM knowledge_entries WHERE project_id = ? AND owner_agent_id IS NULL').run(projectId);
    db.prepare('DELETE FROM executive_summaries WHERE project_id = ?').run(projectId);
  });
}
