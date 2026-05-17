import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createApiTestHarness } from './helpers';
import { broadcastToAgent, broadcastToProject } from '../../src/realtime';
import {
  attachTerminalSocket,
  clearAllPtyCleanupTimers,
  TerminalSessionApi,
} from '../../src/realtime/terminal-ws';

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

let uniqueUserCounter = 0;

function uniqueUsername(prefix: string): string {
  uniqueUserCounter += 1;
  return `${prefix}${process.pid}${uniqueUserCounter}`.slice(0, 32);
}

async function registerTestUser(
  ctx: Awaited<ReturnType<typeof createApiTestHarness>>,
  usernamePrefix: string
): Promise<{ token: string; username: string }> {
  const username = uniqueUsername(usernamePrefix);
  const user = await ctx.api('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'test1234' },
  });
  assert.equal(user.status, 201);
  assert.ok(user.body.token);
  return { token: user.body.token, username };
}

async function connectWs(
  ctx: Awaited<ReturnType<typeof createApiTestHarness>>,
  path: string,
  headers?: Record<string, string>
): Promise<{ ws: WebSocket; nextJson(): Promise<any> }> {
  const messages: any[] = [];
  const waiters: Array<(message: any) => void> = [];

  const ws = await ctx.app.injectWS(path, { headers }, {
    onInit(client) {
      client.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        const waiter = waiters.shift();
        if (waiter) waiter(parsed);
        else messages.push(parsed);
      });
    },
  });

  return {
    ws,
    nextJson() {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 1000);
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
        ws.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    },
  };
}

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: any[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

function createFakeTerminalApi(options: { failCreate?: boolean } = {}): TerminalSessionApi {
  const session = {
    agentId: 'agent-1',
    createdAt: Date.now(),
    outputBuffer: '',
    pty: {
      write() {},
      resize() {},
      kill() {},
      onData() {
        return { dispose() {} };
      },
      onExit() {
        return { dispose() {} };
      },
    },
  } as any;

  return {
    getOrCreatePtySession() {
      if (options.failCreate) throw new Error('node-pty unavailable in test');
      return session;
    },
    getPtyOutputBuffer() {
      return '';
    },
    hasPtySession() {
      return !options.failCreate;
    },
    killPtySession() {
      return true;
    },
  };
}

describe('WebSocket realtime routes', () => {
  it('streams project events and agent output events', async () => {
    const ctx = await createApiTestHarness('websocket-streams');
    try {
      const admin = await registerTestUser(ctx, 'wsstreams');
      const project = await ctx.api('/api/projects', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name: 'ws-project',
          description: 'websocket test project',
          task_description: 'test websocket events',
          command_template: 'echo',
        },
      });
      assert.equal(project.status, 201);

      const agent = await ctx.api(`/api/projects/${project.body.id}/agents`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { name: 'ws-worker', role: 'Worker' },
      });
      assert.equal(agent.status, 201);

      const projectConnection = await connectWs(ctx, `/ws/projects/${project.body.id}/events`, authHeaders(admin.token));
      assert.deepEqual(await projectConnection.nextJson(), {
        type: 'connected',
        projectId: project.body.id,
      });

      broadcastToProject(project.body.id, {
        type: 'issue_updated',
        projectId: project.body.id,
        data: { issueId: 'issue-1' },
      });
      assert.deepEqual(await projectConnection.nextJson(), {
        type: 'issue_updated',
        projectId: project.body.id,
        data: { issueId: 'issue-1' },
      });
      projectConnection.ws.terminate();

      const agentConnection = await connectWs(ctx, `/ws/agents/${agent.body.id}/terminal`, authHeaders(admin.token));
      assert.deepEqual(await agentConnection.nextJson(), {
        type: 'connected',
        agentId: agent.body.id,
      });

      broadcastToAgent(agent.body.id, {
        type: 'output',
        stream: 'stdout',
        content: 'hello',
        runId: 'run-1',
      });
      assert.deepEqual(await agentConnection.nextJson(), {
        type: 'output',
        stream: 'stdout',
        content: 'hello',
        runId: 'run-1',
      });
      agentConnection.ws.terminate();
    } finally {
      await ctx.close();
    }
  });

  it('rejects missing resources before WebSocket upgrade', async () => {
    const ctx = await createApiTestHarness('websocket-missing-resources');
    try {
      const admin = await registerTestUser(ctx, 'wsmissing');
      await assert.rejects(
        ctx.app.injectWS('/ws/projects/missing/events', { headers: authHeaders(admin.token) }),
        /Unexpected server response: 404/
      );
      await assert.rejects(
        ctx.app.injectWS('/ws/agents/missing/terminal', { headers: authHeaders(admin.token) }),
        /Unexpected server response: 404/
      );
      await assert.rejects(
        ctx.app.injectWS('/ws/terminal/missing', { headers: authHeaders(admin.token) }),
        /Unexpected server response: 404/
      );
    } finally {
      await ctx.close();
    }
  });

  it('allows read sockets for project members but requires manage access for interactive terminal', async () => {
    const ctx = await createApiTestHarness('websocket-permissions');
    try {
      const owner = await registerTestUser(ctx, 'wsowner');
      const member = await registerTestUser(ctx, 'wsmember');

      const project = await ctx.api('/api/projects', {
        method: 'POST',
        headers: authHeaders(owner.token),
        body: {
          name: 'ws-shared-project',
          description: 'shared websocket test project',
          task_description: 'test websocket permissions',
          command_template: 'echo',
        },
      });
      assert.equal(project.status, 201);

      const share = await ctx.api(`/api/projects/${project.body.id}/members`, {
        method: 'POST',
        headers: authHeaders(owner.token),
        body: { username: member.username, role: 'member' },
      });
      assert.equal(share.status, 201);

      const agent = await ctx.api(`/api/projects/${project.body.id}/agents`, {
        method: 'POST',
        headers: authHeaders(owner.token),
        body: { name: 'ws-shared-worker', role: 'Worker' },
      });
      assert.equal(agent.status, 201);

      const readConnection = await connectWs(
        ctx,
        `/ws/agents/${agent.body.id}/terminal`,
        authHeaders(member.token)
      );
      assert.deepEqual(await readConnection.nextJson(), {
        type: 'connected',
        agentId: agent.body.id,
      });
      readConnection.ws.terminate();

      await assert.rejects(
        ctx.app.injectWS(`/ws/terminal/${agent.body.id}`, {
          headers: authHeaders(member.token),
        }),
        /Unexpected server response: 403/
      );
    } finally {
      await ctx.close();
    }
  });
});

describe('Terminal WebSocket error boundary', () => {
  afterEach(() => {
    clearAllPtyCleanupTimers();
  });

  it('maps malformed and unknown terminal messages without closing the socket', () => {
    const socket = new FakeSocket();
    attachTerminalSocket(
      'agent-1',
      socket as any,
      { log: { warn() {}, error() {} } } as any,
      { newSession: false, cols: 120, rows: 30 },
      createFakeTerminalApi()
    );

    socket.emit('message', Buffer.from('{not-json'));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'bogus' })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 0, rows: 20 })));

    assert.equal(socket.closed, null);
    assert.ok(socket.sent.some((message) => message.type === 'error' && message.code === 'invalid_message'));
    assert.ok(socket.sent.some((message) => message.type === 'error' && message.code === 'unknown_message_type'));
    assert.ok(socket.sent.some((message) => message.type === 'error' && message.code === 'invalid_resize'));
  });

  it('maps PTY creation failure and closes the socket', () => {
    const socket = new FakeSocket();
    attachTerminalSocket(
      'agent-1',
      socket as any,
      { log: { warn() {}, error() {} } } as any,
      { newSession: false, cols: 120, rows: 30 },
      createFakeTerminalApi({ failCreate: true })
    );

    assert.ok(socket.sent.some((message) => message.type === 'error' && message.code === 'terminal_unavailable'));
    assert.equal(socket.closed?.code, 1011);
  });
});
