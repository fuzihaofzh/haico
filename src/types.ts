export type OrchestratorEngine = 'native' | 'langgraph';
export type CommandProfileType = 'claude' | 'codex' | 'gemini';
export type ExecutorType = CommandProfileType | 'shell';

export interface Project {
  id: string;
  name: string;
  description: string;
  task_description: string;
  command_template: string;
  command_type: CommandProfileType | null;
  orchestrator_engine: OrchestratorEngine;
  status: 'active' | 'paused' | 'completed';
  owner_id: string | null;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: 'owner' | 'editor' | 'member';
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
  constraints_json?: string;
  context_json?: string;
  capabilities_json?: string;
  executor_preferences_json?: string;
  /** @deprecated Runtime state is derived from task_runs. */
  session_run_count: number;
  /** @deprecated Runtime state is derived from executor_sessions. */
  session_max_runs: number;
  /** @deprecated Runtime state is derived from executor_sessions. */
  session_token_count: number;
  /** @deprecated Runtime state is derived from executor_sessions. */
  session_max_tokens: number;
  /** @deprecated Runtime state is derived from executor_sessions. */
  session_resume_timeout: number;
  /** @deprecated Executor config is resolved from executor_profiles. */
  command_template: string | null;
  /** @deprecated Executor config is resolved from executor_profiles. */
  command_type: CommandProfileType | null;
  /** @deprecated Runtime state is derived from task_runs. */
  status: 'idle' | 'running' | 'waiting' | 'error';
  paused: boolean;
  /** @deprecated Runtime state is derived from task_runs. */
  pid: number | null;
  /** @deprecated Prompt snapshots live on tasks/task_runs. */
  last_prompt: string | null;
  /** @deprecated Runtime state is derived from task_runs. */
  started_at: string | null;
  /** @deprecated Runtime state is derived from task_runs. */
  finished_at: string | null;
  created_at: string;
}

export type AgentRuntimeStatus = 'idle' | 'running' | 'waiting' | 'error' | 'paused';

export interface AgentRuntimeState {
  status: AgentRuntimeStatus;
  active_task_id: string | null;
  active_task_run_id: string | null;
  last_task_run_id: string | null;
}

export type TaskStatus = 'pending' | 'blocked' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';
export type TaskRunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ExecutorProfile {
  id: string;
  project_id: string;
  name: string;
  executor_type: ExecutorType;
  command_template: string;
  command_type: CommandProfileType | null;
  working_directory: string | null;
  env_json: string;
  session_policy_json: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  target_agent_id: string | null;
  source: string;
  source_ref: string | null;
  task_type: string;
  reason: string;
  prompt: string;
  system_prompt: string | null;
  priority: number;
  status: TaskStatus;
  scheduled_at: string | null;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  executor_profile_id: string | null;
  executor_snapshot_json: string;
  context_snapshot_json: string;
  metadata_json: string;
  dedupe_key: string | null;
  current_task_run_id: string | null;
  failure_kind: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRun {
  id: string;
  task_id: string;
  project_id: string;
  agent_id: string;
  executor_profile_id: string | null;
  run_id: string;
  attempt: number;
  status: TaskRunStatus;
  pid: number | null;
  session_id: string | null;
  prompt_snapshot: string;
  command_snapshot: string;
  exit_code: number | null;
  failure_kind: string | null;
  failure_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface ExecutorSession {
  id: string;
  agent_id: string;
  executor_profile_id: string;
  session_id: string;
  run_count: number;
  token_count: number;
  last_used_at: string;
  reset_reason: string;
  created_at: string;
  updated_at: string;
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
  command_type?: CommandProfileType | null;
  orchestrator_engine?: OrchestratorEngine;
  working_directory?: string | null;
  controller_role?: string | null;
  target_instance_id?: string | null;
}

export interface CreateAgentInput {
  name: string;
  role: string;
  is_controller?: boolean;
  parent_agent_id?: string | null;
  session_id?: string;
  working_directory?: string;
  command_template?: string;
  command_type?: CommandProfileType | null;
  constraints_json?: string;
  context_json?: string;
  capabilities_json?: string;
  executor_preferences_json?: string;
}

export interface CommandProfile {
  id: string;
  name: string;
  command: string;
  type: CommandProfileType;
  created_at: string;
  updated_at: string;
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

export interface PaymentApprovalRequest {
  id: string;
  project_id: string;
  issue_id: string | null;
  requested_by: string;
  title: string;
  description: string;
  amount: number;
  currency: string;
  beneficiary: string;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  required_approvals: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  resolved_at: string | null;
  created_at: string;
}

export interface PaymentApprovalDecision {
  id: string;
  payment_approval_id: string;
  decided_by: string;
  decision: 'approve' | 'reject';
  note: string;
  created_at: string;
}

export type ExecutiveSummaryStatus = 'draft' | 'final' | 'archived';

export interface ExecutiveSummaryBlock {
  id: string;
  key: string;
  title: string;
  content: string;
  order_index: number;
}

export interface ExecutiveSummary {
  id: string;
  project_id: string;
  title: string;
  period_start: string;
  period_end: string;
  status: ExecutiveSummaryStatus;
  created_by: string;
  blocks: ExecutiveSummaryBlock[];
  created_at: string;
  updated_at: string;
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
