import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

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
