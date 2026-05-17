import {
  AgentAccessAgentNotFoundError,
  MessageAccessMessageNotFoundError,
  ProjectAccessDeniedError,
  ProjectAccessProjectNotFoundError,
  ProjectManagementAccessRequiredError,
} from '../../services/project-access';
import type { ErrorHttpEntry } from '../http-error-types';

export const projectAccessErrorHttpEntries = [
  [ProjectAccessDeniedError, 403],
  [ProjectManagementAccessRequiredError, 403],

  [ProjectAccessProjectNotFoundError, 404],
  [AgentAccessAgentNotFoundError, 404],
  [MessageAccessMessageNotFoundError, 404],
] satisfies readonly ErrorHttpEntry[];
