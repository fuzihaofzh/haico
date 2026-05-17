import { WebSocket } from 'ws';

export function sendJson(socket: WebSocket, payload: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;

  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export class WebSocketChannelHub {
  private readonly channels = new Map<string, Set<WebSocket>>();

  subscribe(channelId: string, socket: WebSocket): () => void {
    let clients = this.channels.get(channelId);
    if (!clients) {
      clients = new Set();
      this.channels.set(channelId, clients);
    }
    clients.add(socket);

    let removed = false;
    const unsubscribe = () => {
      if (removed) return;
      removed = true;
      socket.off('close', unsubscribe);
      socket.off('error', unsubscribe);
      const current = this.channels.get(channelId);
      if (!current) return;
      current.delete(socket);
      if (current.size === 0) this.channels.delete(channelId);
    };

    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
    return unsubscribe;
  }

  publish(channelId: string, payload: unknown): void {
    const clients = this.channels.get(channelId);
    if (!clients) return;

    for (const client of Array.from(clients)) {
      if (!sendJson(client, payload)) {
        clients.delete(client);
      }
    }

    if (clients.size === 0) this.channels.delete(channelId);
  }

  count(channelId: string): number {
    return this.channels.get(channelId)?.size || 0;
  }

  clear(): void {
    this.channels.clear();
  }
}
