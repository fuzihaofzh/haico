import Database from 'better-sqlite3';
import type { ProjectRequestContext } from '../project-access';

export interface DashboardChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DashboardChatInput {
  message: string;
  messages?: DashboardChatMessage[];
  project_id?: string | null;
  command_profile_id?: string | null;
  command?: string | null;
  command_type?: string | null;
}

export interface DashboardChatToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface DashboardChatResult {
  message: string;
  tool_calls: DashboardChatToolCall[];
  command: {
    template: string;
    type: string | null;
    profile_id: string | null;
    profile_name: string;
  };
}

export interface ChatLogger {
  debug(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface CommandSelection {
  template: string;
  type: string | null;
  profileId: string | null;
  profileName: string;
}

export interface ChatProjectSummary {
  id: string;
  name: string;
  description: string;
  status: string;
  is_remote: boolean;
  remote_instance_name: string | null;
  remote_base_url: string | null;
  can_manage: boolean;
  permission_level: string | null;
  color: string | null;
  updated_at: string | null;
  stats: {
    agents: number;
    running: number;
    agentError: number;
    issues: number;
    openIssues: number;
    controllerAgentId: string | null;
  };
}

export interface ChatToolContext {
  db: Database.Database;
  userContext: ProjectRequestContext;
  logger: ChatLogger;
  command: CommandSelection;
  availableProjects: ChatProjectSummary[];
}

export type ParsedProjectId =
  | { kind: 'local'; projectId: string }
  | { kind: 'remote'; instanceId: string; projectId: string };

export type ParsedIssueId =
  | { kind: 'local'; issueId: string }
  | { kind: 'remote'; instanceId: string; issueId: string };

export type AssistantEnvelope =
  | { type: 'answer'; message: string }
  | { type: 'tool_call'; tool: string; arguments: Record<string, unknown> };
