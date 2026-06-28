/**
 * HaicoCredentialStore — pi-ai CredentialStore backed by HAICO's SQLite.
 *
 * Stores one credential per provider in the pi_credentials table.
 * Writes are serialized per provider through a promise chain.
 */

import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { getDatabase } from '../../db/database';
import logger from '../../logger';

/** Per-provider serialized write chains (same approach as InMemoryCredentialStore) */
const chains = new Map<string, Promise<unknown>>();

function enqueue<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(providerId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(providerId, next);
  const cleanup = () => { if (chains.get(providerId) === next) chains.delete(providerId); };
  next.then(cleanup, cleanup);
  return next;
}

export class HaicoCredentialStore implements CredentialStore {
  async read(providerId: string): Promise<Credential | undefined> {
    const db = getDatabase();
    try {
      const row = db.prepare(
        'SELECT credential_json FROM pi_credentials WHERE provider_id = ?'
      ).get(providerId) as { credential_json: string } | undefined;
      if (!row) return undefined;
      return JSON.parse(row.credential_json) as Credential;
    } catch (err) {
      logger.error({ err, providerId }, 'pi-ai.credential_store.read_error');
      return undefined;
    }
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return enqueue(providerId, async () => {
      const db = getDatabase();
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) {
        // undefined returned from fn = leave unchanged
        return current;
      }
      try {
        db.prepare(`
          INSERT INTO pi_credentials (provider_id, credential_json, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(provider_id) DO UPDATE SET
            credential_json = excluded.credential_json,
            updated_at = datetime('now')
        `).run(providerId, JSON.stringify(next));
      } catch (err) {
        logger.error({ err, providerId }, 'pi-ai.credential_store.modify_error');
        throw err;
      }
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    return enqueue(providerId, async () => {
      const db = getDatabase();
      try {
        db.prepare('DELETE FROM pi_credentials WHERE provider_id = ?').run(providerId);
      } catch (err) {
        logger.error({ err, providerId }, 'pi-ai.credential_store.delete_error');
        throw err;
      }
    });
  }
}
