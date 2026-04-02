export type OrchestratorEngine = 'native' | 'langgraph';

export interface Project {
  id: string;
  name: string;
  description: string;
  task_description: string;
  command_template: string;
  orchestrator_engine: OrchestratorEngine;
  status: 'active' | 'paused' | 'completed';
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: 'owner' | 'member';
  created_at: string;
}

export interface Agent {
  id: string;
  project_id: string;
  name: string;
  role: string;
  is_controller: boolean;
  parent_agent_id: string | null;
  session_id: string | null;
  working_directory: string | null;
  custom_instructions: string;
  session_run_count: number;
  session_max_runs: number;
  session_token_count: number;
  session_max_tokens: number;
  session_resume_timeout: number;
  command_template: string | null;
  status: 'idle' | 'running' | 'waiting' | 'error';
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
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueComment {
  id: string;
  issue_id: string;
  author_id: string;
  body: string;
  event_type: 'comment' | 'status_change' | 'assignment' | 'label_change';
  meta: string;
  created_at: string;
}

export interface ConversationLog {
  id: number;
  agent_id: string;
  run_id: string;
  content: string;
  stream: 'stdin' | 'stdout' | 'stderr' | 'cost';
  created_at: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  task_description: string;
  command_template?: string;
  orchestrator_engine?: OrchestratorEngine;
}

export interface CreateAgentInput {
  name: string;
  role: string;
  is_controller?: boolean;
  parent_agent_id?: string | null;
  session_id?: string;
  working_directory?: string;
  command_template?: string;
}

export interface StartAgentInput {
  prompt: string;
}

export interface ApprovalRequest {
  id: string;
  project_id: string;
  issue_id: string | null;
  agent_id: string;
  title: string;
  description: string;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  decision_note: string;
  decided_at: string | null;
  created_at: string;
}

export interface User {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  password_salt: string;
  display_name: string;
  role: 'admin' | 'member';
  created_at: string;
  last_login_at: string | null;
}
