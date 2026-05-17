import Database from 'better-sqlite3';

export const NOTIFICATION_PREVIEW_CHARS = 150;
export const DEFAULT_INBOX_PAGE_LIMIT = 20;
export const MAX_INBOX_PAGE_LIMIT = 100;
export const USER_RELATED_ISSUE_WHERE = `(
  i.assigned_to = 'user'
  OR i.created_by = 'user'
  OR i.id IN (SELECT DISTINCT issue_id FROM issue_comments WHERE author_id = 'user')
)`;

export type ReactionTargetType = 'issue' | 'comment';

export function buildSqlPlaceholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export function previewSql(column: string): string {
  return `substr(COALESCE(${column}, ''), 1, ${NOTIFICATION_PREVIEW_CHARS})`;
}

export function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function attachCommentReactions(db: Database.Database, comments: any[]): any[] {
  const commentIds = comments.map((comment) => comment.id);
  if (commentIds.length === 0) return comments;

  const placeholders = buildSqlPlaceholders(commentIds);
  const reactions = db.prepare(
    `SELECT * FROM reactions WHERE target_type = 'comment' AND target_id IN (${placeholders})`
  ).all(...commentIds) as any[];
  const reactionsByComment: Record<string, any[]> = {};
  for (const reaction of reactions) {
    (reactionsByComment[reaction.target_id] ||= []).push(reaction);
  }

  return comments.map((comment) => ({
    ...comment,
    reactions: reactionsByComment[comment.id] || [],
  }));
}

export function isSqliteUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message || '');
  return code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || (code === 'SQLITE_CONSTRAINT' && message.includes('UNIQUE constraint failed'))
    || message.includes('UNIQUE constraint failed');
}
