export class MissingPaymentApprovalCreateFieldsError extends Error {
  constructor() {
    super('requested_by, title, and amount are required');
    this.name = 'MissingPaymentApprovalCreateFieldsError';
  }
}

export class InvalidPaymentApprovalAmountError extends Error {
  constructor() {
    super('amount must be a positive number');
    this.name = 'InvalidPaymentApprovalAmountError';
  }
}

export class PaymentApprovalNotFoundError extends Error {
  constructor() {
    super('Payment approval request not found');
    this.name = 'PaymentApprovalNotFoundError';
  }
}

export class MissingPaymentApprovalDecisionFieldsError extends Error {
  constructor() {
    super('decided_by and decision are required');
    this.name = 'MissingPaymentApprovalDecisionFieldsError';
  }
}

export class InvalidPaymentApprovalDecisionError extends Error {
  constructor() {
    super('decision must be "approve" or "reject"');
    this.name = 'InvalidPaymentApprovalDecisionError';
  }
}

export class PaymentApprovalAlreadyResolvedError extends Error {
  constructor(status: string) {
    super(`Payment approval already resolved with status: ${status}`);
    this.name = 'PaymentApprovalAlreadyResolvedError';
  }
}

export class PaymentApprovalSelfApprovalError extends Error {
  constructor() {
    super('Separation of duties violation: requester cannot approve their own payment');
    this.name = 'PaymentApprovalSelfApprovalError';
  }
}

export class PaymentApprovalDuplicateDecisionError extends Error {
  constructor() {
    super('This controller has already submitted a decision for this payment');
    this.name = 'PaymentApprovalDuplicateDecisionError';
  }
}

export class MissingPaymentApprovalCancelFieldsError extends Error {
  constructor() {
    super('cancelled_by is required');
    this.name = 'MissingPaymentApprovalCancelFieldsError';
  }
}

export class PaymentApprovalCancelStatusConflictError extends Error {
  constructor() {
    super('Only pending requests can be cancelled');
    this.name = 'PaymentApprovalCancelStatusConflictError';
  }
}

export class PaymentApprovalCancelForbiddenError extends Error {
  constructor() {
    super('Only the requester can cancel a payment approval');
    this.name = 'PaymentApprovalCancelForbiddenError';
  }
}
