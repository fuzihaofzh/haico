/**
 * Issue service package public surface.
 *
 * Structure:
 * - core.ts: list/create/get/update/delete issues and acknowledgement
 * - comments.ts: issue comment lifecycle
 * - relations.ts: issue dependency and related links
 * - inbox.ts: user issue notifications and inbox search
 * - errors.ts: issue domain errors, all plain Error subclasses
 * - utils.ts: issue-local SQL and serialization helpers
 * - dispatch.ts, batch.ts, agent-autostart.ts, automation.ts:
 *   issue orchestration internals imported directly by runtime services
 *
 * Constraints:
 * - Routes import issue API capabilities from this index.
 * - Runtime orchestration modules import dispatch/batch/autostart submodules directly.
 * - Access checks that need Fastify request/reply stay in routes.
 * - Domain errors do not carry HTTP status codes; error-mapper owns HTTP mapping.
 * - Service modules must not import Fastify types.
 */
export {
  acknowledgeIssue,
  createIssue,
  deleteIssue,
  getIssueByNumberDetail,
  getIssueCounts,
  getIssueDetail,
  listIssues,
  searchProjectIssues,
  unacknowledgeIssue,
  updateIssue,
} from './core';
export type {
  CreateIssueInput,
  IssueListResult,
  ListIssuesFilters,
  UpdateIssueInput,
} from './core';
export {
  addIssueComment,
  deleteIssueComment,
  listIssueComments,
  updateIssueComment,
} from './comments';
export type {
  AddIssueCommentInput,
  UpdateIssueCommentInput,
} from './comments';
export {
  getIssueNotifications,
  listMyIssues,
  searchInboxIssues,
} from './inbox';
export type { InboxQuery } from './inbox';
export {
  createIssueRelation,
  deleteIssueRelation,
  listIssueRelations,
} from './relations';
export type { CreateIssueRelationInput } from './relations';
export * from './errors';
