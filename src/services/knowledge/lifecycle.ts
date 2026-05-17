import Database from 'better-sqlite3';

export const KNOWLEDGE_CATEGORIES = ['architecture', 'convention', 'bug', 'environment', 'code', 'reference'] as const;
export const KNOWLEDGE_STATUSES = ['active', 'stale', 'archived'] as const;
export const DEFAULT_KNOWLEDGE_CATEGORY = 'architecture';

export type KnowledgeCategory = typeof KNOWLEDGE_CATEGORIES[number];
export type KnowledgeStatus = typeof KNOWLEDGE_STATUSES[number];

const CATEGORY_EXPIRY_DAYS: Record<KnowledgeCategory, number> = {
  architecture: 30,
  convention: 90,
  bug: 30,
  environment: 30,
  code: 30,
  reference: 180,
};

export function isKnowledgeCategory(value: string): value is KnowledgeCategory {
  return (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value);
}

export function isKnowledgeStatus(value: string): value is KnowledgeStatus {
  return (KNOWLEDGE_STATUSES as readonly string[]).includes(value);
}

export function normalizeKnowledgeCategory(category?: string | null): KnowledgeCategory {
  const normalized = (category || DEFAULT_KNOWLEDGE_CATEGORY).trim().toLowerCase();
  return isKnowledgeCategory(normalized) ? normalized : DEFAULT_KNOWLEDGE_CATEGORY;
}

export function normalizeKnowledgeStatus(status?: string | null): KnowledgeStatus {
  const normalized = (status || 'active').trim().toLowerCase();
  return isKnowledgeStatus(normalized) ? normalized : 'active';
}

export function calculateKnowledgeExpiresAt(category?: string | null, baseDate = new Date()): string {
  const days = CATEGORY_EXPIRY_DAYS[normalizeKnowledgeCategory(category)];
  const expiresAt = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);
  return expiresAt.toISOString().slice(0, 19).replace('T', ' ');
}

function archivedThresholdSql(): string {
  return `datetime('now', '-' || CASE category
    WHEN 'convention' THEN 90
    WHEN 'reference' THEN 180
    ELSE 30
  END || ' days')`;
}

export function markExpiredKnowledgeEntries(db: Database.Database, projectId?: string): number {
  const projectFilter = projectId ? ' AND project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const staleResult = db.prepare(
    `UPDATE knowledge_entries
     SET status = 'stale'
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at < datetime('now')${projectFilter}`
  ).run(...params);
  const archivedResult = db.prepare(
    `UPDATE knowledge_entries
     SET status = 'archived'
     WHERE status = 'stale'
       AND expires_at IS NOT NULL
       AND expires_at < ${archivedThresholdSql()}${projectFilter}`
  ).run(...params);
  return staleResult.changes + archivedResult.changes;
}
