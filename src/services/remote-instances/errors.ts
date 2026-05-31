export class RemoteInstanceNotFoundError extends Error {
  constructor() {
    super('Remote instance not found');
    this.name = 'RemoteInstanceNotFoundError';
  }
}

export class RemoteInstanceDisabledError extends Error {
  constructor() {
    super('Remote instance is disabled');
    this.name = 'RemoteInstanceDisabledError';
  }
}
