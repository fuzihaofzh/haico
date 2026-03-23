import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { getOrCreatePtySession, hasPtySession, killPtySession } from './terminal';

// Map of agentId -> Set of connected WebSocket clients
const agentClients = new Map<string, Set<WebSocket>>();

// Map of projectId -> Set of connected WebSocket clients (project-level events)
const projectClients = new Map<string, Set<WebSocket>>();

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

    // Check if session already exists
    const hasExisting = hasPtySession(agentId);

    socket.send(JSON.stringify({
      type: 'connected',
      agentId,
      hasExistingSession: hasExisting,
    }));

    // Create or resume PTY session
    const session = getOrCreatePtySession(agentId, newSession, cols, rows);

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

    socket.on('close', () => {
      onData.dispose();
      onExit.dispose();
      // Don't kill PTY on disconnect — allow reconnect
    });

    socket.on('error', () => {
      onData.dispose();
      onExit.dispose();
    });
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

export interface ProjectEvent {
  type: 'agent_status' | 'issue_created' | 'issue_updated' | 'comment_added';
  projectId: string;
  data: Record<string, any>;
}
