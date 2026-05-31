import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import logger, { loggerOptions } from '../../src/logger';

class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString('utf8'));
    callback();
  }

  lines(): any[] {
    return this.chunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

async function waitForLogger(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('logger configuration', () => {
  it('emits string levels, gates debug by level, and redacts sensitive fields', async () => {
    const infoCapture = new CaptureStream();
    const infoLogger = pino({ ...loggerOptions, level: 'info' }, infoCapture);
    infoLogger.debug({ hidden: true }, 'debug.hidden');
    infoLogger.info({ visible: true }, 'info.visible');
    await waitForLogger();

    const infoLines = infoCapture.lines();
    assert.equal(infoLines.length, 1);
    assert.equal(infoLines[0].level, 'info');
    assert.equal(infoLines[0].message, 'info.visible');
    assert.equal(infoLines[0].visible, true);

    const debugCapture = new CaptureStream();
    const debugLogger = pino({ ...loggerOptions, level: 'debug' }, debugCapture);
    debugLogger.debug({
      password: 'secret-password',
      token: 'secret-token',
      api_token: 'secret-api-token',
      remote_password: 'secret-remote-password',
      headers: {
        authorization: 'Bearer secret',
        cookie: 'sid=secret',
      },
      req: {
        headers: {
          authorization: 'Bearer nested-secret',
          cookie: 'nested=sid',
        },
      },
    }, 'debug.visible');
    await waitForLogger();

    const debugLines = debugCapture.lines();
    assert.equal(debugLines.length, 1);
    assert.equal(debugLines[0].level, 'debug');
    assert.equal(debugLines[0].message, 'debug.visible');
    assert.equal(debugLines[0].password, '[Redacted]');
    assert.equal(debugLines[0].token, '[Redacted]');
    assert.equal(debugLines[0].api_token, '[Redacted]');
    assert.equal(debugLines[0].remote_password, '[Redacted]');
    assert.equal(debugLines[0].headers.authorization, '[Redacted]');
    assert.equal(debugLines[0].headers.cookie, '[Redacted]');
    assert.equal(debugLines[0].req.headers.authorization, '[Redacted]');
    assert.equal(debugLines[0].req.headers.cookie, '[Redacted]');
  });
});

describe('business event logging', () => {
  let dbPath = '';
  const originalInfo = logger.info;
  const originalWarn = logger.warn;
  const originalDebug = logger.debug;
  const events: Array<{ level: string; message: string; payload: any }> = [];

  function capture(level: string) {
    return (payload: unknown, message?: string) => {
      events.push({
        level,
        message: typeof payload === 'string' ? payload : String(message || ''),
        payload: typeof payload === 'string' ? {} : payload,
      });
    };
  }

  afterEach(async () => {
    logger.info = originalInfo;
    logger.warn = originalWarn;
    logger.debug = originalDebug;
    events.length = 0;
    const { clearCoalescingTimers } = await import('../../src/services/controller');
    clearCoalescingTimers();
    const { closeDatabase } = await import('../../src/db/database');
    closeDatabase();
    if (dbPath) {
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file);
        } catch {}
      }
      dbPath = '';
    }
  });

  it('records core project and issue business events', async () => {
    logger.info = capture('info') as any;
    logger.warn = capture('warn') as any;
    logger.debug = capture('debug') as any;

    dbPath = path.join(os.tmpdir(), `haico-logger-business-${process.pid}-${Date.now()}.db`);
    process.env.HAICO_DB_PATH = dbPath;
    process.env.HAICO_PORT = '0';

    const { getDatabase } = await import('../../src/db/database');
    const { createProject } = await import('../../src/services/projects');
    const { createIssue, updateIssue } = await import('../../src/services/issue');

    const db = getDatabase(dbPath, { skipStartupMaintenance: true });
    const project = createProject(
      db,
      {
        name: 'logging-project',
        task_description: 'verify business logging',
      },
      { user: null }
    );
    const projectId = project.id;

    const agents = db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY is_controller DESC, created_at').all(projectId) as any[];
    const worker = agents.find((agent: any) => !agent.is_controller);
    assert.ok(worker);

    const issue = createIssue(db, projectId, {
        title: 'Log issue event',
        body: 'This body should not be logged by the business event',
        created_by: worker.id,
    });

    const updatedIssue = updateIssue(db, issue.id, {
        actor: worker.id,
        status: 'in_progress',
    });
    assert.equal(updatedIssue.status, 'in_progress');
    assert.equal(updatedIssue.assigned_to, null);

    const messages = events.map((event) => event.message);
    assert.ok(messages.includes('project.created'));
    assert.ok(messages.includes('issue.created'));
    assert.ok(messages.includes('issue.updated'));

    const issueLog = events.find((event) => event.message === 'issue.created');
    assert.ok(issueLog);
    assert.equal(issueLog.payload.projectId, projectId);
    assert.equal(issueLog.payload.issueId, issue.id);
    assert.equal(issueLog.payload.body, undefined);
  });
});
