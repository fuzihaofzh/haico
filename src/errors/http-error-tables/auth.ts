import {
  AdminRoleRequiredError,
  AuthenticationRequiredError,
  DefaultAdminLoginDisabledError,
  DefaultAdminLoginLocalhostOnlyError,
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
  [
    DefaultAdminLoginDisabledError,
    (error) => ({ statusCode: 403, message: error.message }),
  ],
  [
    DefaultAdminLoginLocalhostOnlyError,
    (error) => ({ statusCode: 403, message: error.message }),
  ],
  [
    AdminRoleRequiredError,
    (error) => ({ statusCode: 403, message: error.message, redirect: '/overview' }),
  ],
] satisfies readonly ErrorHttpEntry[];
