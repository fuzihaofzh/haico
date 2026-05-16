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
  return mapKnowledgeError(error) || mapFrameworkError(error);
}

export function getUnexpectedErrorMessage(error: unknown): string {
  return getErrorMessage(error);
}
