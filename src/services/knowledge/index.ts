/**
 * Knowledge service package public surface.
 *
 * Structure:
 * - core.ts: project knowledge CRUD, query filtering, verification, and agent memory API wrappers
 * - lifecycle.ts: categories, statuses, expiry calculation, and stale/archive transitions
 * - agent-memory.ts: agent-owned knowledge entry lifecycle and legacy memory migration
 * - errors.ts: knowledge domain errors, all plain Error subclasses
 *
 * Constraints:
 * - Routes import knowledge API capabilities from this index.
 * - Access checks that need Fastify request/reply stay in routes.
 * - Domain errors do not carry HTTP status codes; error-mapper owns HTTP mapping.
 * - Service modules must not import Fastify types.
 */
export * from './core';
export * from './lifecycle';
export * from './agent-memory';
export * from './errors';
