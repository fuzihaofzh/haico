import { eventBus } from '../bus';
import { getDatabase } from '../../db/database';
import type { AgentDeletedEvent } from '../events';

export function registerAgentDeletionSubscribers(): void {
  eventBus.subscribe('agent.deleted', (event) => {
    const db = getDatabase();
    const { agentId } = (event.payload as AgentDeletedEvent['payload']);

    db.prepare('UPDATE issues SET assigned_to = NULL WHERE assigned_to = ?').run(agentId);
    db.prepare('DELETE FROM knowledge_entries WHERE owner_agent_id = ?').run(agentId);
    db.prepare('DELETE FROM executor_sessions WHERE agent_id = ?').run(agentId);
  });
}
