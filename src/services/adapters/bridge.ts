/**
 * TaskRunEventBridge — bridges adapter runtime events to DB/WS/EventBus.
 *
 * NOTE: In the current architecture, the BaseCliAdapter already writes
 * to DB/WS directly inside its output handlers (inherited from the old
 * cli-executor + output.ts code).  This bridge exists for the adapter
 * architecture's event-driven path but is currently a thin pass-through.
 *
 * When adapters are fully migrated to emit events (instead of directly
 * writing to DB), this bridge becomes the sole writer.
 */

import type { AdapterEventSink, AdapterRuntimeEvent } from './types';

export class TaskRunEventBridge implements AdapterEventSink {
  onEvent(event: AdapterRuntimeEvent): void {
    // Currently a no-op: BaseCliAdapter handles DB/WS writes directly
    // inside parseOutputLine/logAndBroadcast for backward compatibility.
    // This will become active when output is fully event-driven.
  }
}
