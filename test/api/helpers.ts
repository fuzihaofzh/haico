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
}

export interface ApiTestContext {
  readonly app: FastifyInstance;
  api(url: string, opts?: ApiRequestOptions): Promise<ApiResponse>;
  inject(opts: InjectOptions): Promise<any>;
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
    payload: opts.body,
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

  return {
    app,
    dbPath,
    api(url, opts = {}) {
      return api(app, url, opts);
    },
    inject(opts) {
      return inject(app, opts);
    },
    async close() {
      await destroyApp(app);
      removeDbFiles(dbPath);
    },
  };
}

export async function createSinglePasswordSession(
  ctx: ApiTestContext,
  password = 'test1234'
): Promise<string> {
  const setup = await ctx.api('/api/auth/setup', {
    method: 'POST',
    body: { password },
  });
  if (setup.status !== 200 && setup.status !== 403) {
    throw new Error(
      `Failed to set up auth password: ${setup.status} ${setup.raw}`
    );
  }

  const login = await ctx.api('/api/auth', {
    method: 'POST',
    body: { password },
  });
  if (login.status !== 200 || !login.body.token) {
    throw new Error(
      `Failed to create auth session: ${login.status} ${login.raw}`
    );
  }
  return login.body.token;
}
