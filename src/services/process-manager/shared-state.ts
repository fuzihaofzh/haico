/**
 * Shared in-process state maps used by both process-manager/watchdog
 * and adapters/base-cli-adapter.
 *
 * Kept in a standalone module to avoid circular imports.
 */

/** Timestamp of the last "Final Result" event per agent (epoch ms). */
export const agentFinalResultTime = new Map<string, number>();
