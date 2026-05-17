import {
  InvalidPaymentApprovalAmountError,
  InvalidPaymentApprovalDecisionError,
  MissingPaymentApprovalCancelFieldsError,
  MissingPaymentApprovalCreateFieldsError,
  MissingPaymentApprovalDecisionFieldsError,
  PaymentApprovalAlreadyResolvedError,
  PaymentApprovalCancelForbiddenError,
  PaymentApprovalCancelStatusConflictError,
  PaymentApprovalDuplicateDecisionError,
  PaymentApprovalNotFoundError,
  PaymentApprovalSelfApprovalError,
} from '../../services/payment-approvals/errors';
import type { ErrorHttpEntry } from '../http-error-types';

export const paymentApprovalErrorHttpEntries = [
  [MissingPaymentApprovalCreateFieldsError, 400],
  [InvalidPaymentApprovalAmountError, 400],
  [MissingPaymentApprovalDecisionFieldsError, 400],
  [InvalidPaymentApprovalDecisionError, 400],
  [MissingPaymentApprovalCancelFieldsError, 400],

  [PaymentApprovalSelfApprovalError, 403],
  [PaymentApprovalCancelForbiddenError, 403],

  [PaymentApprovalNotFoundError, 404],

  [PaymentApprovalAlreadyResolvedError, 409],
  [PaymentApprovalDuplicateDecisionError, 409],
  [PaymentApprovalCancelStatusConflictError, 409],
] satisfies readonly ErrorHttpEntry[];
