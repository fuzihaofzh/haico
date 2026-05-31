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
      '**Issue Resolution Activity**',
      '',
      '| Metric | Count |',
      '|--------|-------|',
      `| Created | ${issuesCreated.count} |`,
      `| Resolved | ${issuesDone.count} |`,
      `| Still open | ${issuesOpen.count} |`,
      '',
      issuesCreated.count > 0
        ? `Resolution rate: ${((issuesDone.count / issuesCreated.count) * 100).toFixed(1)}%.`
        : 'No issues created during this period.',
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
      `**Open Issues at Period End**: ${issuesOpen.count}`,
      '',
      highPriorityOpen.length > 0
        ? `${highPriorityOpen.length} high-priority item(s) require attention.`
        : 'No high-priority items pending.',
    ].join('\n'),

    action_items: [
      '**Carry-Forward Items**',
      '',
      `- Open issues at period end: ${issuesOpen.count}`,
      highPriorityOpen.length > 0
        ? `- High-priority items requiring attention: ${highPriorityOpen.length}`
        : '',
      '',
      '**Next Steps**',
      '- Review high-priority items and assign owners',
      '- Prepare forecast inputs for next period',
    ].filter(Boolean).join('\n'),
  };
}
