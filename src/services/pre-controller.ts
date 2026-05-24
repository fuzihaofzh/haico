import logger from '../logger';

export function tryHandleWithoutLLM(projectId: string, triggerIssueNumber?: number): boolean {
  logger.debug({ projectId, triggerIssueNumber }, 'pre_controller.noop_task_runtime');
  return false;
}
