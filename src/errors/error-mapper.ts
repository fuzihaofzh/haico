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
import {
  InvalidIssueRelationTypeError,
  InvalidIssueStatusError,
  InvalidReactionTargetTypeError,
  IssueCommentNotFoundError,
  IssueDeleteStatusConflictError,
  IssueHasChildrenDeleteConflictError,
  IssueNotFoundError,
  IssueParentNotFoundError,
  IssueParentProjectMismatchError,
  IssueRelationAlreadyExistsError,
  IssueRelationNotFoundError,
  MilestoneNotFoundError,
  MissingIssueCommentFieldsError,
  MissingIssueCreateFieldsError,
  MissingIssueRelationFieldsError,
  MissingMilestoneTitleError,
  MissingReactionFieldsError,
  SelfIssueRelationError,
  SourceIssueNotFoundError,
  TargetIssueNotFoundError,
  TargetIssueProjectMismatchError,
} from '../services/issue-errors';
import {
  AgentAlreadyPausedError,
  AgentAlreadyRunningError,
  AgentBinaryPreviewUnsupportedError,
  AgentDirectoryExpectedError,
  AgentFileAccessDeniedError,
  AgentFileContentTypeError,
  AgentFileExpectedError,
  AgentFileNotFoundError,
  AgentFileOperationFailedError,
  AgentFilePathRequiredError,
  AgentFileTooLargeError,
  AgentInvalidParentAssignmentError,
  AgentNameRequiredError,
  AgentNotFoundError,
  AgentNotPausedError,
  AgentPathOutsideWorkingDirectoryError,
  AgentPathResolutionError,
  AgentPausedError,
  AgentPreviewFileTypeUnsupportedError,
  AgentProjectNotFoundError,
  AgentPromptUnavailableError,
  AgentRetryPromptMissingError,
  AgentRunNotFoundError,
  AgentSQLiteFileUnsupportedError,
  AgentSQLiteTableNotFoundError,
  AgentUploadMissingFileError,
  AgentWorkingDirectoryRequiredError,
} from '../services/agents/errors';

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

function mapIssueError(error: unknown): HttpErrorMapping | null {
  if (
    error instanceof MissingIssueCreateFieldsError
    || error instanceof IssueParentNotFoundError
    || error instanceof IssueParentProjectMismatchError
    || error instanceof InvalidIssueStatusError
    || error instanceof MissingIssueCommentFieldsError
    || error instanceof InvalidReactionTargetTypeError
    || error instanceof MissingReactionFieldsError
    || error instanceof MissingMilestoneTitleError
    || error instanceof MissingIssueRelationFieldsError
    || error instanceof InvalidIssueRelationTypeError
    || error instanceof SelfIssueRelationError
    || error instanceof TargetIssueProjectMismatchError
  ) {
    return { statusCode: 400, message: error.message };
  }

  if (
    error instanceof IssueNotFoundError
    || error instanceof IssueCommentNotFoundError
    || error instanceof MilestoneNotFoundError
    || error instanceof SourceIssueNotFoundError
    || error instanceof TargetIssueNotFoundError
    || error instanceof IssueRelationNotFoundError
  ) {
    return { statusCode: 404, message: error.message };
  }

  if (
    error instanceof IssueDeleteStatusConflictError
    || error instanceof IssueHasChildrenDeleteConflictError
    || error instanceof IssueRelationAlreadyExistsError
  ) {
    return { statusCode: 409, message: error.message };
  }

  return null;
}

function mapAgentError(error: unknown): HttpErrorMapping | null {
  if (
    error instanceof AgentNameRequiredError
    || error instanceof AgentInvalidParentAssignmentError
    || error instanceof AgentPromptUnavailableError
    || error instanceof AgentRetryPromptMissingError
    || error instanceof AgentWorkingDirectoryRequiredError
    || error instanceof AgentPathOutsideWorkingDirectoryError
    || error instanceof AgentDirectoryExpectedError
    || error instanceof AgentFileExpectedError
    || error instanceof AgentFilePathRequiredError
    || error instanceof AgentFileContentTypeError
    || error instanceof AgentUploadMissingFileError
  ) {
    return { statusCode: 400, message: error.message };
  }

  if (error instanceof AgentFileAccessDeniedError) {
    return { statusCode: 403, message: error.message };
  }

  if (
    error instanceof AgentNotFoundError
    || error instanceof AgentProjectNotFoundError
    || error instanceof AgentFileNotFoundError
    || error instanceof AgentSQLiteTableNotFoundError
    || error instanceof AgentRunNotFoundError
  ) {
    return { statusCode: 404, message: error.message };
  }

  if (
    error instanceof AgentPausedError
    || error instanceof AgentAlreadyRunningError
    || error instanceof AgentAlreadyPausedError
    || error instanceof AgentNotPausedError
  ) {
    return { statusCode: 409, message: error.message };
  }

  if (error instanceof AgentFileTooLargeError) {
    return { statusCode: 413, message: error.message };
  }

  if (
    error instanceof AgentBinaryPreviewUnsupportedError
    || error instanceof AgentPreviewFileTypeUnsupportedError
    || error instanceof AgentSQLiteFileUnsupportedError
  ) {
    return { statusCode: 415, message: error.message };
  }

  if (
    error instanceof AgentPathResolutionError
    || error instanceof AgentFileOperationFailedError
  ) {
    return { statusCode: 500, message: error.message };
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
  return mapKnowledgeError(error) || mapAgentMessageError(error) || mapProjectPermissionError(error) || mapIssueError(error) || mapAgentError(error) || mapFrameworkError(error);
}

export function getUnexpectedErrorMessage(error: unknown): string {
  return getErrorMessage(error);
}
