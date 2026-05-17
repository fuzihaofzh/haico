import { WebSocket } from 'ws';
import { WebSocketChannelHub, sendJson } from './hub';
import { AgentOutputEvent } from './protocol';

const agentOutputHub = new WebSocketChannelHub();

export function attachAgentOutputSocket(agentId: string, socket: WebSocket): void {
  const unsubscribe = agentOutputHub.subscribe(agentId, socket);
  if (!sendJson(socket, { type: 'connected', agentId })) {
    unsubscribe();
  }
}

export function broadcastToAgent(agentId: string, data: AgentOutputEvent | object): void {
  agentOutputHub.publish(agentId, data);
}
