import { getDatabase } from '../../db/database';
import { AgentRunNotFoundError } from './errors';
import { TOOL_CALL_REPORT_CHAR_LIMIT } from './policy';
import { getAgentOrThrow } from './core';
import { getAgentRuntimeState } from '../tasks';

function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

export function getAgentTerminalText(agentId: string, limitValue?: string): string {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);
  const limit = Number.parseInt(limitValue || '200', 10);
  const logs = db.prepare(
    'SELECT * FROM conversation_logs WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
  ).all(agentId, limit) as any[];
  logs.reverse();

  const runtimeState = getAgentRuntimeState(agent.id);
  let text = `=== ${agent.name} [${runtimeState.status}] ===\n\n`;
  for (const log of logs) {
    if (log.stream === 'stdin') {
      text += `--- Input Prompt (${log.content.length} chars) ---\n`;
      text += `${log.content.replace(/\n/g, ' ').slice(0, 100)}...\n`;
      text += '--- Output ---\n';
    } else if (log.stream === 'stderr') {
      text += `[ERR] ${log.content}`;
    } else {
      text += log.content;
    }
  }
  return text;
}

export function getAgentLogs(
  agentId: string,
  query: { limit?: string; since_id?: string; after_id?: string; after?: string }
): any[] {
  const db = getDatabase();
  const limit = parseBoundedInt(query.limit, 100, 1, 1000);
  const sinceId = parseBoundedInt(query.since_id || query.after_id || query.after, 0, 0, Number.MAX_SAFE_INTEGER);
  if (sinceId > 0) {
    return db.prepare(
      'SELECT * FROM conversation_logs WHERE agent_id = ? AND id > ? ORDER BY id ASC LIMIT ?'
    ).all(agentId, sinceId, limit);
  }
  return db.prepare(
    'SELECT * FROM conversation_logs WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
  ).all(agentId, limit);
}

export function getAgentCosts(agentId: string): any {
  const db = getDatabase();
  getAgentOrThrow(db, agentId);

  const costs = db.prepare(
    `SELECT c.content, c.run_id, c.created_at FROM conversation_logs c
     INNER JOIN (SELECT MAX(id) as max_id FROM conversation_logs WHERE agent_id = ? AND stream = 'cost' GROUP BY run_id) latest
     ON c.id = latest.max_id ORDER BY c.created_at`
  ).all(agentId) as any[];

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  const runs: Array<{ run_id: string; cost_usd: number; input_tokens: number; output_tokens: number; timestamp: string }> = [];

  for (const cost of costs) {
    try {
      const data = JSON.parse(cost.content);
      const costUsd = data.cost_usd || 0;
      const inputTokens = data.input_tokens || 0;
      const outputTokens = data.output_tokens || 0;
      totalCost += costUsd;
      totalInput += inputTokens;
      totalOutput += outputTokens;
      runs.push({ run_id: cost.run_id, cost_usd: costUsd, input_tokens: inputTokens, output_tokens: outputTokens, timestamp: cost.created_at });
    } catch {}
  }

  return {
    total_cost_usd: totalCost,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_runs: runs.length,
    runs,
  };
}

export function getAgentRunLogs(agentId: string, runId: string): any[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM conversation_logs WHERE agent_id = ? AND run_id = ? ORDER BY id'
  ).all(agentId, runId);
}

export function listAgentRuns(agentId: string, limitValue?: string): any {
  const db = getDatabase();
  getAgentOrThrow(db, agentId);

  const limit = Math.min(Number.parseInt(limitValue || '20', 10), 100);
  const runs = db.prepare(`
    SELECT run_id,
      MIN(created_at) as started_at,
      MAX(created_at) as finished_at
    FROM conversation_logs
    WHERE agent_id = ?
    GROUP BY run_id
    ORDER BY MIN(id) DESC
    LIMIT ?
  `).all(agentId, limit) as any[];

  const result = runs.map((run) => {
    const costLog = db.prepare(
      "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'cost' ORDER BY id DESC LIMIT 1"
    ).get(agentId, run.run_id) as { content: string } | undefined;

    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let durationMs = 0;
    if (costLog) {
      try {
        const data = JSON.parse(costLog.content);
        costUsd = data.cost_usd || 0;
        inputTokens = data.input_tokens || 0;
        outputTokens = data.output_tokens || 0;
        durationMs = data.duration_ms || 0;
      } catch {}
    }

    const toolCount = db.prepare(
      "SELECT COUNT(*) as c FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stdout' AND content LIKE '[Tool:%'"
    ).get(agentId, run.run_id) as { c: number };

    const hasError = db.prepare(
      "SELECT COUNT(*) as c FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stderr' AND content != ''"
    ).get(agentId, run.run_id) as { c: number };

    const finalResult = db.prepare(
      "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stdout' AND content LIKE '%--- Final Result ---%' LIMIT 1"
    ).get(agentId, run.run_id) as { content: string } | undefined;

    const resultSnippet = finalResult?.content?.replace('--- Final Result ---', '').trim().slice(0, 200) || '';

    return {
      run_id: run.run_id,
      started_at: run.started_at,
      finished_at: run.finished_at,
      status: hasError.c > 0 ? 'error' : 'success',
      cost_usd: costUsd,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms: durationMs,
      tool_call_count: toolCount.c,
      result_snippet: resultSnippet,
    };
  });

  return { runs: result };
}

export function listAgentTaskRuns(
  agentId: string,
  query: { limit?: string; offset?: string } = {}
): any {
  const db = getDatabase();
  getAgentOrThrow(db, agentId);

  const limit = parseBoundedInt(query.limit, 20, 1, 100);
  const offset = parseBoundedInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const rows = db.prepare(`
    SELECT
      tr.id AS task_run_id,
      tr.task_id,
      tr.project_id,
      tr.agent_id,
      tr.executor_profile_id,
      tr.run_id,
      tr.attempt,
      tr.status AS task_run_status,
      tr.pid,
      tr.session_id,
      tr.command_snapshot,
      tr.exit_code,
      tr.failure_kind AS task_run_failure_kind,
      tr.failure_message AS task_run_failure_message,
      tr.started_at AS task_run_started_at,
      tr.finished_at AS task_run_finished_at,
      tr.created_at AS task_run_created_at,
      t.source,
      t.source_ref,
      t.task_type,
      t.reason,
      t.priority,
      t.status AS task_status,
      t.failure_kind AS task_failure_kind,
      t.failure_message AS task_failure_message,
      t.created_at AS task_created_at,
      t.updated_at AS task_updated_at,
      substr(t.prompt, 1, 400) AS prompt_preview
    FROM task_runs tr
    JOIN tasks t ON t.id = tr.task_id
    WHERE tr.agent_id = ?
    ORDER BY tr.created_at DESC
    LIMIT ? OFFSET ?
  `).all(agentId, limit, offset) as any[];

  const total = db.prepare(
    'SELECT COUNT(*) AS count FROM task_runs WHERE agent_id = ?'
  ).get(agentId) as { count: number };

  return {
    task_runs: rows,
    limit,
    offset,
    total: total.count,
  };
}

export function getAgentRunReport(agentId: string, runId: string): any {
  const db = getDatabase();
  const agent = getAgentOrThrow(db, agentId);
  const logs = db.prepare(
    'SELECT * FROM conversation_logs WHERE agent_id = ? AND run_id = ? ORDER BY id'
  ).all(agentId, runId) as any[];

  if (!logs.length) throw new AgentRunNotFoundError();

  const toolCalls: Array<{ name: string; input: string; result: string; index: number }> = [];
  const textBlocks: string[] = [];
  const filesChanged = new Set<string>();
  let costData: any = null;
  let finalResult = '';
  let hasError = false;
  let errorMsg = '';

  for (let i = 0; i < logs.length; i += 1) {
    const log = logs[i];

    if (log.stream === 'cost') {
      try { costData = JSON.parse(log.content); } catch {}
      continue;
    }

    if (log.stream === 'stderr' && log.content.trim()) {
      hasError = true;
      errorMsg += log.content;
      continue;
    }

    if (log.stream === 'stdin') continue;

    const content = log.content || '';
    const toolMatch = content.match(/^\[Tool: (\w+)\] (.*)$/s);
    if (toolMatch) {
      const toolName = toolMatch[1];
      const toolInput = toolMatch[2].trim();

      try {
        const inputObj = JSON.parse(toolInput);
        if (inputObj.file_path) filesChanged.add(inputObj.file_path);
        if (inputObj.path) filesChanged.add(inputObj.path);
      } catch {
        const pathMatch = toolInput.match(/"(?:file_path|path)"\s*:\s*"([^"]+)"/);
        if (pathMatch) filesChanged.add(pathMatch[1]);
      }

      toolCalls.push({ name: toolName, input: toolInput.slice(0, TOOL_CALL_REPORT_CHAR_LIMIT), result: '', index: i });
      continue;
    }

    const resultMatch = content.match(/^\[Result\] (.*)$/s);
    if (resultMatch && toolCalls.length > 0) {
      toolCalls[toolCalls.length - 1].result = resultMatch[1].slice(0, 500);
      continue;
    }

    if (content.includes('--- Final Result ---')) {
      finalResult = content.replace(/.*--- Final Result ---\n?/, '').trim();
      continue;
    }

    if (content.includes('--- Cost:')) continue;

    if (content.trim()) {
      textBlocks.push(content.trim());
    }
  }

  const startedAt = logs[0]?.created_at;
  const finishedAt = logs[logs.length - 1]?.created_at;
  const toolFreq: Record<string, number> = {};
  for (const toolCall of toolCalls) {
    toolFreq[toolCall.name] = (toolFreq[toolCall.name] || 0) + 1;
  }

  return {
    run_id: runId,
    agent_id: agentId,
    agent_name: agent.name,
    started_at: startedAt,
    finished_at: finishedAt,
    status: hasError ? 'error' : 'success',
    error_message: errorMsg.slice(0, 1000) || null,
    cost: costData ? {
      total_usd: costData.cost_usd,
      input_tokens: costData.input_tokens,
      output_tokens: costData.output_tokens,
      cache_read: costData.cache_read,
      duration_ms: costData.duration_ms,
    } : null,
    summary: {
      total_tool_calls: toolCalls.length,
      tool_frequency: toolFreq,
      files_changed: Array.from(filesChanged),
      text_output_length: textBlocks.join('').length,
    },
    final_result: finalResult.slice(0, 2000) || null,
    tool_calls: toolCalls.map((toolCall) => ({
      name: toolCall.name,
      input: toolCall.input,
      result: toolCall.result,
    })),
    key_decisions: textBlocks.slice(0, 20).map((text) => text.slice(0, 300)),
  };
}
