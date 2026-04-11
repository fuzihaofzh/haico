import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { getOrCreatePtySession, hasPtySession, killPtySession, getPtyOutputBuffer } from './terminal';
import logger from '../logger';

// Map of agentId -> Set of connected WebSocket clients
const agentClients = new Map<string, Set<WebSocket>>();

// Map of projectId -> Set of connected WebSocket clients (project-level events)
const projectClients = new Map<string, Set<WebSocket>>();

// Map of agentId -> Set of connected terminal WebSocket clients
const terminalClients = new Map<string, Set<WebSocket>>();

// Map of agentId -> cleanup timer (auto-kill PTY after disconnect)
const ptyCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Auto-kill PTY session 5 minutes after last client disconnects
const PTY_CLEANUP_DELAY_MS = 5 * 60 * 1000;

export function setupWebSocket(fastify: FastifyInstance): void {
  // Per-agent terminal output stream
  fastify.get('/ws/agents/:id/terminal', { websocket: true }, (socket, request) => {
    const { id } = request.params as { id: string };

    if (!agentClients.has(id)) {
      agentClients.set(id, new Set());
    }
    agentClients.get(id)!.add(socket);

    socket.on('close', () => {
      const clients = agentClients.get(id);
      if (clients) {
        clients.delete(socket);
        if (clients.size === 0) {
          agentClients.delete(id);
        }
      }
    });

    socket.on('error', () => {
      const clients = agentClients.get(id);
      if (clients) {
        clients.delete(socket);
      }
    });

    socket.send(JSON.stringify({ type: 'connected', agentId: id }));
  });

  // Project-level event stream (agent status, issues, comments)
  fastify.get('/ws/projects/:id/events', { websocket: true }, (socket, request) => {
    const { id } = request.params as { id: string };

    if (!projectClients.has(id)) {
      projectClients.set(id, new Set());
    }
    projectClients.get(id)!.add(socket);

    socket.on('close', () => {
      const clients = projectClients.get(id);
      if (clients) {
        clients.delete(socket);
        if (clients.size === 0) {
          projectClients.delete(id);
        }
      }
    });

    socket.on('error', () => {
      const clients = projectClients.get(id);
      if (clients) {
        clients.delete(socket);
      }
    });

    socket.send(JSON.stringify({ type: 'connected', projectId: id }));
  });

  // Interactive PTY terminal for agent chat
  fastify.get('/ws/terminal/:agentId', { websocket: true }, (socket, request) => {
    const { agentId } = request.params as { agentId: string };
    const query = (request.query || {}) as { newSession?: string; cols?: string; rows?: string };
    const newSession = query.newSession === 'true';
    const cols = parseInt(query.cols || '120') || 120;
    const rows = parseInt(query.rows || '30') || 30;

    // Track terminal client connections
    if (!terminalClients.has(agentId)) {
      terminalClients.set(agentId, new Set());
    }
    terminalClients.get(agentId)!.add(socket);

    // Cancel any pending cleanup timer — a client reconnected
    const existingTimer = ptyCleanupTimers.get(agentId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      ptyCleanupTimers.delete(agentId);
      logger.info(`PTY cleanup timer cancelled for agent ${agentId} — client reconnected`);
    }

    // Check if session already exists
    const hasExisting = hasPtySession(agentId);

    socket.send(JSON.stringify({
      type: 'connected',
      agentId,
      hasExistingSession: hasExisting,
    }));

    // Create or resume PTY session
    const session = getOrCreatePtySession(agentId, newSession, cols, rows);

    // Replay buffered terminal content so the client immediately sees the
    // current screen even if it connected after PTY startup output.
    const bufferedOutput = getPtyOutputBuffer(agentId);
    if (bufferedOutput && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'output',
        data: Buffer.from(bufferedOutput).toString('base64'),
      }));
    }

    // Forward PTY output -> WebSocket (base64 encoded)
    const onData = session.pty.onData((data: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'output',
          data: Buffer.from(data).toString('base64'),
        }));
      }
    });

    const onExit = session.pty.onExit(({ exitCode }) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'exit', exitCode }));
      }
    });

    // Handle messages from browser
    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case 'input':
            session.pty.write(msg.data);
            break;
          case 'resize':
            if (msg.cols && msg.rows) {
              session.pty.resize(msg.cols, msg.rows);
            }
            break;
          case 'kill':
            killPtySession(agentId);
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    const removeClient = () => {
      onData.dispose();
      onExit.dispose();
      const clients = terminalClients.get(agentId);
      if (clients) {
        clients.delete(socket);
        // If no more clients connected, start cleanup timer
        if (clients.size === 0) {
          terminalClients.delete(agentId);
          if (hasPtySession(agentId)) {
            logger.info(`All terminal clients disconnected for agent ${agentId}, PTY will be killed in ${PTY_CLEANUP_DELAY_MS / 1000}s`);
            const timer = setTimeout(() => {
              ptyCleanupTimers.delete(agentId);
              if (hasPtySession(agentId)) {
                logger.info(`Auto-killing PTY session for agent ${agentId} — no client reconnected`);
                killPtySession(agentId);
              }
            }, PTY_CLEANUP_DELAY_MS);
            ptyCleanupTimers.set(agentId, timer);
          }
        }
      }
    };

    socket.on('close', removeClient);
    socket.on('error', removeClient);
  });
}

export function broadcastToAgent(agentId: string, data: object): void {
  const clients = agentClients.get(agentId);
  if (!clients) return;

  const message = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/**
 * Broadcast a project-level event to all connected clients.
 * Event types: agent_status, issue_created, issue_updated, comment_added
 */
export function broadcastToProject(projectId: string, event: ProjectEvent): void {
  const clients = projectClients.get(projectId);
  if (!clients) return;

  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

export function clearAllPtyCleanupTimers(): void {
  for (const [, timer] of ptyCleanupTimers) {
    clearTimeout(timer);
  }
  ptyCleanupTimers.clear();
}

export interface ProjectEvent {
  type: 'agent_status' | 'issue_created' | 'issue_updated' | 'comment_added' | 'agent_message' | 'approval_created' | 'approval_decided' | 'payment_approval_created' | 'payment_approval_decided' | 'payment_approval_resolved' | 'executive_summary_created' | 'executive_summary_updated' | 'executive_summary_deleted' | 'executive_summary_block_updated' | 'executive_summary_generated' | 'executive_summary_finalized';
  projectId: string;
  data: Record<string, any>;
}
