import {
  InvalidProjectMemberRoleError,
  InvalidProjectOrchestratorEngineError,
  MissingProjectMetadataDescriptionError,
  MissingProjectTaskDescriptionError,
  ProjectDeleteBlockedError,
  ProjectDeleteForbiddenError,
  ProjectCommandProfileNotFoundError,
  ProjectMemberIdentityRequiredError,
  ProjectMemberNotFoundError,
  ProjectMetadataInvalidResponseError,
  ProjectMetadataToolError,
  ProjectNotFoundError,
  ProjectOwnerAlreadyHasAccessError,
  ProjectOwnerMutationError,
  ProjectUserNotFoundError,
} from '../../services/projects/errors';
import type { ErrorHttpEntry, HttpErrorMapping } from '../http-error-types';

function mapProjectMetadataToolError(error: ProjectMetadataToolError): HttpErrorMapping {
  return {
    statusCode: error.errorCode === 'execution_failed' ? 500 : 400,
    message: error.message,
    extra: {
      error_code: error.errorCode,
      action_command: error.actionCommand,
      readiness: error.readiness,
    },
  };
}

function mapProjectMetadataInvalidResponseError(
  error: ProjectMetadataInvalidResponseError
): HttpErrorMapping {
  return { statusCode: 500, message: error.message, extra: { raw: error.raw } };
}

export const projectErrorHttpEntries = [
  [MissingProjectTaskDescriptionError, 400],
  [InvalidProjectOrchestratorEngineError, 400],
  [ProjectMemberIdentityRequiredError, 400],
  [InvalidProjectMemberRoleError, 400],
  [ProjectOwnerAlreadyHasAccessError, 400],
  [ProjectOwnerMutationError, 400],
  [MissingProjectMetadataDescriptionError, 400],

  [ProjectMetadataToolError, mapProjectMetadataToolError],

  [ProjectNotFoundError, 404],
  [ProjectCommandProfileNotFoundError, 404],
  [ProjectUserNotFoundError, 404],
  [ProjectMemberNotFoundError, 404],

  [ProjectDeleteForbiddenError, 403],

  [ProjectDeleteBlockedError, 409],

  [ProjectMetadataInvalidResponseError, mapProjectMetadataInvalidResponseError],
] satisfies readonly ErrorHttpEntry[];
