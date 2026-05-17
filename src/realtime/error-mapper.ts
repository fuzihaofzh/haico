import {
  AgentAccessAgentNotFoundError,
  ProjectAccessDeniedError,
  ProjectAccessProjectNotFoundError,
  ProjectManagementAccessRequiredError,
} from '../services/project-access';
import {
  WS_CLOSE_INTERNAL_ERROR,
  WS_CLOSE_POLICY_VIOLATION,
  WebSocketProtocolError,
} from './errors';
import { RealtimeErrorMessage } from './protocol';

export interface WebSocketErrorMapping {
  message: RealtimeErrorMessage;
  close: boolean;
  closeCode: number;
}

export interface WebSocketErrorMappingOptions {
  defaultCode?: string;
  defaultMessage?: string;
  close?: boolean;
  closeCode?: number;
}

function isDebugWebSocketErrorsEnabled(): boolean {
  return process.env.HAICO_DEBUG_WS === 'true' || process.env.NODE_ENV !== 'production';
}

function messageFor(error: unknown, fallback: string, expose: boolean): string {
  if (!expose && !isDebugWebSocketErrorsEnabled()) return fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function mapWebSocketError(
  error: unknown,
  options: WebSocketErrorMappingOptions = {}
): WebSocketErrorMapping {
  if (error instanceof WebSocketProtocolError) {
    return {
      message: {
        type: 'error',
        code: error.code,
        message: messageFor(error, 'WebSocket protocol error', error.expose),
      },
      close: error.close,
      closeCode: error.closeCode,
    };
  }

  if (
    error instanceof ProjectAccessDeniedError ||
    error instanceof ProjectManagementAccessRequiredError
  ) {
    return {
      message: {
        type: 'error',
        code: 'forbidden',
        message: messageFor(error, 'WebSocket access denied', true),
      },
      close: true,
      closeCode: WS_CLOSE_POLICY_VIOLATION,
    };
  }

  if (
    error instanceof ProjectAccessProjectNotFoundError ||
    error instanceof AgentAccessAgentNotFoundError
  ) {
    return {
      message: {
        type: 'error',
        code: 'not_found',
        message: messageFor(error, 'WebSocket resource not found', true),
      },
      close: true,
      closeCode: WS_CLOSE_POLICY_VIOLATION,
    };
  }

  const fallback = options.defaultMessage || 'Internal websocket error';
  return {
    message: {
      type: 'error',
      code: options.defaultCode || 'websocket_error',
      message: messageFor(error, fallback, false),
    },
    close: options.close ?? true,
    closeCode: options.closeCode ?? WS_CLOSE_INTERNAL_ERROR,
  };
}
