import { it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { FastifyInstance } from 'fastify';
import { setupErrorHandler } from '../../src/middleware/error-handler';
import { InvalidKnowledgeStatusError } from '../../src/services/knowledge/errors';
import { InvalidIssueStatusError } from '../../src/services/issue/errors';
import { ProjectMetadataToolError } from '../../src/services/projects/errors';
import type { ToolReadinessSummary } from '../../src/services/tool-readiness';

const missingToolReadiness = {
  command: 'codex',
  command_type: null,
  tool_label: 'Codex CLI',
  binary: 'codex',
  binary_found: false,
  binary_path: null,
  ready: false,
  issues: [],
  auth: {
    status: 'missing',
    confidence: 'unknown',
    message: 'Authentication missing',
    action_command: 'codex login',
  },
} satisfies ToolReadinessSummary;

async function withErrorTestApp(
  nodeEnv: string | undefined,
  run: (app: FastifyInstance) => Promise<void>
): Promise<void> {
  const previousNodeEnv = process.env.NODE_ENV;
  if (nodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = nodeEnv;
  }

  const app = Fastify({ logger: false });
  setupErrorHandler(app);
  app.get('/domain-error', async () => {
    throw new InvalidKnowledgeStatusError({ includeAll: true });
  });
  app.get('/issue-domain-error', async () => {
    throw new InvalidIssueStatusError();
  });
  app.get('/metadata-tool-error', async () => {
    throw new ProjectMetadataToolError(
      'Metadata generation failed',
      'execution_failed',
      missingToolReadiness,
      'codex login'
    );
  });
  app.get('/unknown-error', async () => {
    throw new Error('database secret detail');
  });

  try {
    await run(app);
  } finally {
    await app.close();
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

it('global error handler maps domain errors to public API errors', async () => {
  await withErrorTestApp(undefined, async (app) => {
    const res = await app.inject('/domain-error');
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(body, { error: 'Invalid status. Must be one of: all, active, stale, archived' });
  });
});

it('global error handler maps issue domain errors to public API errors', async () => {
  await withErrorTestApp(undefined, async (app) => {
    const res = await app.inject('/issue-domain-error');
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(body, { error: 'Invalid status' });
  });
});

it('global error handler supports dynamic registered error mappings', async () => {
  await withErrorTestApp(undefined, async (app) => {
    const res = await app.inject('/metadata-tool-error');
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 500);
    assert.deepEqual(body, {
      error: 'Metadata generation failed',
      error_code: 'execution_failed',
      action_command: 'codex login',
      readiness: missingToolReadiness,
    });
  });
});

it('global error handler exposes unknown error messages outside production', async () => {
  await withErrorTestApp('development', async (app) => {
    const res = await app.inject('/unknown-error');
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 500);
    assert.deepEqual(body, { error: 'database secret detail' });
  });
});

it('global error handler masks unknown error messages in production', async () => {
  await withErrorTestApp('production', async (app) => {
    const res = await app.inject('/unknown-error');
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 500);
    assert.deepEqual(body, { error: 'Internal server error' });
  });
});
