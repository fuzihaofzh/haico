export class DashChatInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashChatInputError';
  }
}

export class DashChatCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashChatCommandError';
  }
}

export class DashChatCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashChatCliError';
  }
}

export class DashChatToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashChatToolError';
  }
}
