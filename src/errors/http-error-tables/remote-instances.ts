import { RemoteInstanceNotFoundError, RemoteInstanceDisabledError } from '../../services/remote-instances/errors';
import type { ErrorHttpEntry } from '../http-error-types';

export const remoteInstancesErrorHttpEntries = [
  [RemoteInstanceNotFoundError, 404],
  [RemoteInstanceDisabledError, 400],
] satisfies readonly ErrorHttpEntry[];
