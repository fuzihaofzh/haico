export type OrchestratorEngine = 'native' | 'langgraph';

export interface Project {
  id: string;
  name: string;
  description: string;
  task_description: string;
  controller_interval_min: number;
  command_template: string;
  orchestrator_engine: OrchestratorEngine;
  schedule_hours: string;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  project_id: string;
  name: string;
  role: string;
  is_controller: boolean;
  session_id: string | null;
  working_directory: string | null;
  custom_instructions: string;
  session_run_count: number;
  session_max_runs: number;
  session_token_count: number;
  session_max_tokens: number;
  session_resume_timeout: number;
  command_template: string | null;
  status: 'idle' | 'running' | 'error' | 'stopped';
  paused: boolean;
  pid: number | null;
  last_prompt: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface Issue {
  id: string;
  project_id: string;
  number: number;
  title: string;
  body: string;
  created_by: string;
  assigned_to: string | null;
  priority: number;
  status: 'open' | 'in_progress' | 'pending' | 'done' | 'closed';
  labels: string;
  milestone_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueComment {
  id: string;
  issue_id: string;
  author_id: string;
  body: string;
  created_at: string;
}

export interface ConversationLog {
  id: number;
  agent_id: string;
  run_id: string;
  content: string;
  stream: 'stdin' | 'stdout' | 'stderr';
  created_at: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  task_description: string;
  controller_interval_min?: number;
  command_template?: string;
  orchestrator_engine?: OrchestratorEngine;
}

export interface CreateAgentInput {
  name: string;
  role: string;
  is_controller?: boolean;
  session_id?: string;
  working_directory?: string;
  command_template?: string;
}

export interface StartAgentInput {
  prompt: string;
}
