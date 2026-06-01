export class AgentNameRequiredError extends Error {
  constructor() {
    super('name is required');
  }
}

export class AgentNotFoundError extends Error {
  constructor() {
    super('Agent not found');
  }
}

export class AgentProjectNotFoundError extends Error {
  constructor(message = 'Project not found') {
    super(message);
  }
}

export class AgentCommandProfileNotFoundError extends Error {
  constructor() {
    super('Command profile not found');
  }
}

export class AgentInvalidParentAssignmentError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class AgentPausedError extends Error {
  constructor() {
    super('Agent is paused. Unpause it first.');
  }
}

export class AgentAlreadyRunningError extends Error {
  constructor() {
    super('Agent is already running');
  }
}

export class AgentPromptUnavailableError extends Error {
  constructor() {
    super('No prompt could be generated. Set agent role or project task_description.');
  }
}

export class AgentRetryPromptMissingError extends Error {
  constructor() {
    super('No previous prompt to retry. Use start instead.');
  }
}

export class AgentAlreadyPausedError extends Error {
  constructor() {
    super('Agent is already paused');
  }
}

export class AgentNotPausedError extends Error {
  constructor() {
    super('Agent is not paused');
  }
}

export class AgentRunNotFoundError extends Error {
  constructor() {
    super('Run not found');
  }
}
