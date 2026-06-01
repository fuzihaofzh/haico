import { CreateAgentInput } from '../../types';

export interface UpdateAgentInput extends Partial<CreateAgentInput> {
  custom_instructions?: string | null;
  session_max_runs?: unknown;
  session_max_tokens?: unknown;
  session_resume_timeout?: unknown;
  paused?: boolean;
}

export interface StartAgentServiceInput {
  prompt?: string;
  force_new_session?: boolean;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentStopLogger {
  error(message: string): void;
  warn(message: string): void;
}
