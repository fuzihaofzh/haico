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

export class AgentWorkingDirectoryRequiredError extends Error {
  constructor() {
    super('Agent does not have a working_directory configured');
  }
}

export class AgentPathOutsideWorkingDirectoryError extends Error {
  constructor() {
    super('Path is outside the working_directory');
  }
}

export class AgentPathResolutionError extends Error {
  constructor() {
    super('Failed to resolve path');
  }
}

export class AgentFileNotFoundError extends Error {
  constructor() {
    super('File not found');
  }
}

export class AgentFileAccessDeniedError extends Error {
  constructor() {
    super('File access denied');
  }
}

export class AgentFileOperationFailedError extends Error {
  constructor() {
    super('File operation failed');
  }
}

export class AgentDirectoryExpectedError extends Error {
  constructor() {
    super('Target path is not a directory');
  }
}

export class AgentFileExpectedError extends Error {
  constructor() {
    super('Target path is not a file');
  }
}

export class AgentFilePathRequiredError extends Error {
  constructor() {
    super('path is required');
  }
}

export class AgentFileContentTypeError extends Error {
  constructor() {
    super('content must be a string');
  }
}

export class AgentFileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class AgentBinaryPreviewUnsupportedError extends Error {
  constructor() {
    super('Cannot preview binary files');
  }
}

export class AgentPreviewFileTypeUnsupportedError extends Error {
  constructor() {
    super('This file type cannot be served for preview');
  }
}

export class AgentUploadMissingFileError extends Error {
  constructor() {
    super('No files uploaded');
  }
}

export class AgentSQLiteFileUnsupportedError extends Error {
  constructor() {
    super('Not a SQLite file');
  }
}

export class AgentSQLiteTableNotFoundError extends Error {
  constructor(tableName: string) {
    super(`Table "${tableName}" not found`);
  }
}

export class AgentRunNotFoundError extends Error {
  constructor() {
    super('Run not found');
  }
}
