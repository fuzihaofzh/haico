import { InputValidationError } from '../../routes/prehandlers/input';
import type { ErrorHttpEntry } from '../http-error-types';

export const inputErrorHttpEntries = [
  [InputValidationError, 400],
] satisfies readonly ErrorHttpEntry[];
