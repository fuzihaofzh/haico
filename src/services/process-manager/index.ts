export {
  classifyAgentExitStatus,
} from './exit-status';
// Process-manager is now a low-level CLI helper surface; business code must use services/tasks.
export {
  isAgentInCooldown,
} from './controls';
export {
  checkChildCpuActivity,
  clearCpuSnapshot,
  getAgentFinalResultAge,
} from './watchdog';
export {
  DEFAULT_IDLE_TIMEOUT_MS,
  FINAL_RESULT_KILL_DELAY_MS,
  RESTART_COOLDOWN_MS,
} from './policy';
export type {
  AgentExitStatus,
} from './types';
