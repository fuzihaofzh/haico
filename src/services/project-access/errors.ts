export class ProjectAccessProjectNotFoundError extends Error {
  constructor() {
    super('Project not found');
    this.name = 'ProjectAccessProjectNotFoundError';
  }
}

export class ProjectAccessDeniedError extends Error {
  constructor() {
    super('Project access denied');
    this.name = 'ProjectAccessDeniedError';
  }
}

export class ProjectManagementAccessRequiredError extends Error {
  constructor() {
    super('Project management access required');
    this.name = 'ProjectManagementAccessRequiredError';
  }
}

export class AgentAccessAgentNotFoundError extends Error {
  constructor() {
    super('Agent not found');
    this.name = 'AgentAccessAgentNotFoundError';
  }
}

export class MessageAccessMessageNotFoundError extends Error {
  constructor() {
    super('Message not found');
    this.name = 'MessageAccessMessageNotFoundError';
  }
}
