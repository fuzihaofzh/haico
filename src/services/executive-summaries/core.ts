import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { eventBus } from '../../events';
import { ExecutiveSummary, ExecutiveSummaryBlock } from '../../types';
import {
  DuplicateExecutiveSummaryBlockKeyError,
  ExecutiveSummaryAlreadyFinalizedError,
  ExecutiveSummaryArchivedFinalizeError,
  ExecutiveSummaryBlockNotFoundError,
  ExecutiveSummaryNotFoundError,
  InvalidExecutiveSummaryStatusError,
  MissingExecutiveSummaryBlockCreateFieldsError,
  MissingExecutiveSummaryCreateFieldsError,
  NoValidExecutiveSummaryUpdateFieldsError,
} from './errors';
import { buildGeneratedExecutiveSummaryContent } from './generation';
import { DEFAULT_BLOCK_TEMPLATES, isExecutiveSummaryStatus } from './templates';

interface SummaryRow {
  id: string;
  project_id: string;
  title: string;
  period_start: string;
  period_end: string;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface BlockRow {
  id: string;
  summary_id: string;
  block_key: string;
  title: string;
  content: string;
  order_index: number;
}

export interface ListExecutiveSummariesFilters {
  status?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export interface ListExecutiveSummariesResult {
  summaries: ExecutiveSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateExecutiveSummaryInput {
  title?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  created_by?: unknown;
}

export interface UpdateExecutiveSummaryInput {
  title?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  status?: unknown;
}

export interface CreateExecutiveSummaryBlockInput {
  key?: unknown;
  title?: unknown;
  content?: unknown;
}

export interface UpdateExecutiveSummaryBlockInput {
  title?: unknown;
  content?: unknown;
  order_index?: unknown;
}

function normalizeListLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value || '20'), 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(parsed, 100);
}

function normalizeListOffset(value: unknown): number {
  const parsed = Number.parseInt(String(value || '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeOptionalText(value: unknown): string {
  return String(value || '');
}

function serializeBlock(row: BlockRow): ExecutiveSummaryBlock {
  return {
    id: row.id,
    key: row.block_key,
    title: row.title,
    content: row.content,
    order_index: row.order_index,
  };
}

function attachBlocks(db: Database.Database, summaryId: string): ExecutiveSummaryBlock[] {
  const rows = db.prepare(
    `SELECT id, summary_id, block_key, title, content, order_index
     FROM executive_summary_blocks
     WHERE summary_id = ?
     ORDER BY order_index`
  ).all(summaryId) as BlockRow[];

  return rows.map(serializeBlock);
}

function serializeSummary(db: Database.Database, row: SummaryRow): ExecutiveSummary {
  return {
    ...row,
    status: row.status as ExecutiveSummary['status'],
    blocks: attachBlocks(db, row.id),
  };
}

function getSummaryRowOrThrow(
  db: Database.Database,
  projectId: string,
  summaryId: string
): SummaryRow {
  const row = db.prepare(
    'SELECT * FROM executive_summaries WHERE id = ? AND project_id = ?'
  ).get(summaryId, projectId) as SummaryRow | undefined;
  if (!row) throw new ExecutiveSummaryNotFoundError();
  return row;
}

function getBlockRowOrThrow(
  db: Database.Database,
  summaryId: string,
  blockId: string
): BlockRow {
  const row = db.prepare(
    'SELECT * FROM executive_summary_blocks WHERE id = ? AND summary_id = ?'
  ).get(blockId, summaryId) as BlockRow | undefined;
  if (!row) throw new ExecutiveSummaryBlockNotFoundError();
  return row;
}

function assertBlockKeyAvailable(
  db: Database.Database,
  summaryId: string,
  key: unknown
): void {
  const existing = db.prepare(
    'SELECT id FROM executive_summary_blocks WHERE summary_id = ? AND block_key = ?'
  ).get(summaryId, key) as { id: string } | undefined;
  if (existing) throw new DuplicateExecutiveSummaryBlockKeyError();
}

export function listExecutiveSummaries(
  db: Database.Database,
  projectId: string,
  filters: ListExecutiveSummariesFilters = {}
): ListExecutiveSummariesResult {
  const status = filters.status;
  const limit = normalizeListLimit(filters.limit);
  const offset = normalizeListOffset(filters.offset);

  const rows = status
    ? db.prepare(
        `SELECT * FROM executive_summaries
         WHERE project_id = ? AND status = ?
         ORDER BY period_end DESC, created_at DESC
         LIMIT ? OFFSET ?`
      ).all(projectId, status, limit, offset)
    : db.prepare(
        `SELECT * FROM executive_summaries
         WHERE project_id = ?
         ORDER BY period_end DESC, created_at DESC
         LIMIT ? OFFSET ?`
      ).all(projectId, limit, offset);

  const total = (status
    ? db.prepare(
        `SELECT COUNT(*) as count FROM executive_summaries
         WHERE project_id = ? AND status = ?`
      ).get(projectId, status)
    : db.prepare(
        `SELECT COUNT(*) as count FROM executive_summaries
         WHERE project_id = ?`
      ).get(projectId)) as { count: number };

  return {
    summaries: (rows as SummaryRow[]).map((row) => serializeSummary(db, row)),
    total: total.count,
    limit,
    offset,
  };
}

export function getExecutiveSummary(
  db: Database.Database,
  projectId: string,
  summaryId: string
): ExecutiveSummary {
  return serializeSummary(db, getSummaryRowOrThrow(db, projectId, summaryId));
}

export function createExecutiveSummary(
  db: Database.Database,
  projectId: string,
  input: CreateExecutiveSummaryInput
): ExecutiveSummary {
  if (!input.title || !input.period_start || !input.period_end) {
    throw new MissingExecutiveSummaryCreateFieldsError();
  }

  const result = db.transaction(() => {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO executive_summaries (id, project_id, title, period_start, period_end, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)`
    ).run(
      id,
      projectId,
      input.title,
      input.period_start,
      input.period_end,
      normalizeOptionalText(input.created_by) || 'user'
    );

    const insertBlock = db.prepare(
      `INSERT INTO executive_summary_blocks (id, summary_id, block_key, title, content, order_index)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (let index = 0; index < DEFAULT_BLOCK_TEMPLATES.length; index++) {
      const template = DEFAULT_BLOCK_TEMPLATES[index];
      insertBlock.run(uuidv4(), id, template.key, template.title, template.placeholder, index);
    }

    return serializeSummary(db, getSummaryRowOrThrow(db, projectId, id));
  })();

  eventBus.publish('summary.created', {
    type: 'summary.created',
    projectId,
    payload: { summary: result },
    meta: { correlationId: result.id, timestamp: Date.now(), source: 'executive-summaries/core.createExecutiveSummary' },
  });

  return result;
}

export function updateExecutiveSummary(
  db: Database.Database,
  projectId: string,
  summaryId: string,
  input: UpdateExecutiveSummaryInput
): ExecutiveSummary {
  getSummaryRowOrThrow(db, projectId, summaryId);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.title !== undefined) {
    updates.push('title = ?');
    values.push(input.title);
  }
  if (input.period_start !== undefined) {
    updates.push('period_start = ?');
    values.push(input.period_start);
  }
  if (input.period_end !== undefined) {
    updates.push('period_end = ?');
    values.push(input.period_end);
  }
  if (input.status !== undefined) {
    if (!isExecutiveSummaryStatus(input.status)) {
      throw new InvalidExecutiveSummaryStatusError();
    }
    updates.push('status = ?');
    values.push(input.status);
  }

  if (updates.length === 0) {
    throw new NoValidExecutiveSummaryUpdateFieldsError();
  }

  updates.push("updated_at = datetime('now')");
  values.push(summaryId, projectId);

  db.prepare(
    `UPDATE executive_summaries SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`
  ).run(...values);

  const result = getExecutiveSummary(db, projectId, summaryId);
  eventBus.publish('summary.updated', {
    type: 'summary.updated',
    projectId,
    payload: { summary: result },
    meta: { correlationId: summaryId, timestamp: Date.now(), source: 'executive-summaries/core.updateExecutiveSummary' },
  });

  return result;
}

export function deleteExecutiveSummary(
  db: Database.Database,
  projectId: string,
  summaryId: string
): { ok: true } {
  getSummaryRowOrThrow(db, projectId, summaryId);
  db.prepare('DELETE FROM executive_summaries WHERE id = ?').run(summaryId);

  eventBus.publish('summary.deleted', {
    type: 'summary.deleted',
    projectId,
    payload: { summaryId },
    meta: { correlationId: summaryId, timestamp: Date.now(), source: 'executive-summaries/core.deleteExecutiveSummary' },
  });

  return { ok: true };
}

export function updateExecutiveSummaryBlock(
  db: Database.Database,
  projectId: string,
  summaryId: string,
  blockId: string,
  input: UpdateExecutiveSummaryBlockInput
): ExecutiveSummaryBlock {
  getSummaryRowOrThrow(db, projectId, summaryId);
  getBlockRowOrThrow(db, summaryId, blockId);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.title !== undefined) {
    updates.push('title = ?');
    values.push(input.title);
  }
  if (input.content !== undefined) {
    updates.push('content = ?');
    values.push(input.content);
  }
  if (input.order_index !== undefined) {
    updates.push('order_index = ?');
    values.push(input.order_index);
  }

  if (updates.length === 0) {
    throw new NoValidExecutiveSummaryUpdateFieldsError();
  }

  values.push(blockId);
  db.prepare(
    `UPDATE executive_summary_blocks SET ${updates.join(', ')} WHERE id = ?`
  ).run(...values);
  db.prepare("UPDATE executive_summaries SET updated_at = datetime('now') WHERE id = ?").run(summaryId);

  const updated = getBlockRowOrThrow(db, summaryId, blockId);
  eventBus.publish('summary.block_updated', {
    type: 'summary.block_updated',
    projectId,
    payload: { summaryId, block: serializeBlock(updated) },
    meta: { correlationId: blockId, timestamp: Date.now(), source: 'executive-summaries/core.updateExecutiveSummaryBlock' },
  });

  return serializeBlock(updated);
}

export function createExecutiveSummaryBlock(
  db: Database.Database,
  projectId: string,
  summaryId: string,
  input: CreateExecutiveSummaryBlockInput
): ExecutiveSummaryBlock {
  getSummaryRowOrThrow(db, projectId, summaryId);
  if (!input.key || !input.title) {
    throw new MissingExecutiveSummaryBlockCreateFieldsError();
  }
  assertBlockKeyAvailable(db, summaryId, input.key);

  const maxOrder = db.prepare(
    'SELECT MAX(order_index) as max_idx FROM executive_summary_blocks WHERE summary_id = ?'
  ).get(summaryId) as { max_idx: number | null };
  const nextIndex = (maxOrder.max_idx ?? -1) + 1;

  const id = uuidv4();
  db.prepare(
    `INSERT INTO executive_summary_blocks (id, summary_id, block_key, title, content, order_index)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, summaryId, input.key, input.title, input.content || '', nextIndex);
  db.prepare("UPDATE executive_summaries SET updated_at = datetime('now') WHERE id = ?").run(summaryId);

  return serializeBlock(getBlockRowOrThrow(db, summaryId, id));
}

export function deleteExecutiveSummaryBlock(
  db: Database.Database,
  projectId: string,
  summaryId: string,
  blockId: string
): { ok: true } {
  getSummaryRowOrThrow(db, projectId, summaryId);
  getBlockRowOrThrow(db, summaryId, blockId);

  db.prepare('DELETE FROM executive_summary_blocks WHERE id = ?').run(blockId);
  db.prepare("UPDATE executive_summaries SET updated_at = datetime('now') WHERE id = ?").run(summaryId);

  return { ok: true };
}

export function generateExecutiveSummary(
  db: Database.Database,
  projectId: string,
  summaryId: string
): ExecutiveSummary {
  const summary = getSummaryRowOrThrow(db, projectId, summaryId);
  const generatedContent = buildGeneratedExecutiveSummaryContent(
    db,
    projectId,
    summary.period_start,
    summary.period_end
  );

  const updateBlock = db.prepare(
    `UPDATE executive_summary_blocks SET content = ? WHERE summary_id = ? AND block_key = ?`
  );
  for (const [key, content] of Object.entries(generatedContent)) {
    updateBlock.run(content, summaryId, key);
  }

  db.prepare("UPDATE executive_summaries SET updated_at = datetime('now') WHERE id = ?").run(summaryId);

  const result = getExecutiveSummary(db, projectId, summaryId);
  eventBus.publish('summary.generated', {
    type: 'summary.generated',
    projectId,
    payload: { summary: result },
    meta: { correlationId: summaryId, timestamp: Date.now(), source: 'executive-summaries/core.generateExecutiveSummary' },
  });

  return result;
}

export function finalizeExecutiveSummary(
  db: Database.Database,
  projectId: string,
  summaryId: string
): ExecutiveSummary {
  const existing = getSummaryRowOrThrow(db, projectId, summaryId);
  if (existing.status === 'final') {
    throw new ExecutiveSummaryAlreadyFinalizedError();
  }
  if (existing.status === 'archived') {
    throw new ExecutiveSummaryArchivedFinalizeError();
  }

  db.prepare(
    "UPDATE executive_summaries SET status = 'final', updated_at = datetime('now') WHERE id = ?"
  ).run(summaryId);

  const result = getExecutiveSummary(db, projectId, summaryId);
  eventBus.publish('summary.finalized', {
    type: 'summary.finalized',
    projectId,
    payload: { summary: result },
    meta: { correlationId: summaryId, timestamp: Date.now(), source: 'executive-summaries/core.finalizeExecutiveSummary' },
  });

  return result;
}
