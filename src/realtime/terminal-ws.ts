import { FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import {
  getOrCreatePtySession,
  getPtyOutputBuffer,
  hasPtySession,
  killPtySession,
  PtySession,
} from '../services/terminal';
import logger from '../logger';
import {
  InvalidTerminalResizeError,
  InvalidWebSocketMessageError,
  TerminalUnavailableError,
  TerminalWriteError,
  UnknownWebSocketMessageTypeError,
} from './errors';
import { handleWebSocketError, withWebSocketErrorBoundary } from './error-boundary';
import { sendJson } from './hub';

interface PtyDisposable {
  dispose(): void;
}

export interface TerminalSocketOptions {
  newSession: boolean;
  cols: number;
  rows: number;
}

export interface TerminalSessionApi {
  getOrCreatePtySession(agentId: string, newSession: boolean, cols: number, rows: number): PtySession;
  getPtyOutputBuffer(agentId: string): string;
  hasPtySession(agentId: string): boolean;
  killPtySession(agentId: string): boolean;
}

const defaultTerminalSessionApi: TerminalSessionApi = {
  getOrCreatePtySession,
  getPtyOutputBuffer,
  hasPtySession,
  killPtySession,
};

// Map of agentId -> Set of connected terminal WebSocket clients.
const terminalClients = new Map<string, Set<WebSocket>>();
const ptyCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

const PTY_CLEANUP_DELAY_MS = 5 * 60 * 1000;

function parseTerminalMessage(raw: Buffer | string): any {
  try {
    const message = JSON.parse(raw.toString());
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      throw new InvalidWebSocketMessageError();
    }
    return message;
  } catch (error) {
    if (error instanceof InvalidWebSocketMessageError) throw error;
    throw new InvalidWebSocketMessageError('Malformed WebSocket JSON message');
  }
}

function getOpenSession(session: PtySession | null): PtySession {
  if (!session) throw new TerminalUnavailableError();
  return session;
}

function assertResizePayload(message: any): { cols: number; rows: number } {
  const cols = Number(message.cols);
  const rows = Number(message.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    throw new InvalidTerminalResizeError();
  }
  return { cols, rows };
}

function cancelPendingCleanup(agentId: string): void {
  const existingTimer = ptyCleanupTimers.get(agentId);
  if (!existingTimer) return;
  clearTimeout(existingTimer);
  ptyCleanupTimers.delete(agentId);
  logger.info(`PTY cleanup timer cancelled for agent ${agentId} — client reconnected`);
}

function addTerminalClient(agentId: string, socket: WebSocket): void {
  let clients = terminalClients.get(agentId);
  if (!clients) {
    clients = new Set();
    terminalClients.set(agentId, clients);
  }
  clients.add(socket);
}

function removeTerminalClient(agentId: string, socket: WebSocket, terminalApi: TerminalSessionApi): void {
  const clients = terminalClients.get(agentId);
  if (!clients) return;

  clients.delete(socket);
  if (clients.size > 0) return;

  terminalClients.delete(agentId);
  if (!terminalApi.hasPtySession(agentId)) return;

  logger.info(`All terminal clients disconnected for agent ${agentId}, PTY will be killed in ${PTY_CLEANUP_DELAY_MS / 1000}s`);
  const timer = setTimeout(() => {
    ptyCleanupTimers.delete(agentId);
    if (terminalApi.hasPtySession(agentId)) {
      logger.info(`Auto-killing PTY session for agent ${agentId} — no client reconnected`);
      terminalApi.killPtySession(agentId);
    }
  }, PTY_CLEANUP_DELAY_MS);
  ptyCleanupTimers.set(agentId, timer);
}

export function attachTerminalSocket(
  agentId: string,
  socket: WebSocket,
  request: FastifyRequest,
  options: TerminalSocketOptions,
  terminalApi: TerminalSessionApi = defaultTerminalSessionApi
): void {
  let session: PtySession | null = null;
  let onData: PtyDisposable | null = null;
  let onExit: PtyDisposable | null = null;
  let removed = false;

  const removeClient = () => {
    if (removed) return;
    removed = true;
    try {
      onData?.dispose();
      onExit?.dispose();
    } finally {
      removeTerminalClient(agentId, socket, terminalApi);
    }
  };

  socket.on('message', (raw: Buffer | string) => {
    withWebSocketErrorBoundary(socket, { request, defaultCode: 'terminal_error' }, () => {
      const message = parseTerminalMessage(raw);
      const activeSession = getOpenSession(session);

      switch (message.type) {
        case 'input':
          if (typeof message.data !== 'string') throw new InvalidWebSocketMessageError('Terminal input payload must include string data');
          try {
            activeSession.pty.write(message.data);
          } catch (error) {
            throw new TerminalWriteError(error instanceof Error ? error.message : undefined);
          }
          break;
        case 'resize': {
          const size = assertResizePayload(message);
          activeSession.pty.resize(size.cols, size.rows);
          break;
        }
        case 'kill':
          terminalApi.killPtySession(agentId);
          break;
        default:
          throw new UnknownWebSocketMessageTypeError(`Unknown terminal message type: ${message.type}`);
      }
    });
  });

  socket.on('close', removeClient);
  socket.on('error', removeClient);

  addTerminalClient(agentId, socket);
  cancelPendingCleanup(agentId);

  const hasExisting = terminalApi.hasPtySession(agentId);
  if (!sendJson(socket, {
    type: 'connected',
    agentId,
    hasExistingSession: hasExisting,
  })) {
    removeClient();
    return;
  }

  try {
    session = terminalApi.getOrCreatePtySession(agentId, options.newSession, options.cols, options.rows);
  } catch (error) {
    removeClient();
    handleWebSocketError(
      socket,
      error instanceof TerminalUnavailableError
        ? error
        : new TerminalUnavailableError(error instanceof Error ? error.message : undefined),
      { request, defaultCode: 'terminal_unavailable' }
    );
    return;
  }

  const bufferedOutput = terminalApi.getPtyOutputBuffer(agentId);
  if (bufferedOutput) {
    if (!sendJson(socket, {
      type: 'output',
      data: Buffer.from(bufferedOutput).toString('base64'),
    })) {
      removeClient();
      return;
    }
  }

  onData = session.pty.onData((data: string) => {
    if (!sendJson(socket, {
      type: 'output',
      data: Buffer.from(data).toString('base64'),
    })) {
      removeClient();
    }
  });

  onExit = session.pty.onExit(({ exitCode }) => {
    sendJson(socket, { type: 'exit', exitCode });
  });
}

export function clearAllPtyCleanupTimers(): void {
  for (const [, timer] of ptyCleanupTimers) {
    clearTimeout(timer);
  }
  ptyCleanupTimers.clear();
}
