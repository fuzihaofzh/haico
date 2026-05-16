import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { Agent, Project } from '../../src/types';

const TEST_DB = path.join(
  __dirname,
  `system-prompt-${process.pid}-${Date.now()}.db`
);
process.env.HAICO_DB_PATH = TEST_DB;
process.env.HAICO_PORT = '0';

describe('Worker prompt forbids asking user questions (#247/#248)', () => {
  let buildSystemPrompt: (agent: Agent, project: Project) => string;
  let closeDatabase: () => void;
  let project: Project;
  let worker: Agent;
  let controller: Agent;

  const cleanupDbFiles = () => {
    for (const file of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  };

  before(async () => {
    cleanupDbFiles();

    const database = await import('../../src/db/database');
    const prompt = await import('../../src/services/system-prompt');
    const db = database.getDatabase(TEST_DB);

    closeDatabase = database.closeDatabase;
    buildSystemPrompt = prompt.buildSystemPrompt;

    db.prepare(
      `
      INSERT INTO projects (id, name, description, task_description, command_template, command_type, orchestrator_engine, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      'prompt-project',
      'prompt-project',
      'Prompt project',
      'Test prompt constraints',
      'echo done',
      null,
      'langgraph',
      'active'
    );

    db.prepare(
      `
      INSERT INTO agents (id, project_id, name, role, is_controller, parent_agent_id, working_directory, custom_instructions, command_template, command_type, status, paused)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      'prompt-controller',
      'prompt-project',
      'controller',
      'controller',
      1,
      null,
      '/tmp/prompt',
      '',
      null,
      null,
      'idle',
      0
    );

    db.prepare(
      `
      INSERT INTO agents (id, project_id, name, role, is_controller, parent_agent_id, working_directory, custom_instructions, command_template, command_type, status, paused)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      'prompt-worker',
      'prompt-project',
      'worker',
      'worker',
      0,
      'prompt-controller',
      '/tmp/prompt',
      '',
      null,
      null,
      'idle',
      0
    );

    project = db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get('prompt-project') as Project;
    worker = db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get('prompt-worker') as Agent;
    controller = db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get('prompt-controller') as Agent;
  });

  after(() => {
    closeDatabase?.();
    cleanupDbFiles();
  });

  it('worker prompt contains 全自动运行模式 constraint', () => {
    const prompt = buildSystemPrompt(worker, project);
    assert.ok(
      prompt.includes('全自动运行模式'),
      'worker prompt must explain fully-autonomous mode'
    );
    assert.ok(
      prompt.includes('不能向用户提问寻求确认'),
      'worker prompt must forbid asking user for confirmation'
    );
  });

  it('worker prompt contains 禁止在评论中提问 constraint', () => {
    const prompt = buildSystemPrompt(worker, project);
    assert.ok(
      prompt.includes('禁止在评论中提问'),
      'worker prompt must forbid questions in comments'
    );
    assert.ok(
      prompt.includes('是否需要我先修复') || prompt.includes('请确认'),
      'worker prompt should include example phrases that are forbidden'
    );
  });

  it('worker prompt forbids silent completion without issue updates', () => {
    const prompt = buildSystemPrompt(worker, project);
    assert.ok(
      prompt.includes('禁止静默结束'),
      'worker prompt must explicitly forbid silent completion'
    );
    assert.ok(
      prompt.includes('更新 issue 状态'),
      'worker prompt must require a status update or equivalent issue activity'
    );
    assert.ok(
      prompt.includes(
        '不允许在 issue 没有任何状态变化、没有任何评论、没有任何后续 issue 的情况下直接结束'
      ),
      'worker prompt must forbid ending with no issue trace'
    );
  });

  it('worker prompt requires creating issue for user decisions', () => {
    const prompt = buildSystemPrompt(worker, project);
    assert.ok(
      prompt.includes('需要用户决策时的唯一正确做法'),
      'worker prompt must instruct to create issue for user decisions'
    );
    assert.ok(
      prompt.includes('assign 给 `user`') ||
        prompt.includes('assign 给 \\`user\\`'),
      'worker prompt must mention assigning to user'
    );
  });

  it('worker prompt does not contain old "ask questions" wording', () => {
    const prompt = buildSystemPrompt(worker, project);
    assert.ok(
      !prompt.includes('ask questions'),
      'old "ask questions" wording must be removed'
    );
  });

  it('controller prompt does not include worker-specific no-question constraints', () => {
    const prompt = buildSystemPrompt(controller, project);
    assert.ok(
      !prompt.includes('禁止在评论中提问'),
      'controller prompt should not have worker-specific comment restriction'
    );
    assert.ok(
      !prompt.includes('全自动运行模式'),
      'controller prompt should not have worker-specific autonomous mode constraint'
    );
  });
});
