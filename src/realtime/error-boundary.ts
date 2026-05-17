import { FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { mapWebSocketError, WebSocketErrorMappingOptions } from './error-mapper';
import { sendJson } from './hub';

export interface WebSocketErrorContext extends WebSocketErrorMappingOptions {
  request?: FastifyRequest;
}

export function handleWebSocketError(
  socket: WebSocket,
  error: unknown,
  context: WebSocketErrorContext = {}
): void {
  const mapped = mapWebSocketError(error, context);
  const logger = context.request?.log;

  if (mapped.close) {
    logger?.error({ err: error, wsErrorCode: mapped.message.code }, 'WebSocket connection failed');
  } else {
    logger?.warn({ err: error, wsErrorCode: mapped.message.code }, 'WebSocket protocol error');
  }

  sendJson(socket, mapped.message);

  if (mapped.close && socket.readyState === WebSocket.OPEN) {
    try {
      socket.close(mapped.closeCode, mapped.message.code);
    } catch {
      socket.terminate();
    }
  }
}

export function withWebSocketErrorBoundary(
  socket: WebSocket,
  context: WebSocketErrorContext,
  handler: () => void
): void {
  try {
    handler();
  } catch (error) {
    handleWebSocketError(socket, error, context);
  }
}
