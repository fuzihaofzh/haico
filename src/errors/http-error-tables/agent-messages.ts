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
} from '../../services/agents/message-errors';
import type { ErrorHttpEntry } from '../http-error-types';

export const agentMessageErrorHttpEntries = [
  [MissingAgentMessageRecipientError, 400],
  [MissingAgentMessageBodyError, 400],
  [AgentMessageRecipientOutsideProjectError, 400],
  [AgentMessageReplyTargetNotFoundError, 400],
  [AgentMessageReplyTargetOutsideProjectError, 400],

  [AgentMessageOutsideDirectHierarchyError, 403],

  [AgentMessageSenderNotFoundError, 404],
  [AgentMessageRecipientNotFoundError, 404],
  [AgentMessageNotFoundError, 404],
  [AgentMessageNotInAgentInboxError, 404],
] satisfies readonly ErrorHttpEntry[];
