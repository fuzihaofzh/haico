export type ProjectEventType =
  | 'agent_status'
  | 'agent_created'
  | 'agent_deleted'
  | 'issue_created'
  | 'issue_updated'
  | 'issue_deleted'
  | 'comment_added'
  | 'agent_message'
  | 'project_deleted'
  | 'executive_summary_created'
  | 'executive_summary_updated'
  | 'executive_summary_deleted'
  | 'executive_summary_block_updated'
  | 'executive_summary_generated'
  | 'executive_summary_finalized';

export interface ProjectEvent {
  type: ProjectEventType;
  projectId: string;
  data: Record<string, any>;
}

export type AgentOutputEvent =
  | { type: 'connected'; agentId: string }
  | { type: 'output'; stream: string; content: string; runId: string }
  | { type: 'exit'; code: number | null; runId: string }
  | { type: 'error'; message: string; runId?: string };

export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' };

export type RealtimeErrorMessage = {
  type: 'error';
  code: string;
  message: string;
};

export type TerminalServerMessage =
  | { type: 'connected'; agentId: string; hasExistingSession: boolean }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number }
  | RealtimeErrorMessage;
