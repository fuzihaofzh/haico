export class AuthenticationRequiredError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'AuthenticationRequiredError';
  }
}

export class NoAuthenticationConfiguredError extends Error {
  constructor() {
    super('No authentication configured. Visit /register to create the first account.');
    this.name = 'NoAuthenticationConfiguredError';
  }
}

export class DefaultAdminLoginDisabledError extends Error {
  constructor() {
    super('Default admin login is not enabled');
    this.name = 'DefaultAdminLoginDisabledError';
  }
}

export class DefaultAdminLoginLocalhostOnlyError extends Error {
  constructor() {
    super('Default admin login is only available from localhost');
    this.name = 'DefaultAdminLoginLocalhostOnlyError';
  }
}
