import Database from 'better-sqlite3';

interface CountRow {
  count: number;
}

interface HighPriorityIssueRow {
  number: number;
  title: string;
  assigned_to: string | null;
  status: string;
}

interface AgentActivityRow {
  name: string;
  role: string;
  completed_issues: number;
}

export function buildGeneratedExecutiveSummaryContent(
  db: Database.Database,
  projectId: string,
  periodStart: string,
  periodEnd: string
): Record<string, string> {
  const issuesDone = db.prepare(
    `SELECT COUNT(*) as count FROM issues
     WHERE project_id = ? AND status IN ('done', 'closed')
     AND updated_at >= ? AND updated_at <= ?`
  ).get(projectId, periodStart, periodEnd) as CountRow;

  const issuesOpen = db.prepare(
    `SELECT COUNT(*) as count FROM issues
     WHERE project_id = ? AND status IN ('open', 'in_progress', 'pending')
     AND created_at <= ?`
  ).get(projectId, periodEnd) as CountRow;

  const issuesCreated = db.prepare(
    `SELECT COUNT(*) as count FROM issues
     WHERE project_id = ? AND created_at >= ? AND created_at <= ?`
  ).get(projectId, periodStart, periodEnd) as CountRow;

  const highPriorityOpen = db.prepare(
    `SELECT number, title, assigned_to, status FROM issues
     WHERE project_id = ? AND priority >= 3
     AND status IN ('open', 'in_progress', 'pending')
     AND created_at <= ?
     ORDER BY priority DESC LIMIT 5`
  ).all(projectId, periodEnd) as HighPriorityIssueRow[];

  const approvalsTotal = db.prepare(
    `SELECT COUNT(*) as count FROM approval_requests
     WHERE project_id = ? AND created_at >= ? AND created_at <= ?`
  ).get(projectId, periodStart, periodEnd) as CountRow;

  const approvalsApproved = db.prepare(
    `SELECT COUNT(*) as count FROM approval_requests
     WHERE project_id = ? AND status = 'approved'
     AND decided_at >= ? AND decided_at <= ?`
  ).get(projectId, periodStart, periodEnd) as CountRow;

  const approvalsRejected = db.prepare(
    `SELECT COUNT(*) as count FROM approval_requests
     WHERE project_id = ? AND status = 'rejected'
     AND decided_at >= ? AND decided_at <= ?`
  ).get(projectId, periodStart, periodEnd) as CountRow;

  const approvalsPending = db.prepare(
    `SELECT COUNT(*) as count FROM approval_requests
     WHERE project_id = ? AND status = 'pending'
     AND created_at <= ?`
  ).get(projectId, periodEnd) as CountRow;

  const agentActivity = db.prepare(
    `SELECT a.name, a.role,
            (SELECT COUNT(*) FROM issues i WHERE i.assigned_to = a.id AND i.status IN ('done', 'closed')
             AND i.updated_at >= ? AND i.updated_at <= ?) as completed_issues
     FROM agents a WHERE a.project_id = ?`
  ).all(periodStart, periodEnd, projectId) as AgentActivityRow[];

  return {
    cash_position: [
      `**Period**: ${periodStart} — ${periodEnd}`,
      '',
      '| Metric | Value |',
      '|--------|-------|',
      `| Issues resolved | ${issuesDone.count} |`,
      `| Issues created | ${issuesCreated.count} |`,
      `| Open items at period end | ${issuesOpen.count} |`,
      '',
      `Net issue throughput: ${issuesDone.count - issuesCreated.count >= 0 ? '+' : ''}${issuesDone.count - issuesCreated.count} (resolved minus created).`,
    ].join('\n'),

    payment_activity: [
      '**Approval Activity for Period**',
      '',
      '| Status | Count |',
      '|--------|-------|',
      `| Submitted | ${approvalsTotal.count} |`,
      `| Approved | ${approvalsApproved.count} |`,
      `| Rejected | ${approvalsRejected.count} |`,
      `| Pending | ${approvalsPending.count} |`,
      '',
      approvalsTotal.count > 0
        ? `Approval rate: ${((approvalsApproved.count / approvalsTotal.count) * 100).toFixed(1)}%.`
        : 'No approval requests submitted during this period.',
    ].join('\n'),

    liquidity_alerts: [
      '**High-Priority Open Items**',
      '',
      highPriorityOpen.length > 0
        ? highPriorityOpen.map((issue) =>
            `- **#${issue.number}** ${issue.title} — ${issue.status} (assigned: ${issue.assigned_to || 'unassigned'})`
          ).join('\n')
        : 'No high-priority items flagged during this period.',
    ].join('\n'),

    forecast_variance: [
      '**Agent Throughput**',
      '',
      '| Agent | Role | Resolved Issues |',
      '|-------|------|----------------|',
      ...agentActivity.map((agent) => `| ${agent.name} | ${agent.role} | ${agent.completed_issues} |`),
    ].join('\n'),

    risk_compliance: [
      `**Pending Approvals at Period End**: ${approvalsPending.count}`,
      '',
      approvalsPending.count > 0
        ? 'Review pending approvals to ensure timely processing and policy compliance.'
        : 'All approval requests have been resolved.',
      '',
      approvalsRejected.count > 0
        ? `**${approvalsRejected.count} rejection(s)** during period — review root causes.`
        : 'No rejections during this period.',
    ].join('\n'),

    action_items: [
      '**Carry-Forward Items**',
      '',
      `- Open issues at period end: ${issuesOpen.count}`,
      highPriorityOpen.length > 0
        ? `- High-priority items requiring attention: ${highPriorityOpen.length}`
        : '',
      approvalsPending.count > 0
        ? `- Pending approvals to resolve: ${approvalsPending.count}`
        : '',
      '',
      '**Next Steps**',
      '- Review high-priority items and assign owners',
      '- Clear pending approval backlog',
      '- Prepare forecast inputs for next period',
    ].filter(Boolean).join('\n'),
  };
}
