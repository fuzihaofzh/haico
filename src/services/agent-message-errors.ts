export class MissingAgentMessageRecipientError extends Error {
  constructor() {
    super('to and body are required');
    this.name = 'MissingAgentMessageRecipientError';
  }
}

export class MissingAgentMessageBodyError extends Error {
  constructor() {
    super('to and body are required');
    this.name = 'MissingAgentMessageBodyError';
  }
}

export class AgentMessageSenderNotFoundError extends Error {
  constructor() {
    super('Sender agent not found');
    this.name = 'AgentMessageSenderNotFoundError';
  }
}

export class AgentMessageRecipientNotFoundError extends Error {
  constructor() {
    super('Recipient agent not found');
    this.name = 'AgentMessageRecipientNotFoundError';
  }
}

export class AgentMessageRecipientOutsideProjectError extends Error {
  constructor() {
    super('Recipient agent must belong to the same project');
    this.name = 'AgentMessageRecipientOutsideProjectError';
  }
}

export class AgentMessageOutsideDirectHierarchyError extends Error {
  constructor() {
    super('只能与直接上级或下属通信');
    this.name = 'AgentMessageOutsideDirectHierarchyError';
  }
}

export class AgentMessageReplyTargetNotFoundError extends Error {
  constructor() {
    super('reply_to message not found');
    this.name = 'AgentMessageReplyTargetNotFoundError';
  }
}

export class AgentMessageReplyTargetOutsideProjectError extends Error {
  constructor() {
    super('reply_to message must belong to the same project');
    this.name = 'AgentMessageReplyTargetOutsideProjectError';
  }
}

export class AgentMessageNotFoundError extends Error {
  constructor() {
    super('Message not found');
    this.name = 'AgentMessageNotFoundError';
  }
}

export class AgentMessageNotInAgentInboxError extends Error {
  constructor() {
    super('Message not found');
    this.name = 'AgentMessageNotInAgentInboxError';
  }
}
