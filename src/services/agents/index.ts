/**
 * Agent service package public surface.
 *
 * Structure:
 * - core.ts: list/create/get/update/delete agents
 * - lifecycle.ts: start/retry/stop/pause/unpause/status/system prompt
 * - messages.ts: direct agent-to-agent messaging
 * - hierarchy.ts: parent/child hierarchy validation and traversal
 * - knowledge.ts: agent-owned knowledge memory lifecycle
 * - files.ts: workspace file list/content/serve/upload/download/SQLite preview
 * - runs.ts: terminal/log/cost/run/report serialization
 * - git.ts: agent working-directory git status
 * - errors.ts: agent domain errors, all plain Error subclasses
 * - message-errors.ts: direct messaging domain errors
 * - types.ts: shared service input/output contracts
 * - policy.ts: agent-only business constants such as file limits and MIME maps
 *
 * Constraints:
 * - Routes import agent service capabilities from this index only.
 * - Access checks that need Fastify request/reply stay in routes.
 * - Agent business logic, DB work, filesystem work, process lifecycle,
 *   serialization, and realtime event publication stay inside this package.
 * - Domain errors do not carry HTTP status codes; error-mapper owns HTTP mapping.
 * - Service modules must not import Fastify types. Pass a minimal logger when needed.
 */
export {
  createAgent,
  deleteAgent,
  getAgent,
  listProjectAgents,
  updateAgent,
} from './core';
export {
  getAgentStatus,
  getAgentSystemPrompt,
  pauseAgent,
  retryAgent,
  startAgent,
  stopAgent,
  unpauseAgent,
} from './lifecycle';
export {
  assertSendAgentMessageInput,
  listAgentInboxMessages,
  listAgentSentMessages,
  markAgentMessageRead,
  markAllAgentMessagesRead,
  sendAgentMessage,
} from './messages';
export {
  downloadAgentFile,
  finalizeAgentFileUpload,
  getAgentFileContent,
  listAgentFiles,
  previewAgentSqliteFile,
  saveAgentFileContent,
  saveAgentUploadedFile,
  serveAgentFile,
} from './files';
export {
  getAgentCosts,
  getAgentLogs,
  getAgentRunLogs,
  getAgentRunReport,
  getAgentTerminalText,
  listAgentRuns,
} from './runs';
export { getAgentGitStatus } from './git';
export * from './errors';
export * from './message-errors';
export * from './types';
