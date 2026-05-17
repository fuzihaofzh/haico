import { WebSocket } from 'ws';
import { WebSocketChannelHub, sendJson } from './hub';
import { ProjectEvent } from './protocol';

const projectEventHub = new WebSocketChannelHub();

export function attachProjectEventSocket(projectId: string, socket: WebSocket): void {
  const unsubscribe = projectEventHub.subscribe(projectId, socket);
  if (!sendJson(socket, { type: 'connected', projectId })) {
    unsubscribe();
  }
}

export function broadcastToProject(projectId: string, event: ProjectEvent): void {
  projectEventHub.publish(projectId, event);
}
