import pino from 'pino';
import type { LoggerOptions } from 'pino';

type LogMethod = {
  (message: string, ...args: unknown[]): void;
  (payload: unknown, message?: string, ...args: unknown[]): void;
};

export interface AppLogger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

const redactPaths = [
  'password',
  'token',
  'api_token',
  'remote_password',
  'authorization',
  'cookie',
  '["set-cookie"]',
  '*.password',
  '*.token',
  '*.api_token',
  '*.remote_password',
  '*.authorization',
  '*.cookie',
  'body.password',
  'body.token',
  'body.api_token',
  'body.remote_password',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'request.headers.authorization',
  'request.headers.cookie',
  'request.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'reply.headers["set-cookie"]',
];

export const loggerOptions: LoggerOptions = {
  name: 'haico',
  level: process.env.HAICO_LOG_LEVEL || 'info',
  messageKey: 'message',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  redact: {
    paths: redactPaths,
    censor: '[Redacted]',
  },
};

const logger = pino(loggerOptions);

export default logger;
