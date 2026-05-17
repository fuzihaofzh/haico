import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  InvalidReactionTargetTypeError,
  MissingReactionFieldsError,
} from './issue/errors';
import { ReactionTargetType, isSqliteUniqueConstraintError } from './issue/utils';

export interface ToggleReactionInput {
  user_id?: string;
  emoji?: string;
}

export function assertReactionTargetType(type: string): asserts type is ReactionTargetType {
  if (type !== 'issue' && type !== 'comment') {
    throw new InvalidReactionTargetTypeError();
  }
}

export function toggleReaction(
  db: Database.Database,
  targetType: ReactionTargetType,
  targetId: string,
  input: ToggleReactionInput
): { toggled: 'on'; id: string } | { toggled: 'off' } {
  const { user_id, emoji } = input;
  if (!user_id || !emoji) throw new MissingReactionFieldsError();

  const id = uuidv4();
  try {
    db.prepare(
      'INSERT INTO reactions (id, target_type, target_id, user_id, emoji) VALUES (?, ?, ?, ?, ?)'
    ).run(id, targetType, targetId, user_id, emoji);
  } catch (error) {
    if (!isSqliteUniqueConstraintError(error)) throw error;
    db.prepare(
      'DELETE FROM reactions WHERE target_type = ? AND target_id = ? AND user_id = ? AND emoji = ?'
    ).run(targetType, targetId, user_id, emoji);
    return { toggled: 'off' };
  }

  return { toggled: 'on', id };
}

export function listReactions(db: Database.Database, targetType: ReactionTargetType, targetId: string): any[] {
  return db.prepare(
    'SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users FROM reactions WHERE target_type = ? AND target_id = ? GROUP BY emoji'
  ).all(targetType, targetId) as any[];
}
