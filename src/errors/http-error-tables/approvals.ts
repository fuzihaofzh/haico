import {
  ApprovalAgentNotFoundError,
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  InvalidApprovalDecisionStatusError,
  MissingApprovalCreateFieldsError,
} from '../../services/approvals/errors';
import type { ErrorHttpEntry } from '../http-error-types';

export const approvalErrorHttpEntries = [
  [MissingApprovalCreateFieldsError, 400],
  [InvalidApprovalDecisionStatusError, 400],

  [ApprovalAgentNotFoundError, 404],
  [ApprovalNotFoundError, 404],

  [ApprovalAlreadyDecidedError, 409],
] satisfies readonly ErrorHttpEntry[];
