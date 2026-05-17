import Database from 'better-sqlite3';
import { buildSqlPlaceholders, buildTimeBucketKey, toFiniteNumber } from './utils';

export interface ParsedCostContent {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ProjectCostRun {
  run_id: string;
  agent_name: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  timestamp: string;
}

export interface LatestProjectCostRow {
  content: string;
  run_id: string;
  created_at: string;
  agent_name: string;
}

export interface LatestProjectSetCostRow {
  content: string;
  created_at: string;
  project_id: string;
  project_name: string;
}

export function parseCostContent(content: unknown): ParsedCostContent {
  try {
    const data = JSON.parse(String(content || '{}'));
    return {
      cost_usd: toFiniteNumber(data.cost_usd),
      input_tokens: toFiniteNumber(data.input_tokens),
      output_tokens: toFiniteNumber(data.output_tokens),
    };
  } catch {
    return { cost_usd: 0, input_tokens: 0, output_tokens: 0 };
  }
}

export function sumCostRows(rows: Array<{ content: string }>): ParsedCostContent {
  return rows.reduce<ParsedCostContent>((acc, row) => {
    const parsed = parseCostContent(row.content);
    acc.cost_usd += parsed.cost_usd;
    acc.input_tokens += parsed.input_tokens;
    acc.output_tokens += parsed.output_tokens;
    return acc;
  }, { cost_usd: 0, input_tokens: 0, output_tokens: 0 });
}

export function listLatestProjectCostRows(db: Database.Database, projectId: string): LatestProjectCostRow[] {
  return db.prepare(
    `SELECT c.content, c.run_id, c.created_at, a.name as agent_name
     FROM conversation_logs c
     INNER JOIN (
       SELECT MAX(cl.id) as max_id
       FROM conversation_logs cl
       JOIN agents al ON cl.agent_id = al.id
       WHERE al.project_id = ? AND cl.stream = 'cost'
       GROUP BY cl.run_id
     ) latest ON c.id = latest.max_id
     JOIN agents a ON c.agent_id = a.id
     ORDER BY c.created_at`
  ).all(projectId) as LatestProjectCostRow[];
}

export function listLatestProjectSetCostRows(
  db: Database.Database,
  projectIds: string[],
  sinceCreatedAt?: string
): LatestProjectSetCostRow[] {
  if (projectIds.length === 0) return [];
  const placeholders = buildSqlPlaceholders(projectIds);
  const sinceClause = sinceCreatedAt ? ' AND cl.created_at >= ?' : '';
  const params: unknown[] = sinceCreatedAt ? [...projectIds, sinceCreatedAt] : projectIds;

  return db.prepare(
    `SELECT c.content, c.created_at, p.id as project_id, p.name as project_name
     FROM conversation_logs c
     INNER JOIN (
       SELECT MAX(cl.id) as max_id
       FROM conversation_logs cl
       JOIN agents a2 ON cl.agent_id = a2.id
       WHERE cl.stream = 'cost' AND a2.project_id IN (${placeholders})${sinceClause}
       GROUP BY cl.run_id
     ) latest ON c.id = latest.max_id
     JOIN agents a ON c.agent_id = a.id
     JOIN projects p ON a.project_id = p.id`
  ).all(...params) as LatestProjectSetCostRow[];
}

export function getProjectCosts(
  db: Database.Database,
  projectId: string,
  period?: string
): any {
  const costs = listLatestProjectCostRows(db, projectId);

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  const byAgent: Record<string, { cost: number; runs: number; input_tokens: number; output_tokens: number }> = {};
  const runs: ProjectCostRun[] = [];
  const timeSeries: Record<string, { cost: number; runs: number }> = {};
  const timeSeriesByAgent: Record<string, Record<string, { cost: number; runs: number }>> = {};

  for (const row of costs) {
    const data = parseCostContent(row.content);
    totalCost += data.cost_usd;
    totalInput += data.input_tokens;
    totalOutput += data.output_tokens;

    if (!byAgent[row.agent_name]) {
      byAgent[row.agent_name] = { cost: 0, runs: 0, input_tokens: 0, output_tokens: 0 };
    }
    byAgent[row.agent_name].cost += data.cost_usd;
    byAgent[row.agent_name].runs += 1;
    byAgent[row.agent_name].input_tokens += data.input_tokens;
    byAgent[row.agent_name].output_tokens += data.output_tokens;

    runs.push({
      run_id: row.run_id,
      agent_name: row.agent_name,
      cost_usd: data.cost_usd,
      input_tokens: data.input_tokens,
      output_tokens: data.output_tokens,
      timestamp: row.created_at,
    });

    if (period && row.created_at) {
      const key = buildTimeBucketKey(row.created_at, period);
      if (!timeSeries[key]) timeSeries[key] = { cost: 0, runs: 0 };
      timeSeries[key].cost += data.cost_usd;
      timeSeries[key].runs += 1;

      if (!timeSeriesByAgent[row.agent_name]) timeSeriesByAgent[row.agent_name] = {};
      if (!timeSeriesByAgent[row.agent_name][key]) timeSeriesByAgent[row.agent_name][key] = { cost: 0, runs: 0 };
      timeSeriesByAgent[row.agent_name][key].cost += data.cost_usd;
      timeSeriesByAgent[row.agent_name][key].runs += 1;
    }
  }

  const result: any = {
    total_cost_usd: totalCost,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    by_agent: byAgent,
    runs,
  };

  if (period) {
    result.time_series = Object.entries(timeSeries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period_start, data]) => ({ period_start, ...data }));

    result.time_series_by_agent = Object.fromEntries(
      Object.entries(timeSeriesByAgent).map(([agent, series]) => [
        agent,
        Object.entries(series)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([period_start, data]) => ({ period_start, ...data })),
      ])
    );
  }

  return result;
}
