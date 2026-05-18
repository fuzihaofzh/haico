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
