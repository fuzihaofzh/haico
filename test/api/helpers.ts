import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface ApiResponse {
  status: number;
  body: any;
  headers: Record<string, any>;
  raw: string;
}

export interface ApiRequestOptions {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
}

export interface InjectOptions extends ApiRequestOptions {
  url: string;
  payload?: any;
}

export interface ApiTestContext {
  readonly app: FastifyInstance;
  api(url: string, opts?: ApiRequestOptions): Promise<ApiResponse>;
  inject(opts: InjectOptions): Promise<any>;
  setAuthToken?(token: string | undefined): void;
}

export interface ApiTestHarness extends ApiTestContext {
  readonly dbPath: string;
  close(): Promise<void>;
}

export function inject(app: FastifyInstance, opts: InjectOptions) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return app.inject({
    method: (opts.method as any) || 'GET',
    url: opts.url,
    payload: opts.payload ?? opts.body,
    headers,
  });
}

export async function api(
  app: FastifyInstance,
  url: string,
  opts: ApiRequestOptions = {}
): Promise<ApiResponse> {
  const res = await inject(app, { url, ...opts });
  let body: any = {};
  try {
    body = JSON.parse(res.body);
  } catch {}
  return { status: res.statusCode, body, headers: res.headers, raw: res.body };
}

function removeDbFiles(dbPath: string): void {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

export async function createApiTestHarness(
  name: string
): Promise<ApiTestHarness> {
  const safeName = name
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const dbPath = path.join(
    os.tmpdir(),
    `haico-api-${safeName}-${process.pid}-${Date.now()}.db`
  );
  removeDbFiles(dbPath);

  process.env.HAICO_DB_PATH = dbPath;
  process.env.HAICO_PORT = '0';

  const { createApp, destroyApp } = await import('../../src/app');
  const app = await createApp({
    port: 0,
    host: '127.0.0.1',
    logger: false,
    skipScheduler: true,
  });
  let authToken: string | undefined;

  function withDefaultAuthHeaders(
    headers: Record<string, string> = {}
  ): Record<string, string> {
    const merged = { ...headers };
    if (
      authToken &&
      merged.cookie === undefined &&
      merged.authorization === undefined
    ) {
      merged.cookie = `haico-auth=${authToken}`;
    }
    return merged;
  }

  return {
    app,
    dbPath,
    api(url, opts = {}) {
      return api(app, url, {
        ...opts,
        headers: withDefaultAuthHeaders(opts.headers),
      });
    },
    inject(opts) {
      return inject(app, {
        ...opts,
        headers: withDefaultAuthHeaders(opts.headers),
      });
    },
    setAuthToken(token) {
      authToken = token;
    },
    async close() {
      await destroyApp(app);
      removeDbFiles(dbPath);
    },
  };
}

export async function createTestSession(
  ctx: ApiTestContext,
  password = 'test1234'
): Promise<string> {
  const username = `admin_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const register = await ctx.api('/api/auth/register', {
    method: 'POST',
    body: { username, password },
  });
  if (register.status !== 201 && register.status !== 409) {
    throw new Error(
      `Failed to register admin user: ${register.status} ${register.raw}`
    );
  }

  const login = await ctx.api('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  if (login.status !== 200 || !login.body.token) {
    throw new Error(
      `Failed to create auth session: ${login.status} ${login.raw}`
    );
  }
  ctx.setAuthToken?.(login.body.token);
  return login.body.token;
}
