export class PathOutsideRootError extends Error {
  constructor() {
    super('Path is outside the root directory');
  }
}

export class FileNotFoundError extends Error {
  constructor(public readonly path: string) {
    super('File not found');
  }
}

export class FileAccessDeniedError extends Error {
  constructor(public readonly path: string) {
    super('File access denied');
  }
}

export class FileOperationFailedError extends Error {
  constructor(public readonly path: string, cause?: string) {
    super(cause || 'File operation failed');
  }
}

export class DirectoryExpectedError extends Error {
  constructor(public readonly path: string) {
    super('Target path is not a directory');
  }
}

export class FileExpectedError extends Error {
  constructor(public readonly path: string) {
    super('Target path is not a file');
  }
}

export class FileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class BinaryFileError extends Error {
  constructor() {
    super('Cannot read binary file as text');
  }
}

export class PathResolutionError extends Error {
  constructor() {
    super('Failed to resolve path');
  }
}

export function isStorageProviderError(error: unknown): boolean {
  return error instanceof PathOutsideRootError
    || error instanceof FileNotFoundError
    || error instanceof FileAccessDeniedError
    || error instanceof FileOperationFailedError
    || error instanceof DirectoryExpectedError
    || error instanceof FileExpectedError
    || error instanceof FileTooLargeError
    || error instanceof BinaryFileError
    || error instanceof PathResolutionError;
}
