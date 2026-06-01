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
