import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Agent } from '../types';
import {
  calculateKnowledgeExpiresAt,
  DEFAULT_KNOWLEDGE_CATEGORY,
  isKnowledgeCategory,
  isKnowledgeStatus,
  type KnowledgeCategory,
  type KnowledgeStatus,
  markExpiredKnowledgeEntries,
  normalizeKnowledgeCategory,
  normalizeKnowledgeStatus,
} from './knowledge-lifecycle';
import { ensureAgentKnowledgeEntry, upsertAgentKnowledgeEntry } from './agent-knowledge';
import {
  DuplicateOwnerKnowledgeEntryError,
  InvalidKnowledgeCategoryError,
  InvalidKnowledgeImportanceError,
  InvalidKnowledgeOwnerAgentError,
  InvalidKnowledgeStatusError,
  KnowledgeAgentNotFoundError,
  KnowledgeEntryNotFoundError,
  MissingKnowledgeContentError,
  MissingKnowledgeTitleError,
} from './knowledge-errors';

const VALID_IMPORTANCE = ['high', 'medium', 'low'] as const;

export type KnowledgeImportance = typeof VALID_IMPORTANCE[number];
export type KnowledgeListStatus = KnowledgeStatus | 'all';

export interface KnowledgeEntry {
  id: string;
  project_id: string;
  owner_agent_id: string | null;
  title: string;
  content: string;
  tags: string;
  importance: KnowledgeImportance;
  category: KnowledgeCategory;
  expires_at: string | null;
  last_verified_at: string | null;
  verified_by: string | null;
  status: KnowledgeStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ListKnowledgeFilters {
  tag?: string;
  importance?: string;
  q?: string;
  status?: string;
  category?: string;
  owner_agent_id?: string;
  include_owned?: string;
}

export interface CreateKnowledgeEntryInput {
  title?: string;
  content?: string;
  tags?: string;
  importance?: string;
  category?: string;
  created_by?: string;
  owner_agent_id?: string;
}

export interface UpdateKnowledgeEntryInput {
  title?: string;
  content?: string;
  tags?: string;
  importance?: string;
  category?: string;
  status?: string;
  verified_by?: string;
}

export interface VerifyKnowledgeEntryInput {
  verified_by?: string;
}

export interface UpdateAgentKnowledgeMemoryInput {
  content?: string;
  tags?: string;
  importance?: string;
  category?: string;
  verified_by?: string;
}

function parseBooleanFlag(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseOwnerAgentId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function parseKnowledgeCategory(value: unknown): KnowledgeCategory | null {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_KNOWLEDGE_CATEGORY;
  }
  const normalized = String(value).trim().toLowerCase();
  return isKnowledgeCategory(normalized) ? normalized : null;
}

function parseKnowledgeStatus(value: unknown): KnowledgeStatus | 'all' | null {
  if (value === undefined || value === null || String(value).trim() === '') return 'active';
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'all') return 'all';
  return isKnowledgeStatus(normalized) ? normalized : null;
}

function validateImportance(importance: string | undefined): KnowledgeImportance | undefined {
  if (!importance) return undefined;
  if ((VALID_IMPORTANCE as readonly string[]).includes(importance)) {
    return importance as KnowledgeImportance;
  }
  throw new InvalidKnowledgeImportanceError();
}

function requireCategory(value: unknown): KnowledgeCategory {
  const category = parseKnowledgeCategory(value);
  if (!category) {
    throw new InvalidKnowledgeCategoryError();
  }
  return category;
}

function parseOptionalCategory(value: unknown): KnowledgeCategory | null {
  const category = parseKnowledgeCategory(value);
  if (!category) {
    throw new InvalidKnowledgeCategoryError();
  }
  return category;
}

function parseListStatus(value: unknown): KnowledgeListStatus {
  const status = parseKnowledgeStatus(value);
  if (!status) {
    throw new InvalidKnowledgeStatusError({ includeAll: true });
  }
  return status;
}

function resolveKnowledgeActor(body: { verified_by?: string; created_by?: string }, existing?: Partial<KnowledgeEntry>): string {
  const actor = body.verified_by || body.created_by || existing?.verified_by || existing?.created_by || 'user';
  return String(actor).trim() || 'user';
}

function getAgentById(db: Database.Database, agentId: string): Agent {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Agent | undefined;
  if (!agent) throw new KnowledgeAgentNotFoundError();
  return agent;
}

function assertOwnerAgentInProject(db: Database.Database, projectId: string, ownerAgentId: string): void {
  const ownerAgent = db.prepare('SELECT id FROM agents WHERE id = ? AND project_id = ?').get(ownerAgentId, projectId) as { id: string } | undefined;
  if (!ownerAgent) {
    throw new InvalidKnowledgeOwnerAgentError();
  }
}

function getKnowledgeEntryOrThrow(db: Database.Database, id: string): KnowledgeEntry {
  const entry = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as KnowledgeEntry | undefined;
  if (!entry) throw new KnowledgeEntryNotFoundError();
  return entry;
}

export function getAgentKnowledgeMemory(db: Database.Database, agentId: string): KnowledgeEntry {
  const agent = getAgentById(db, agentId);
  return ensureAgentKnowledgeEntry(db, agent) as KnowledgeEntry;
}

export function updateAgentKnowledgeMemory(
  db: Database.Database,
  agentId: string,
  input: UpdateAgentKnowledgeMemoryInput
): KnowledgeEntry {
  const agent = getAgentById(db, agentId);
  if (!input?.content || !String(input.content).trim()) {
    throw new MissingKnowledgeContentError();
  }
  const importance = validateImportance(input.importance);
  const category = input.category === undefined ? undefined : requireCategory(input.category);

  return upsertAgentKnowledgeEntry(db, agent, {
    content: String(input.content),
    tags: input.tags,
    category,
    importance,
    actor: input.verified_by || agent.id,
  }) as KnowledgeEntry;
}

export function listKnowledgeEntries(
  db: Database.Database,
  projectId: string,
  filters: ListKnowledgeFilters = {}
): KnowledgeEntry[] {
  const importance = validateImportance(filters.importance);
  const status = parseListStatus(filters.status);
  const category = filters.category ? parseOptionalCategory(filters.category) : null;
  const ownerAgentId = parseOwnerAgentId(filters.owner_agent_id);
  const includeOwned = parseBooleanFlag(filters.include_owned);
  const tag = filters.tag;
  const q = filters.q;

  if (ownerAgentId) {
    assertOwnerAgentInProject(db, projectId, ownerAgentId);
  }

  markExpiredKnowledgeEntries(db, projectId);

  if (q && q.trim()) {
    let sql = `SELECT ke.*, rank
      FROM knowledge_fts fts
      JOIN knowledge_entries ke ON ke.rowid = fts.rowid
      WHERE knowledge_fts MATCH ? AND ke.project_id = ?`;
    const params: unknown[] = [q.trim(), projectId];

    if (status !== 'all') {
      sql += ' AND ke.status = ?';
      params.push(status);
    }
    if (importance) {
      sql += ' AND ke.importance = ?';
      params.push(importance);
    }
    if (category) {
      sql += ' AND ke.category = ?';
      params.push(category);
    }
    if (tag) {
      sql += " AND (',' || ke.tags || ',' LIKE ?)";
      params.push(`%,${tag},%`);
    }
    if (ownerAgentId) {
      sql += ' AND ke.owner_agent_id = ?';
      params.push(ownerAgentId);
    } else if (!includeOwned) {
      sql += ' AND ke.owner_agent_id IS NULL';
    }
    sql += ' ORDER BY rank';
    return db.prepare(sql).all(...params) as KnowledgeEntry[];
  }

  let sql = 'SELECT * FROM knowledge_entries WHERE project_id = ?';
  const params: unknown[] = [projectId];

  if (status !== 'all') {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (importance) {
    sql += ' AND importance = ?';
    params.push(importance);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (tag) {
    sql += " AND (',' || tags || ',' LIKE ?)";
    params.push(`%,${tag},%`);
  }
  if (ownerAgentId) {
    sql += ' AND owner_agent_id = ?';
    params.push(ownerAgentId);
  } else if (!includeOwned) {
    sql += ' AND owner_agent_id IS NULL';
  }

  sql += ' ORDER BY importance ASC, updated_at DESC';
  return db.prepare(sql).all(...params) as KnowledgeEntry[];
}

export function createKnowledgeEntry(
  db: Database.Database,
  projectId: string,
  input: CreateKnowledgeEntryInput
): KnowledgeEntry {
  if (!input?.title) throw new MissingKnowledgeTitleError();
  const importance = validateImportance(input.importance) || 'medium';
  const category = requireCategory(input.category);
  const ownerAgentId = parseOwnerAgentId(input.owner_agent_id);

  if (ownerAgentId) {
    assertOwnerAgentInProject(db, projectId, ownerAgentId);
    const existingOwnerEntry = db.prepare(
      'SELECT id FROM knowledge_entries WHERE project_id = ? AND owner_agent_id = ? LIMIT 1'
    ).get(projectId, ownerAgentId) as { id: string } | undefined;
    if (existingOwnerEntry) {
      throw new DuplicateOwnerKnowledgeEntryError();
    }
  }

  const id = uuidv4();
  const actor = input.created_by || ownerAgentId || 'user';
  const expiresAt = calculateKnowledgeExpiresAt(category);
  db.prepare(
    `INSERT INTO knowledge_entries
      (id, project_id, owner_agent_id, title, content, tags, importance, category, expires_at, last_verified_at, verified_by, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'active', ?)`
  ).run(
    id,
    projectId,
    ownerAgentId,
    input.title,
    input.content || '',
    input.tags || '',
    importance,
    category,
    expiresAt,
    actor,
    actor
  );

  return getKnowledgeEntryOrThrow(db, id);
}

export function getKnowledgeEntry(db: Database.Database, id: string): KnowledgeEntry {
  return getKnowledgeEntryOrThrow(db, id);
}

export function updateKnowledgeEntry(
  db: Database.Database,
  id: string,
  input: UpdateKnowledgeEntryInput
): KnowledgeEntry {
  const existing = getKnowledgeEntryOrThrow(db, id);
  const importance = validateImportance(input.importance) || existing.importance;
  const category = input.category === undefined
    ? normalizeKnowledgeCategory(existing.category)
    : requireCategory(input.category);
  const parsedStatus = input.status === undefined ? undefined : parseKnowledgeStatus(input.status);
  if (parsedStatus === 'all' || parsedStatus === null) {
    throw new InvalidKnowledgeStatusError();
  }

  const title = input.title ?? existing.title;
  const content = input.content ?? existing.content;
  const tags = input.tags ?? existing.tags;
  const shouldRefreshLifecycle = input.title !== undefined
    || input.content !== undefined
    || input.tags !== undefined
    || input.importance !== undefined
    || input.category !== undefined;
  const status = parsedStatus ?? (shouldRefreshLifecycle ? 'active' : normalizeKnowledgeStatus(existing.status));
  const shouldVerifyLifecycle = shouldRefreshLifecycle || parsedStatus === 'active';
  const expiresAt = shouldVerifyLifecycle ? calculateKnowledgeExpiresAt(category) : existing.expires_at;
  const verifiedBy = shouldVerifyLifecycle || input.verified_by !== undefined
    ? resolveKnowledgeActor(input, existing)
    : existing.verified_by;

  if (shouldVerifyLifecycle) {
    db.prepare(
      `UPDATE knowledge_entries
       SET title = ?, content = ?, tags = ?, importance = ?, category = ?, expires_at = ?,
           last_verified_at = datetime('now'), verified_by = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(title, content, tags, importance, category, expiresAt, verifiedBy, status, id);
  } else {
    db.prepare(
      `UPDATE knowledge_entries
       SET title = ?, content = ?, tags = ?, importance = ?, category = ?, expires_at = ?,
           verified_by = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(title, content, tags, importance, category, expiresAt, verifiedBy, status, id);
  }

  return getKnowledgeEntryOrThrow(db, id);
}

export function verifyKnowledgeEntry(
  db: Database.Database,
  id: string,
  input: VerifyKnowledgeEntryInput = {}
): KnowledgeEntry {
  const existing = getKnowledgeEntryOrThrow(db, id);
  const category = normalizeKnowledgeCategory(existing.category);
  const expiresAt = calculateKnowledgeExpiresAt(category);
  const actor = resolveKnowledgeActor(input, existing);
  db.prepare(
    `UPDATE knowledge_entries
     SET last_verified_at = datetime('now'), verified_by = ?, expires_at = ?, status = 'active', updated_at = datetime('now')
     WHERE id = ?`
  ).run(actor, expiresAt, id);

  return getKnowledgeEntryOrThrow(db, id);
}

export function deleteKnowledgeEntry(db: Database.Database, id: string): void {
  getKnowledgeEntryOrThrow(db, id);
  db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id);
}
