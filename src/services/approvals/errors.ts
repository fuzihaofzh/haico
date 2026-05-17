export class MissingApprovalCreateFieldsError extends Error {
  constructor() {
    super('agent_id and title are required');
    this.name = 'MissingApprovalCreateFieldsError';
  }
}

export class InvalidApprovalDecisionStatusError extends Error {
  constructor() {
    super('status must be approved or rejected');
    this.name = 'InvalidApprovalDecisionStatusError';
  }
}

export class ApprovalAgentNotFoundError extends Error {
  constructor() {
    super('Agent not found in this project');
    this.name = 'ApprovalAgentNotFoundError';
  }
}

export class ApprovalNotFoundError extends Error {
  constructor() {
    super('Approval request not found');
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalAlreadyDecidedError extends Error {
  constructor() {
    super('Approval has already been decided');
    this.name = 'ApprovalAlreadyDecidedError';
  }
}
