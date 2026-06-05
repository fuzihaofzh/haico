import type { SkillDefinition, SkillPromptContext } from '../types';
import { getDatabase } from '../../../db/database';

interface UnreadMessageRow { id: string; subject: string | null; body: string; from_agent_id: string; created_at: string; from_name: string | null; }

const directMessageSkill: SkillDefinition = {
  id: 'direct-message',
  description: '与其他 agent 收发消息',
  promptFragment(ctx: SkillPromptContext): string {
    const { agent, baseUrl: base, curl: C } = ctx;
    const db = getDatabase();

    const unreadMessages = db.prepare(
      `SELECT m.id, m.subject, m.body, m.from_agent_id, m.created_at, a.name as from_name
       FROM agent_messages m
       LEFT JOIN agents a ON a.id = m.from_agent_id
       WHERE m.to_agent_id = ? AND m.status = 'unread'
       ORDER BY m.created_at DESC LIMIT 5`
    ).all(agent.id) as UnreadMessageRow[];

    return `
## Direct Messages
${unreadMessages.length > 0
      ? `**Unread messages (${unreadMessages.length}):**\n` + unreadMessages.map(m =>
          `- From **${m.from_name || m.from_agent_id}**: ${m.subject ? `[${m.subject}] ` : ''}${m.body.slice(0, 200)}${m.body.length > 200 ? '...' : ''}`
        ).join('\n')
      : '(no unread messages)'}

**Send a message to another agent:**
\`\`\`bash
${C} -X POST ${base}/api/agents/${agent.id}/messages/send \\
  -H "Content-Type: application/json" \\
  -d '{"to":"TARGET_AGENT_ID","subject":"Subject","body":"Message content"}'
\`\`\`

**Check inbox:**
\`\`\`bash
${C} "${base}/api/agents/${agent.id}/messages?status=unread"
\`\`\`

**Mark message as read:**
\`\`\`bash
${C} -X PUT ${base}/api/agents/${agent.id}/messages/{message_id}
\`\`\``;
  },
};

export default directMessageSkill;
