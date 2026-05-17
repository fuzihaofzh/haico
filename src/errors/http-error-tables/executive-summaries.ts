import {
  DuplicateExecutiveSummaryBlockKeyError,
  ExecutiveSummaryAlreadyFinalizedError,
  ExecutiveSummaryArchivedFinalizeError,
  ExecutiveSummaryBlockNotFoundError,
  ExecutiveSummaryNotFoundError,
  InvalidExecutiveSummaryStatusError,
  MissingExecutiveSummaryBlockCreateFieldsError,
  MissingExecutiveSummaryCreateFieldsError,
  NoValidExecutiveSummaryUpdateFieldsError,
} from '../../services/executive-summaries/errors';
import type { ErrorHttpEntry } from '../http-error-types';

export const executiveSummaryErrorHttpEntries = [
  [MissingExecutiveSummaryCreateFieldsError, 400],
  [MissingExecutiveSummaryBlockCreateFieldsError, 400],
  [InvalidExecutiveSummaryStatusError, 400],
  [NoValidExecutiveSummaryUpdateFieldsError, 400],

  [ExecutiveSummaryNotFoundError, 404],
  [ExecutiveSummaryBlockNotFoundError, 404],

  [DuplicateExecutiveSummaryBlockKeyError, 409],
  [ExecutiveSummaryAlreadyFinalizedError, 409],
  [ExecutiveSummaryArchivedFinalizeError, 409],
] satisfies readonly ErrorHttpEntry[];
