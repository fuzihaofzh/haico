import type { ApiTestContext } from './helpers';

// Migrated to test/unit/process-manager.test.ts — all tests are pure unit tests
// that don't need the API harness. Keeping the registration function as a no-op
// so api.test.ts doesn't need changes until the import is cleaned up.
export function registerProcessManagerSuites(_ctx: ApiTestContext): void {
  // All tests moved to test/unit/process-manager.test.ts
}
