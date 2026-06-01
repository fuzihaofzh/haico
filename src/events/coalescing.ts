import type { DomainEvent, EventHandler } from './types';
import logger from '../logger';

export interface CoalesceOptions {
  windowMs: number;
  keyFn: (event: DomainEvent) => string;
  minIntervalMs?: number;
  mergeFn?: (existing: DomainEvent, incoming: DomainEvent) => DomainEvent;
}

interface CoalescedEntry {
  event: DomainEvent;
  timer: NodeJS.Timeout;
  lastDispatchMs: number;
}

const coalescedEntries = new Map<string, CoalescedEntry>();

export function coalesce(
  opts: CoalesceOptions,
  handler: EventHandler
): EventHandler {
  return (event: DomainEvent) => {
    const key = opts.keyFn(event);
    const existing = coalescedEntries.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.event = opts.mergeFn ? opts.mergeFn(existing.event, event) : event;
    } else {
      const entry: CoalescedEntry = {
        event,
        timer: null as unknown as NodeJS.Timeout,
        lastDispatchMs: 0,
      };
      coalescedEntries.set(key, entry);
    }

    const entry = coalescedEntries.get(key)!;
    const lastRunMs = entry.lastDispatchMs;
    const minDelay = opts.minIntervalMs
      ? Math.max(0, opts.minIntervalMs - (Date.now() - lastRunMs))
      : 0;
    const delayMs = Math.max(opts.windowMs, minDelay);

    entry.timer = setTimeout(() => {
      coalescedEntries.delete(key);
      entry.lastDispatchMs = Date.now();
      try {
        handler(entry.event);
      } catch (err) {
        logger.error({ err, eventType: entry.event.type, coalesceKey: key }, 'event.coalesced_handler_error');
      }
    }, delayMs);
    entry.timer.unref?.();
  };
}

export function clearCoalescingTimers(): void {
  for (const entry of coalescedEntries.values()) {
    clearTimeout(entry.timer);
  }
  coalescedEntries.clear();
}
