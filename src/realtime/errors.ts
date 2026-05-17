export const WS_CLOSE_POLICY_VIOLATION = 1008;
export const WS_CLOSE_UNSUPPORTED_DATA = 1003;
export const WS_CLOSE_INTERNAL_ERROR = 1011;

export class WebSocketProtocolError extends Error {
  readonly code: string;
  readonly close: boolean;
  readonly closeCode: number;
  readonly expose: boolean;

  constructor(
    code: string,
    message: string,
    options: { close?: boolean; closeCode?: number; expose?: boolean } = {}
  ) {
    super(message);
    this.name = 'WebSocketProtocolError';
    this.code = code;
    this.close = options.close ?? false;
    this.closeCode = options.closeCode ?? WS_CLOSE_UNSUPPORTED_DATA;
    this.expose = options.expose ?? true;
  }
}

export class InvalidWebSocketMessageError extends WebSocketProtocolError {
  constructor(message = 'Invalid WebSocket message') {
    super('invalid_message', message, { close: false });
    this.name = 'InvalidWebSocketMessageError';
  }
}

export class UnknownWebSocketMessageTypeError extends WebSocketProtocolError {
  constructor(message = 'Unknown WebSocket message type') {
    super('unknown_message_type', message, { close: false });
    this.name = 'UnknownWebSocketMessageTypeError';
  }
}

export class InvalidTerminalResizeError extends WebSocketProtocolError {
  constructor(message = 'Invalid terminal resize payload') {
    super('invalid_resize', message, { close: false });
    this.name = 'InvalidTerminalResizeError';
  }
}

export class TerminalUnavailableError extends WebSocketProtocolError {
  constructor(message = 'Interactive terminal is unavailable') {
    super('terminal_unavailable', message, {
      close: true,
      closeCode: WS_CLOSE_INTERNAL_ERROR,
      expose: true,
    });
    this.name = 'TerminalUnavailableError';
  }
}

export class TerminalWriteError extends WebSocketProtocolError {
  constructor(message = 'Failed to write to terminal') {
    super('terminal_error', message, {
      close: true,
      closeCode: WS_CLOSE_INTERNAL_ERROR,
      expose: false,
    });
    this.name = 'TerminalWriteError';
  }
}
