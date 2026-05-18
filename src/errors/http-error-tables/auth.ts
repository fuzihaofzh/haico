import {
  AuthenticationRequiredError,
  NoAuthenticationConfiguredError,
} from '../../services/auth/errors';
import type { ErrorHttpEntry } from '../http-error-types';

export const authErrorHttpEntries = [
  [
    AuthenticationRequiredError,
    (error) => ({ statusCode: 401, message: error.message, redirect: '/login' }),
  ],
  [
    NoAuthenticationConfiguredError,
    (error) => ({ statusCode: 401, message: error.message, redirect: '/register' }),
  ],
] satisfies readonly ErrorHttpEntry[];
