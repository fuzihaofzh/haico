import {
  CommandProfileNotFoundError,
  InvalidCommandProfileConfigJsonError,
  InvalidCommandProfileTypeError,
  MissingCommandProfileCommandError,
  MissingCommandProfileNameError,
  RemoteCommandProfileCheckError,
} from '../../services/command-profiles/errors';
import type { ErrorHttpEntry, HttpErrorMapping } from '../http-error-types';

function mapRemoteCommandProfileCheckError(error: RemoteCommandProfileCheckError): HttpErrorMapping {
  return {
    statusCode: error.upstreamStatus >= 400 && error.upstreamStatus < 600 ? error.upstreamStatus : 502,
    message: error.message,
  };
}

export const commandProfileErrorHttpEntries = [
  [MissingCommandProfileNameError, 400],
  [MissingCommandProfileCommandError, 400],
  [InvalidCommandProfileTypeError, 400],
  [InvalidCommandProfileConfigJsonError, 400],

  [CommandProfileNotFoundError, 404],

  [RemoteCommandProfileCheckError, mapRemoteCommandProfileCheckError],
] satisfies readonly ErrorHttpEntry[];
