export class MissingCommandProfileNameError extends Error {
  constructor() {
    super('name is required');
    this.name = 'MissingCommandProfileNameError';
  }
}

export class MissingCommandProfileCommandError extends Error {
  constructor() {
    super('command is required');
    this.name = 'MissingCommandProfileCommandError';
  }
}

export class InvalidCommandProfileTypeError extends Error {
  constructor() {
    super('type is required and must be one of: claude, codex, gemini');
    this.name = 'InvalidCommandProfileTypeError';
  }
}

export class InvalidCommandProfileConfigJsonError extends Error {
  constructor(message: string = 'config_json must be a JSON object') {
    super(message);
    this.name = 'InvalidCommandProfileConfigJsonError';
  }
}

export class CommandProfileNotFoundError extends Error {
  constructor() {
    super('Command profile not found');
    this.name = 'CommandProfileNotFoundError';
  }
}

export class RemoteCommandProfileCheckError extends Error {
  constructor(
    message: string,
    readonly upstreamStatus: number,
    readonly upstreamData: any,
  ) {
    super(message);
    this.name = 'RemoteCommandProfileCheckError';
  }
}
