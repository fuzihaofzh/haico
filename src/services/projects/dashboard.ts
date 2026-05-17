import Database from 'better-sqlite3';
import { fetchRemoteProjectAgents, fetchRemoteProjects, loadRemoteInstances, RemoteInstanceRecord } from '../remote-instances';
import { listAccessibleProjectIds, ProjectRequestContext } from '../project-access';
import { listLatestProjectSetCostRows, parseCostContent, sumCostRows } from './costs';
import { buildSqlPlaceholders, buildTimeBucketKey, parseBoundedLimit, toFiniteNumber } from './utils';

interface RemoteDashboardProjectRef {
  instance: RemoteInstanceRecord;
  project: {
    id: string;
    remote_project_id: string;
    name: string;
    updated_at: string;
    stats?: Record<string, unknown>;
  };
}

async function loadAccessibleRemoteProjects(
  db: Database.Database
): Promise<RemoteDashboardProjectRef[]> {
  const instances = loadRemoteInstances(db).filter((instance) => instance.enabled);
  if (instances.length === 0) return [];

  const settled = await Promise.allSettled(
    instances.map(async (instance) => ({
      instance,
      result: await fetchRemoteProjects(instance),
    }))
  );

  return settled.flatMap((entry) => {
    if (entry.status !== 'fulfilled') return [];
    const { instance, result } = entry.value;
    return (result.projects || []).map((project) => ({ instance, project }));
  });
}

async function loadRemoteDashboardAgents(
  remoteProjects: RemoteDashboardProjectRef[],
  statusFilter?: string
): Promise<any[]> {
  if (remoteProjects.length === 0) return [];

  const settled = await Promise.allSettled(
    remoteProjects.map(async ({ instance, project }) => ({
      instance,
      project,
      result: await fetchRemoteProjectAgents(instance, project.remote_project_id),
    }))
  );

  return settled.flatMap((entry) => {
    if (entry.status !== 'fulfilled') return [];
    const { instance, project, result } = entry.value;
    if (!result.ok || !Array.isArray(result.data)) return [];

    return result.data
      .filter((agent: any) => !statusFilter || agent?.status === statusFilter)
      .map((agent: any) => ({
        id: `remote-agent:${instance.id}:${String(agent?.id || '')}`,
        remote_agent_id: String(agent?.id || ''),
        remote_instance_id: instance.id,
        remote_instance_name: instance.name,
        is_remote: true,
        name: String(agent?.name || ''),
        role: String(agent?.role || ''),
        status: String(agent?.status || 'idle'),
        is_controller: Boolean(agent?.is_controller),
        started_at: agent?.started_at || null,
        finished_at: agent?.finished_at || null,
        paused: Boolean(agent?.paused),
        project_id: String(project.id || `remote:${instance.id}:${project.remote_project_id}`),
        project_name: String(project.name || instance.name),
        current_issue: null,
      }));
  });
}

export async function getDashboardSummary(
  db: Database.Database,
  context: ProjectRequestContext
): Promise<any> {
  const projectIds = listAccessibleProjectIds(db, context.user, context.localhostBypass);
  const remoteProjects = await loadAccessibleRemoteProjects(db);

  let localAgentStats = { total: 0, running: 0, error_count: 0 };
  let localIssueStats = { total: 0, open_count: 0 };
  let pendingApprovalCount = 0;
  const lastActivityMap: Record<string, string | null> = {};

  if (projectIds.length > 0) {
    const placeholders = buildSqlPlaceholders(projectIds);

    const agentStats = db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count
       FROM agents
       WHERE project_id IN (${placeholders})`
    ).get(...projectIds) as any;
    localAgentStats = {
      total: agentStats?.total || 0,
      running: agentStats?.running || 0,
      error_count: agentStats?.error_count || 0,
    };

    const issueStats = db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status IN ('open', 'in_progress') THEN 1 ELSE 0 END) as open_count
       FROM issues
       WHERE project_id IN (${placeholders})`
    ).get(...projectIds) as any;
    localIssueStats = {
      total: issueStats?.total || 0,
      open_count: issueStats?.open_count || 0,
    };

    const projectActivity = db.prepare(
      `SELECT p.id,
              MAX(COALESCE(a.started_at, a.finished_at)) as last_agent_activity,
              MAX(i.updated_at) as last_issue_activity
       FROM projects p
       LEFT JOIN agents a ON a.project_id = p.id
       LEFT JOIN issues i ON i.project_id = p.id
       WHERE p.id IN (${placeholders})
       GROUP BY p.id`
    ).all(...projectIds) as any[];

    for (const row of projectActivity) {
      const times = [row.last_agent_activity, row.last_issue_activity].filter(Boolean);
      lastActivityMap[row.id] = times.length ? times.sort().pop()! : null;
    }

    const approvalCount = db.prepare(
      `SELECT COUNT(*) as count FROM approval_requests WHERE project_id IN (${placeholders}) AND status = 'pending'`
    ).get(...projectIds) as any;
    pendingApprovalCount = approvalCount?.count || 0;
  }

  const localCostTotals = sumCostRows(listLatestProjectSetCostRows(db, projectIds));
  const remoteAgentStats = remoteProjects.reduce((acc, { project }) => {
    const stats = project?.stats && typeof project.stats === 'object' ? project.stats : {};
    acc.total += toFiniteNumber((stats as any).agents);
    acc.running += toFiniteNumber((stats as any).running);
    acc.error_count += toFiniteNumber((stats as any).agentError);
    if (project?.id) {
      lastActivityMap[project.id] = project.updated_at || null;
    }
    return acc;
  }, { total: 0, running: 0, error_count: 0 });

  return {
    agents: {
      total: localAgentStats.total + remoteAgentStats.total,
      running: localAgentStats.running + remoteAgentStats.running,
      error_count: localAgentStats.error_count + remoteAgentStats.error_count,
    },
    issues: { total: localIssueStats.total, open: localIssueStats.open_count },
    pending_approvals: pendingApprovalCount,
    total_cost_usd: localCostTotals.cost_usd,
    total_input_tokens: localCostTotals.input_tokens,
    total_output_tokens: localCostTotals.output_tokens,
    last_activity: lastActivityMap,
  };
}

export function getUsageByProject(
  db: Database.Database,
  context: ProjectRequestContext,
  periodInput?: string
): any {
  const period = periodInput || 'day';
  const projectIds = listAccessibleProjectIds(db, context.user, context.localhostBypass);

  if (projectIds.length === 0) {
    return { period, time_buckets: [], projects: [], data: {} };
  }

  const rows = listLatestProjectSetCostRows(db, projectIds);
  const buckets: Record<string, Record<string, { cost: number; input_tokens: number; output_tokens: number }>> = {};
  const projectNames: Record<string, string> = {};

  for (const row of rows) {
    if (!row.created_at) continue;
    const data = parseCostContent(row.content);
    const key = buildTimeBucketKey(row.created_at, period);

    projectNames[row.project_id] = row.project_name;
    if (!buckets[key]) buckets[key] = {};
    if (!buckets[key][row.project_id]) buckets[key][row.project_id] = { cost: 0, input_tokens: 0, output_tokens: 0 };
    buckets[key][row.project_id].cost += data.cost_usd;
    buckets[key][row.project_id].input_tokens += data.input_tokens;
    buckets[key][row.project_id].output_tokens += data.output_tokens;
  }

  const timeBuckets = Object.keys(buckets).sort();
  const projects = Object.entries(projectNames).map(([id, name]) => ({ id, name }));

  return {
    period,
    time_buckets: timeBuckets,
    projects,
    data: Object.fromEntries(timeBuckets.map((bucket) => [bucket, buckets[bucket]])),
  };
}

export function getDashboardActivityStream(
  db: Database.Database,
  context: ProjectRequestContext,
  input: { limit?: string; project_id?: string } = {}
): any[] {
  const projectIds = listAccessibleProjectIds(db, context.user, context.localhostBypass);
  const limit = parseBoundedLimit(input.limit, 50, 200);
  const filterProjectId = input.project_id;

  if (projectIds.length === 0) return [];

  const ids = filterProjectId && projectIds.includes(filterProjectId) ? [filterProjectId] : projectIds;
  const placeholders = buildSqlPlaceholders(ids);

  return db.prepare(`
    SELECT * FROM (
      SELECT 'issue_created' as event_type, i.id as object_id, i.number, i.title, i.status,
             i.created_by as actor, i.created_at as time, p.id as project_id, p.name as project_name,
             NULL as body, NULL as issue_number, NULL as issue_title, NULL as issue_id,
             NULL as agent_name, NULL as agent_status, NULL as approval_status, NULL as risk_level
      FROM issues i JOIN projects p ON i.project_id = p.id
      WHERE i.project_id IN (${placeholders})
      ORDER BY i.created_at DESC LIMIT ?
    )
    UNION ALL SELECT * FROM (
      SELECT 'issue_status_change', i.id, i.number, i.title, i.status,
             NULL, i.updated_at, p.id, p.name,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM issues i JOIN projects p ON i.project_id = p.id
      WHERE i.project_id IN (${placeholders}) AND i.updated_at != i.created_at
      ORDER BY i.updated_at DESC LIMIT ?
    )
    UNION ALL SELECT * FROM (
      SELECT 'comment', c.id, NULL, NULL, NULL,
             c.author_id, c.created_at, p.id, p.name,
             c.body, i.number, i.title, i.id, NULL, NULL, NULL, NULL
      FROM issue_comments c JOIN issues i ON c.issue_id = i.id JOIN projects p ON i.project_id = p.id
      WHERE i.project_id IN (${placeholders})
      ORDER BY c.created_at DESC LIMIT ?
    )
    UNION ALL SELECT * FROM (
      SELECT CASE WHEN a.status = 'running' THEN 'agent_started' ELSE 'agent_stopped' END,
             a.id, NULL, NULL, NULL,
             NULL, COALESCE(a.started_at, a.finished_at), p.id, p.name,
             NULL, NULL, NULL, NULL, a.name, a.status, NULL, NULL
      FROM agents a JOIN projects p ON a.project_id = p.id
      WHERE a.project_id IN (${placeholders}) AND (a.started_at IS NOT NULL OR a.finished_at IS NOT NULL)
      ORDER BY COALESCE(a.started_at, a.finished_at) DESC LIMIT ?
    )
    UNION ALL SELECT * FROM (
      SELECT CASE WHEN ar.status = 'pending' THEN 'approval_created' ELSE 'approval_decided' END,
             ar.id, NULL, ar.title, NULL,
             NULL, COALESCE(ar.decided_at, ar.created_at), p.id, p.name,
             NULL, NULL, NULL, NULL, ag.name, NULL, ar.status, ar.risk_level
      FROM approval_requests ar
      JOIN projects p ON ar.project_id = p.id
      JOIN agents ag ON ar.agent_id = ag.id
      WHERE ar.project_id IN (${placeholders})
      ORDER BY COALESCE(ar.decided_at, ar.created_at) DESC LIMIT ?
    )
    ORDER BY time DESC LIMIT ?
  `).all(...ids, limit, ...ids, limit, ...ids, limit, ...ids, limit, ...ids, limit, limit) as any[];
}

export async function listDashboardAgents(
  db: Database.Database,
  context: ProjectRequestContext,
  statusFilter?: string
): Promise<any[]> {
  const projectIds = listAccessibleProjectIds(db, context.user, context.localhostBypass);
  let agents: any[] = [];

  if (projectIds.length > 0) {
    const placeholders = buildSqlPlaceholders(projectIds);
    let query = `SELECT a.id, a.name, a.role, a.status, a.is_controller, a.started_at, a.finished_at, a.paused,
                        p.id as project_id, p.name as project_name
                 FROM agents a JOIN projects p ON a.project_id = p.id
                 WHERE a.project_id IN (${placeholders})`;
    const params: any[] = [...projectIds];

    if (statusFilter) {
      query += ' AND a.status = ?';
      params.push(statusFilter);
    }

    query += " ORDER BY CASE a.status WHEN 'running' THEN 0 WHEN 'error' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END, a.name";
    agents = db.prepare(query).all(...params) as any[];

    const agentIds = agents.map((agent) => agent.id);
    if (agentIds.length > 0) {
      const issueMap: Record<string, any> = {};
      const issuePlaceholders = buildSqlPlaceholders(agentIds);
      const currentIssues = db.prepare(
        `SELECT assigned_to, number, title FROM issues
         WHERE assigned_to IN (${issuePlaceholders}) AND status = 'in_progress'
         ORDER BY updated_at DESC`
      ).all(...agentIds) as any[];
      for (const issue of currentIssues) {
        if (!issueMap[issue.assigned_to]) {
          issueMap[issue.assigned_to] = { number: issue.number, title: issue.title };
        }
      }
      for (const agent of agents) {
        agent.current_issue = issueMap[agent.id] || null;
      }
    }
  }

  const remoteProjects = await loadAccessibleRemoteProjects(db);
  const remoteAgents = await loadRemoteDashboardAgents(remoteProjects, statusFilter);
  const allAgents = agents.concat(remoteAgents);
  allAgents.sort((a: any, b: any) => {
    const rank = (value: string) => {
      if (value === 'running') return 0;
      if (value === 'error') return 1;
      if (value === 'waiting') return 2;
      return 3;
    };
    const rankDelta = rank(String(a?.status || '')) - rank(String(b?.status || ''));
    if (rankDelta !== 0) return rankDelta;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });

  return allAgents;
}

export function getTodayCost(db: Database.Database, context: ProjectRequestContext): any {
  const projectIds = listAccessibleProjectIds(db, context.user, context.localhostBypass);
  if (projectIds.length === 0) return { today_cost_usd: 0, by_project: {} };

  const today = new Date().toISOString().slice(0, 10);
  const rows = listLatestProjectSetCostRows(db, projectIds, `${today} 00:00:00`);
  let todayCost = 0;
  const byProject: Record<string, { name: string; cost: number }> = {};

  for (const row of rows) {
    const data = parseCostContent(row.content);
    todayCost += data.cost_usd;
    if (!byProject[row.project_id]) byProject[row.project_id] = { name: row.project_name, cost: 0 };
    byProject[row.project_id].cost += data.cost_usd;
  }

  return { today_cost_usd: todayCost, by_project: byProject };
}
