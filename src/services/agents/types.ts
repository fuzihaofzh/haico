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
}

export interface AgentStopLogger {
  error(message: string): void;
  warn(message: string): void;
}

export interface AgentFileListEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  modified: string;
}

export interface AgentFileListResult {
  path: string;
  showHidden: boolean;
  entries: AgentFileListEntry[];
}

export interface AgentFileServeResult {
  buffer: Buffer;
  contentType: string;
  applyHtmlPreviewCsp: boolean;
}

export interface AgentFileSaveResult {
  success: true;
  path: string;
  size: number;
  modified: string;
}

export interface AgentFileUploadResult {
  success: true;
  path: string;
  name: string;
  size: number;
}

export type AgentFileUploadResponse = AgentFileUploadResult | { success: true; files: AgentFileUploadResult[] };

export interface AgentFileDownloadResult {
  buffer: Buffer;
  contentType: string;
  fileName: string;
}
