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
} from '../../services/knowledge/errors';
import type { ErrorHttpEntry } from '../http-error-types';

export const knowledgeErrorHttpEntries = [
  [MissingKnowledgeTitleError, 400],
  [MissingKnowledgeContentError, 400],
  [InvalidKnowledgeImportanceError, 400],
  [InvalidKnowledgeCategoryError, 400],
  [InvalidKnowledgeStatusError, 400],
  [InvalidKnowledgeOwnerAgentError, 400],

  [KnowledgeEntryNotFoundError, 404],
  [KnowledgeAgentNotFoundError, 404],

  [DuplicateOwnerKnowledgeEntryError, 409],
] satisfies readonly ErrorHttpEntry[];
