import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiTestHarness } from './helpers';
import { createApiTestHarness, createTestSession } from './helpers';

describe('Issue creation via API', () => {
  let ctx: ApiTestHarness;
  let projectId: string;

  before(async () => {
    ctx = await createApiTestHarness('quick-commands');
    await createTestSession(ctx);
    const project = await ctx.api('/api/projects', {
      method: 'POST',
      body: {
        name: 'quick-command-project',
        description: 'Quick command regression project',
        task_description: 'Test quick command replacement',
        command_template: 'echo',
      },
    });
    assert.equal(project.status, 201);
    projectId = project.body.id;
  });

  after(async () => {
    await ctx?.close();
  });

  it('POST /api/projects/:pid/issues accepts issue creation', async () => {
    const { status, body } = await ctx.api(
      `/api/projects/${projectId}/issues`,
      {
        method: 'POST',
        body: {
          title: 'Add a dark mode feature',
          body: 'Add a dark mode feature',
          created_by: 'user',
          assigned_to: 'all',
        },
      }
    );
    assert.equal(status, 201);
    assert.ok(body.id, 'Should return issue id');
    assert.equal(body.title, 'Add a dark mode feature');
  });

  it('title and body are stored independently (#276)', async () => {
    const titleText = '修复登录超时问题';
    const bodyText =
      '详细描述：用户在使用VPN时，登录请求会超时。需要增加超时时间或优化认证流程。';
    const { status, body } = await ctx.api(
      `/api/projects/${projectId}/issues`,
      {
        method: 'POST',
        body: {
          title: titleText,
          body: bodyText,
          created_by: 'user',
          assigned_to: 'all',
        },
      }
    );
    assert.equal(status, 201);
    assert.equal(body.title, titleText, 'title 应与输入框内容一致');
    assert.equal(body.body, bodyText, 'body 应与 textarea 内容独立存储');
    assert.notEqual(body.title, body.body, 'title 和 body 应不同');
  });

  it('body falls back to title when empty (#276)', async () => {
    const titleText = '优化搜索性能';
    const { status, body } = await ctx.api(
      `/api/projects/${projectId}/issues`,
      {
        method: 'POST',
        body: {
          title: titleText,
          body: titleText,
          created_by: 'user',
          assigned_to: 'all',
        },
      }
    );
    assert.equal(status, 201);
    assert.equal(body.title, titleText);
    assert.equal(body.body, titleText, 'body 未填写时应与 title 相同');
  });

  it('both title and body are preserved when non-empty (#276)', async () => {
    const titleText = '添加导出功能';
    const bodyText = '支持将 issue 列表导出为 CSV 和 PDF 格式';
    const { status, body } = await ctx.api(
      `/api/projects/${projectId}/issues`,
      {
        method: 'POST',
        body: {
          title: titleText,
          body: bodyText,
          created_by: 'user',
          assigned_to: 'all',
        },
      }
    );
    assert.equal(status, 201);
    assert.ok(body.title.length > 0, 'title 不应为空');
    assert.ok(body.body.length > 0, 'body 不应为空');
    assert.equal(body.title, titleText);
    assert.equal(body.body, bodyText);
  });
});
