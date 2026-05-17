import {
  DuplicateOwnerKnowledgeEntryError,
  InvalidKnowledgeCategoryError,
  InvalidKnowledgeImportanceError,
  InvalidKnowledgeOwnerAgentError,
  InvalidKnowledgeStatusError,
  KnowledgeAgentNotFoundError,
  KnowledgeEntryNotFoundError,
  MissingKnowledgeContentError,
  MissingKnowledgeTitleError,
} from '../services/knowledge-errors';
import {
  AgentMessageNotFoundError,
  AgentMessageNotInAgentInboxError,
  AgentMessageOutsideDirectHierarchyError,
  AgentMessageRecipientNotFoundError,
  AgentMessageRecipientOutsideProjectError,
  AgentMessageReplyTargetNotFoundError,
  AgentMessageReplyTargetOutsideProjectError,
  AgentMessageSenderNotFoundError,
  MissingAgentMessageBodyError,
  MissingAgentMessageRecipientError,
} from '../services/agent-message-errors';
import {
  AgentAccessAgentNotFoundError,
  MessageAccessMessageNotFoundError,
  ProjectAccessDeniedError,
  ProjectAccessProjectNotFoundError,
  ProjectManagementAccessRequiredError,
} from '../services/project-permission-errors';

export interface HttpErrorMapping {
  statusCode: number;
  message: string;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || 'Internal server error');
}

function mapKnowledgeError(error: unknown): HttpErrorMapping | null {
  if (
    error instanceof MissingKnowledgeTitleError
    || error instanceof MissingKnowledgeContentError
    || error instanceof InvalidKnowledgeImportanceError
    || error instanceof InvalidKnowledgeCategoryError
    || error instanceof InvalidKnowledgeStatusError
    || error instanceof InvalidKnowledgeOwnerAgentError
  ) {
    return { statusCode: 400, message: error.message };
  }

  if (
    error instanceof KnowledgeEntryNotFoundError
    || error instanceof KnowledgeAgentNotFoundError
  ) {
    return { statusCode: 404, message: error.message };
  }

  if (error instanceof DuplicateOwnerKnowledgeEntryError) {
    return { statusCode: 409, message: error.message };
  }

  return null;
}

function mapAgentMessageError(error: unknown): HttpErrorMapping | null {
  if (
    error instanceof MissingAgentMessageRecipientError
    || error instanceof MissingAgentMessageBodyError
    || error instanceof AgentMessageRecipientOutsideProjectError
    || error instanceof AgentMessageReplyTargetNotFoundError
    || error instanceof AgentMessageReplyTargetOutsideProjectError
  ) {
    return { statusCode: 400, message: error.message };
  }

  if (error instanceof AgentMessageOutsideDirectHierarchyError) {
    return { statusCode: 403, message: error.message };
  }

  if (
    error instanceof AgentMessageSenderNotFoundError
    || error instanceof AgentMessageRecipientNotFoundError
    || error instanceof AgentMessageNotFoundError
    || error instanceof AgentMessageNotInAgentInboxError
  ) {
    return { statusCode: 404, message: error.message };
  }

  return null;
}

function mapProjectPermissionError(error: unknown): HttpErrorMapping | null {
  if (
    error instanceof ProjectAccessDeniedError
    || error instanceof ProjectManagementAccessRequiredError
  ) {
    return { statusCode: 403, message: error.message };
  }

  if (
    error instanceof ProjectAccessProjectNotFoundError
    || error instanceof AgentAccessAgentNotFoundError
    || error instanceof MessageAccessMessageNotFoundError
  ) {
    return { statusCode: 404, message: error.message };
  }

  return null;
}

function mapFrameworkError(error: unknown): HttpErrorMapping | null {
  if (!error || typeof error !== 'object') return null;
  const statusCode = (error as { statusCode?: unknown; status?: unknown }).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600) {
    return { statusCode, message: getErrorMessage(error) };
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return { statusCode: status, message: getErrorMessage(error) };
  }
  return null;
}

export function mapErrorToHttp(error: unknown): HttpErrorMapping | null {
  return mapKnowledgeError(error) || mapAgentMessageError(error) || mapProjectPermissionError(error) || mapFrameworkError(error);
}

export function getUnexpectedErrorMessage(error: unknown): string {
  return getErrorMessage(error);
}
