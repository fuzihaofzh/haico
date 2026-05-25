import { Agent, CommandProfileType, ExecutorProfile, ExecutorType } from '../../types';

export interface ExecutorSnapshot {
  id: string | null;
  name: string;
  executor_type: ExecutorType;
  command_template: string;
  command_type: CommandProfileType | null;
  command_profile_id: string | null;
  command_profile_name: string | null;
  command_profile_config_json: string;
  working_directory: string | null;
  env: Record<string, string>;
  session_policy: {
    resume_timeout: number;
    max_runs: number;
    max_tokens: number;
    new_session_per_run: boolean;
  };
}

export interface StartCliTaskRunInput {
  agent: Agent;
  taskId: string;
  taskRunId: string;
  executorProfileId: string | null;
  runId: string;
  prompt: string;
  systemPrompt?: string | null;
  executor: ExecutorSnapshot;
}

export interface StartCliTaskRunResult {
  runId: string;
  pid: number;
  sessionId: string;
  command: string;
}

export type ExecutorProfileInput = Pick<
  ExecutorProfile,
  'id' | 'name' | 'executor_type' | 'command_template' | 'command_type' | 'working_directory' | 'env_json' | 'session_policy_json'
>;
