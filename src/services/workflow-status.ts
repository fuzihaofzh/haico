import Database from 'better-sqlite3';

export interface ProjectWorkflowStatus {
  agents: any[];
  recent_messages: any[];
  pending_approvals: any[];
  total_active_issues: number;
}

export function getProjectWorkflowStatus(
  db: Database.Database,
  projectId: string
): ProjectWorkflowStatus {
  const agents = db.prepare(
    `SELECT id, name, role, is_controller, parent_agent_id, status, paused, started_at, finished_at
     FROM agents WHERE project_id = ?`
  ).all(projectId) as any[];

  const agentIds = agents.map((agent: any) => agent.id);

  const activeIssues = agentIds.length > 0
    ? db.prepare(
        `SELECT id, number, title, status, assigned_to, priority, labels
         FROM issues WHERE project_id = ? AND status IN ('open', 'in_progress', 'pending')
         ORDER BY priority DESC`
      ).all(projectId) as any[]
    : [];

  const recentMessages = db.prepare(
    `SELECT from_agent_id, to_agent_id, subject, created_at
     FROM agent_messages WHERE project_id = ?
     ORDER BY created_at DESC LIMIT 20`
  ).all(projectId) as any[];

  const pendingApprovals = db.prepare(
    `SELECT ar.id, ar.title, ar.risk_level, ar.agent_id, ar.created_at, a.name as agent_name
     FROM approval_requests ar
     LEFT JOIN agents a ON ar.agent_id = a.id
     WHERE ar.project_id = ? AND ar.status = 'pending'
     ORDER BY ar.created_at DESC`
  ).all(projectId) as any[];

  const issuesByAgent: Record<string, any[]> = {};
  for (const issue of activeIssues) {
    const agentId = issue.assigned_to;
    if (!agentId) continue;
    if (!issuesByAgent[agentId]) issuesByAgent[agentId] = [];
    issuesByAgent[agentId].push(issue);
  }

  return {
    agents: agents.map((agent: any) => ({
      ...agent,
      current_issues: issuesByAgent[agent.id] || [],
    })),
    recent_messages: recentMessages,
    pending_approvals: pendingApprovals,
    total_active_issues: activeIssues.length,
  };
}
