import { AgentExitStatus } from './types';

export function classifyAgentExitStatus(input: {
  currentStatus?: string | null;
  exitCode: number | null;
  requiresCompletionSignal: boolean;
  sawClosedStdinSessionError: boolean;
  sawCompletionSignal: boolean;
  hadFinalResult: boolean;
}): AgentExitStatus {
  if (input.currentStatus === 'stopped') return 'stopped';
  if (input.hadFinalResult) return 'idle';
  if (input.exitCode !== 0 || input.sawClosedStdinSessionError) return 'error';
  if (!input.requiresCompletionSignal) return 'idle';
  return input.sawCompletionSignal ? 'idle' : 'error';
}
