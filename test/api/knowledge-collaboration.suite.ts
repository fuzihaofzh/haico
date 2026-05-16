import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { ApiTestContext } from './helpers';

export function registerKnowledgeAndCollaborationSuites(
  ctx: ApiTestContext
): void {
  // ─── Knowledge Base (#283) ───

  let knowledgeProjectId: string;
  let knowledgeEntryId: string;
  let knowledgeMediumId: string;

  describe('Knowledge Base (#283)', () => {
    it('setup: create project for knowledge tests', async () => {
      const { status, body } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'knowledge-test',
          description: 'Knowledge test',
          task_description: 'Test knowledge base',
        },
      });
      assert.equal(status, 201);
      knowledgeProjectId = body.id;
    });

    it('POST /api/projects/:pid/knowledge creates entry', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${knowledgeProjectId}/knowledge`,
        {
          method: 'POST',
          body: {
            title: 'Test Knowledge',
            content: 'Test content',
            tags: 'test,arch',
            importance: 'high',
            created_by: 'agent-1',
          },
        }
      );
      assert.equal(status, 201);
      assert.ok(body.id);
      assert.equal(body.title, 'Test Knowledge');
      assert.equal(body.importance, 'high');
      assert.equal(body.tags, 'test,arch');
      knowledgeEntryId = body.id;
    });

    it('POST /api/projects/:pid/knowledge rejects missing title', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${knowledgeProjectId}/knowledge`,
        {
          method: 'POST',
          body: { content: 'no title' },
        }
      );
      assert.equal(status, 400);
      assert.equal(body.error, 'title is required');
    });

    it('POST /api/projects/:pid/knowledge defaults to medium importance', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${knowledgeProjectId}/knowledge`,
        {
          method: 'POST',
          body: { title: 'Medium Entry', content: 'medium content' },
        }
      );
      assert.equal(status, 201);
      assert.equal(body.importance, 'medium');
      knowledgeMediumId = body.id;
    });

    it('GET /api/projects/:pid/knowledge lists all entries', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${knowledgeProjectId}/knowledge`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.entries));
      assert.equal(body.entries.length, 2);
    });

    it('GET /api/projects/:pid/knowledge?importance=high filters by importance', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${knowledgeProjectId}/knowledge?importance=high`
      );
      assert.equal(status, 200);
      assert.equal(body.entries.length, 1);
      assert.equal(body.entries[0].importance, 'high');
    });

    it('GET /api/knowledge/:id returns single entry', async () => {
      const { status, body } = await ctx.api(
        `/api/knowledge/${knowledgeEntryId}`
      );
      assert.equal(status, 200);
      assert.equal(body.id, knowledgeEntryId);
      assert.equal(body.title, 'Test Knowledge');
    });

    it('GET /api/knowledge/:id returns 404 for unknown id', async () => {
      const { status } = await ctx.api('/api/knowledge/does-not-exist');
      assert.equal(status, 404);
    });

    it('PUT /api/knowledge/:id updates entry', async () => {
      const { status, body } = await ctx.api(
        `/api/knowledge/${knowledgeEntryId}`,
        {
          method: 'PUT',
          body: { title: 'Updated Title', importance: 'low' },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.title, 'Updated Title');
      assert.equal(body.importance, 'low');
      assert.equal(
        body.content,
        'Test content',
        'unset fields should be preserved'
      );
    });

    it('PUT /api/knowledge/:id returns 404 for unknown id', async () => {
      const { status } = await ctx.api('/api/knowledge/does-not-exist', {
        method: 'PUT',
        body: { title: 'x' },
      });
      assert.equal(status, 404);
    });

    it('DELETE /api/knowledge/:id removes entry', async () => {
      const { status, body } = await ctx.api(
        `/api/knowledge/${knowledgeMediumId}`,
        {
          method: 'DELETE',
        }
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);

      const { status: getStatus } = await ctx.api(
        `/api/knowledge/${knowledgeMediumId}`
      );
      assert.equal(getStatus, 404, 'Deleted entry should return 404');
    });

    it('DELETE /api/knowledge/:id returns 404 for unknown id', async () => {
      const { status } = await ctx.api('/api/knowledge/does-not-exist', {
        method: 'DELETE',
      });
      assert.equal(status, 404);
    });

    it('system-prompt injects high-importance knowledge entries', async () => {
      // Reset entry to high importance
      await ctx.api(`/api/knowledge/${knowledgeEntryId}`, {
        method: 'PUT',
        body: {
          importance: 'high',
          title: 'High Knowledge',
          content: 'Important info',
        },
      });
      // Get an agent in this project (the auto-created controller)
      const { body: agentsList } = await ctx.api(
        `/api/projects/${knowledgeProjectId}/agents`
      );
      assert.ok(
        agentsList.length > 0,
        'project should have at least one agent'
      );
      const agentId = agentsList[0].id;

      const { status, raw } = await ctx.api(
        `/api/agents/${agentId}/system-prompt`
      );
      assert.equal(status, 200);
      assert.ok(
        raw.includes('High Knowledge'),
        'system prompt should include high-importance knowledge title'
      );
      assert.ok(
        raw.includes('Important info'),
        'system prompt should include high-importance knowledge content'
      );
      assert.ok(
        raw.includes('Project Knowledge Base'),
        'system prompt should have Knowledge Base section header'
      );
    });
  });

  describe('Knowledge FTS全文搜索 (#399)', () => {
    let ftsProjId: string;
    let ftsEntryId: string;

    before(async () => {
      const { body: proj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'fts-test-proj',
          description: 'FTS test',
          task_description: 'Test FTS search',
        },
      });
      ftsProjId = proj.id;
    });

    it('POST creates knowledge entry for FTS', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${ftsProjId}/knowledge`,
        {
          method: 'POST',
          body: {
            title: 'SQLite Performance Tips',
            content: 'Use indexes for fast queries',
            tags: 'database,performance',
            importance: 'high',
            created_by: 'agent-1',
          },
        }
      );
      assert.equal(status, 201);
      ftsEntryId = body.id;
    });

    it('GET ?q= returns FTS matches', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${ftsProjId}/knowledge?q=SQLite`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.entries));
      assert.ok(body.entries.length >= 1);
      assert.ok(body.entries.some((e: any) => e.id === ftsEntryId));
    });

    it('GET ?q= with non-matching term returns empty', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${ftsProjId}/knowledge?q=nonexistentxyz`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.entries));
      assert.equal(body.entries.length, 0);
    });

    it('FTS updates when entry is updated', async () => {
      await ctx.api(`/api/knowledge/${ftsEntryId}`, {
        method: 'PUT',
        body: { content: 'Use WAL mode for concurrent writes' },
      });
      const { body } = await ctx.api(
        `/api/projects/${ftsProjId}/knowledge?q=WAL`
      );
      assert.ok(body.entries.length >= 1);
    });

    it('FTS entry disappears after delete', async () => {
      await ctx.api(`/api/knowledge/${ftsEntryId}`, { method: 'DELETE' });
      const { body } = await ctx.api(
        `/api/projects/${ftsProjId}/knowledge?q=WAL`
      );
      assert.equal(body.entries.length, 0);
    });
  });

  describe('Agent Owned Knowledge (#399)', () => {
    let memProjId: string;
    let memAgentId: string;
    let memAgent2Id: string;
    let ownedKnowledgeId: string;

    before(async () => {
      const { body: proj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'mem-test-proj',
          description: 'Knowledge test',
          task_description: 'Test agent owned knowledge',
        },
      });
      memProjId = proj.id;

      const { body: a1 } = await ctx.api(`/api/projects/${memProjId}/agents`, {
        method: 'POST',
        body: { name: 'mem-agent-1', role: 'worker' },
      });
      memAgentId = a1.id;

      const { body: a2 } = await ctx.api(`/api/projects/${memProjId}/agents`, {
        method: 'POST',
        body: { name: 'mem-agent-2', role: 'worker' },
      });
      memAgent2Id = a2.id;
    });

    it('GET /api/agents/:id/knowledge-memory returns seeded owner knowledge', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${memAgentId}/knowledge-memory`
      );
      assert.equal(status, 200);
      assert.equal(body.owner_agent_id, memAgentId);
      assert.equal(body.title, 'Agent Memory');
      assert.ok(String(body.tags || '').includes('agent-profile'));
      ownedKnowledgeId = body.id;
    });

    it('PUT /api/agents/:id/knowledge-memory upserts owner knowledge', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${memAgentId}/knowledge-memory`,
        {
          method: 'PUT',
          body: {
            content:
              'Primary task: maintain memory flow\nCommands: npm test\nArchitecture: prompt builder lives in src/services/system-prompt.ts',
            tags: 'commands,architecture',
            category: 'reference',
            importance: 'medium',
            verified_by: memAgentId,
          },
        }
      );
      assert.equal(status, 200);
      assert.equal(body.id, ownedKnowledgeId);
      assert.equal(body.owner_agent_id, memAgentId);
      assert.ok(body.content.includes('Primary task: maintain memory flow'));
      assert.ok(String(body.tags || '').includes('agent-profile'));
    });

    it('GET /api/projects/:pid/knowledge hides owner knowledge by default', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${memProjId}/knowledge`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.entries));
      assert.ok(
        !body.entries.some((entry: any) => entry.id === ownedKnowledgeId)
      );
    });

    it('GET /api/projects/:pid/knowledge?owner_agent_id= filters to owner knowledge', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${memProjId}/knowledge?owner_agent_id=${memAgentId}`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.entries));
      assert.ok(
        body.entries.some((entry: any) => entry.id === ownedKnowledgeId)
      );
      assert.ok(
        body.entries.every((entry: any) => entry.owner_agent_id === memAgentId)
      );
    });

    it('GET /api/projects/:pid/knowledge?include_owned=true includes owner knowledge', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${memProjId}/knowledge?include_owned=true`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.entries));
      assert.ok(
        body.entries.some((entry: any) => entry.id === ownedKnowledgeId)
      );
    });

    it('other agent gets a separate owned knowledge entry', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${memAgent2Id}/knowledge-memory`
      );
      assert.equal(status, 200);
      assert.equal(body.owner_agent_id, memAgent2Id);
      assert.notEqual(body.id, ownedKnowledgeId);
    });

    it('legacy memory routes are no longer registered', async () => {
      const listRes = await ctx.api(`/api/agents/${memAgentId}/memories`);
      assert.equal(listRes.status, 404);
      const projectRes = await ctx.api(`/api/projects/${memProjId}/memories`);
      assert.equal(projectRes.status, 404);
    });

    it('system prompt includes agent-owned knowledge item', async () => {
      const { buildSystemPrompt } = await import(
        '../../src/services/system-prompt'
      );
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();
      const agent = db
        .prepare('SELECT * FROM agents WHERE id = ?')
        .get(memAgentId) as any;
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(memProjId) as any;
      if (agent && project) {
        const prompt = buildSystemPrompt(agent, project);
        assert.ok(prompt.includes('Your Owned Knowledge Base Item'));
        assert.ok(prompt.includes('Primary task: maintain memory flow'));
        assert.ok(prompt.includes('/knowledge-memory'));
        assert.ok(
          prompt.includes(
            '在准备结束当前任务、准备把 issue 标记为 `done`、准备输出 final result 之前，必须先更新这条 knowledge。'
          )
        );
        assert.ok(prompt.includes('agent-profile'));
      }
    });

    it('system prompt explains issue number lookup versus UUID issue APIs', async () => {
      const { buildSystemPrompt } = await import(
        '../../src/services/system-prompt'
      );
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();
      const agent = db
        .prepare('SELECT * FROM agents WHERE id = ?')
        .get(memAgentId) as any;
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(memProjId) as any;
      if (agent && project) {
        const prompt = buildSystemPrompt(agent, project);
        assert.ok(prompt.includes('/api/issues/{issue_id}'));
        assert.ok(prompt.includes('/issues/number/{issue_number}'));
        assert.ok(prompt.includes('issue_id') && prompt.includes('UUID'));
      }
    });
  });

  describe('Issue依赖关系 (#400)', () => {
    let relProjId: string;
    let relIssue1Id: string;
    let relIssue2Id: string;
    let relIssue3Id: string;
    let blocksRelId: string;
    let relatedRelId: string;

    before(async () => {
      const { body: proj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'rel-test-proj',
          description: 'Relations test',
          task_description: 'Test issue relations',
        },
      });
      relProjId = proj.id;

      const { body: i1 } = await ctx.api(`/api/projects/${relProjId}/issues`, {
        method: 'POST',
        body: {
          title: 'Issue Alpha',
          body: 'first',
          created_by: 'user',
          assigned_to: 'user',
        },
      });
      relIssue1Id = i1.id;

      const { body: i2 } = await ctx.api(`/api/projects/${relProjId}/issues`, {
        method: 'POST',
        body: {
          title: 'Issue Beta',
          body: 'second',
          created_by: 'user',
          assigned_to: 'user',
        },
      });
      relIssue2Id = i2.id;

      const { body: i3 } = await ctx.api(`/api/projects/${relProjId}/issues`, {
        method: 'POST',
        body: {
          title: 'Issue Gamma',
          body: 'third',
          created_by: 'user',
          assigned_to: 'user',
        },
      });
      relIssue3Id = i3.id;
    });

    it('POST /api/issues/:id/relations creates blocks relation', async () => {
      const { status, body } = await ctx.api(
        `/api/issues/${relIssue1Id}/relations`,
        {
          method: 'POST',
          body: { type: 'blocks', target_issue_id: relIssue2Id, actor: 'user' },
        }
      );
      assert.equal(status, 201);
      assert.equal(body.relation_type, 'blocks');
      assert.equal(body.from_issue_id, relIssue1Id);
      assert.equal(body.to_issue_id, relIssue2Id);
      blocksRelId = body.id;
    });

    it('POST /api/issues/:id/relations creates related_to relation', async () => {
      const { status, body } = await ctx.api(
        `/api/issues/${relIssue1Id}/relations`,
        {
          method: 'POST',
          body: {
            type: 'related_to',
            target_issue_id: relIssue3Id,
            actor: 'user',
          },
        }
      );
      assert.equal(status, 201);
      assert.equal(body.relation_type, 'related_to');
      relatedRelId = body.id;
    });

    it('POST rejects self-relation', async () => {
      const { status, body } = await ctx.api(
        `/api/issues/${relIssue1Id}/relations`,
        {
          method: 'POST',
          body: { type: 'blocks', target_issue_id: relIssue1Id, actor: 'user' },
        }
      );
      assert.equal(status, 400);
      assert.ok(body.error.includes('self'));
    });

    it('POST rejects invalid type', async () => {
      const { status } = await ctx.api(`/api/issues/${relIssue1Id}/relations`, {
        method: 'POST',
        body: {
          type: 'depends_on',
          target_issue_id: relIssue2Id,
          actor: 'user',
        },
      });
      assert.equal(status, 400);
    });

    it('POST duplicate relation returns 409', async () => {
      const { status } = await ctx.api(`/api/issues/${relIssue1Id}/relations`, {
        method: 'POST',
        body: { type: 'blocks', target_issue_id: relIssue2Id, actor: 'user' },
      });
      assert.equal(status, 409);
    });

    it('GET /api/issues/:id/relations returns blocks, blocked_by, related_to', async () => {
      const { status, body } = await ctx.api(
        `/api/issues/${relIssue1Id}/relations`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.blocks));
      assert.ok(Array.isArray(body.blocked_by));
      assert.ok(Array.isArray(body.related_to));
      assert.ok(body.blocks.some((r: any) => r.to_issue_id === relIssue2Id));
      assert.ok(
        body.related_to.some(
          (r: any) =>
            r.to_issue_id === relIssue3Id || r.from_issue_id === relIssue3Id
        )
      );
    });

    it('GET /api/issues/:id returns blocks/blocked_by/is_blocked in detail', async () => {
      const { status, body } = await ctx.api(`/api/issues/${relIssue2Id}`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.blocked_by));
      assert.ok(body.blocked_by.some((r: any) => r.id === relIssue1Id));
      assert.equal(body.is_blocked, true);
    });

    it('列表接口 is_blocked=true 当存在未完成的 blocker', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${relProjId}/issues`
      );
      assert.equal(status, 200);
      const beta = body.issues.find((i: any) => i.id === relIssue2Id);
      assert.ok(beta, 'Issue Beta 应在列表中');
      assert.equal(
        typeof beta.is_blocked,
        'boolean',
        'is_blocked 应为布尔值，非 null'
      );
      assert.equal(
        beta.is_blocked,
        true,
        'blocker 未完成时 is_blocked 应为 true'
      );
      // Issue Alpha (blocker) 自身不应被 blocked
      const alpha = body.issues.find((i: any) => i.id === relIssue1Id);
      assert.ok(alpha, 'Issue Alpha 应在列表中');
      assert.equal(
        typeof alpha.is_blocked,
        'boolean',
        'is_blocked 应为布尔值，非 null'
      );
      assert.equal(
        alpha.is_blocked,
        false,
        '没有 blocker 的 issue，is_blocked 应为 false'
      );
    });

    it('is_blocked=false when blocker is done', async () => {
      await ctx.api(`/api/issues/${relIssue1Id}`, {
        method: 'PUT',
        body: { status: 'done', actor: 'user' },
      });
      const { body } = await ctx.api(`/api/issues/${relIssue2Id}`);
      assert.equal(body.is_blocked, false);
    });

    it('列表接口 is_blocked=false 当所有 blocker 都已完成', async () => {
      // relIssue1 已在上一个测试中置为 done
      const { status, body } = await ctx.api(
        `/api/projects/${relProjId}/issues`
      );
      assert.equal(status, 200);
      const beta = body.issues.find((i: any) => i.id === relIssue2Id);
      assert.ok(beta, 'Issue Beta 应在列表中');
      assert.equal(
        typeof beta.is_blocked,
        'boolean',
        'is_blocked 应为布尔值，非 null'
      );
      assert.equal(
        beta.is_blocked,
        false,
        'blocker 已完成时 is_blocked 应为 false'
      );
    });

    it('DELETE /api/issues/:id/relations/:relationId removes relation', async () => {
      const { status, body } = await ctx.api(
        `/api/issues/${relIssue1Id}/relations/${relatedRelId}`,
        {
          method: 'DELETE',
        }
      );
      assert.equal(status, 200);
      assert.equal(body.success, true);

      const { body: rels } = await ctx.api(
        `/api/issues/${relIssue1Id}/relations`
      );
      assert.ok(!rels.related_to.some((r: any) => r.id === relatedRelId));
    });

    it('DELETE nonexistent relation returns 404', async () => {
      const { status } = await ctx.api(
        `/api/issues/${relIssue1Id}/relations/nonexistent-id`,
        {
          method: 'DELETE',
        }
      );
      assert.equal(status, 404);
    });
  });

  describe('Agent直接消息通信 (#401)', () => {
    let msgProjId: string;
    let msgAgentAId: string;
    let msgAgentBId: string;
    let msgId: string;

    before(async () => {
      const { body: proj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'msg-test-proj',
          description: 'Messages test',
          task_description: 'Test agent messages',
          command_template: 'echo',
        },
      });
      msgProjId = proj.id;
      // Pause project to prevent auto-wake spawning background processes during message tests
      await ctx.api(`/api/projects/${msgProjId}`, {
        method: 'PUT',
        body: { status: 'paused' },
      });

      const { body: a1 } = await ctx.api(`/api/projects/${msgProjId}/agents`, {
        method: 'POST',
        body: { name: 'msg-agent-a', role: 'sender' },
      });
      msgAgentAId = a1.id;

      const { body: a2 } = await ctx.api(`/api/projects/${msgProjId}/agents`, {
        method: 'POST',
        body: { name: 'msg-agent-b', role: 'receiver' },
      });
      msgAgentBId = a2.id;
    });

    it('POST /api/agents/:id/messages/send sends a message', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${msgAgentAId}/messages/send`,
        {
          method: 'POST',
          body: { to: msgAgentBId, subject: 'Hello', body: 'Hi from agent A' },
        }
      );
      assert.equal(status, 201);
      assert.ok(body.id);
      assert.equal(body.from_agent_id, msgAgentAId);
      assert.equal(body.to_agent_id, msgAgentBId);
      assert.equal(body.status, 'unread');
      msgId = body.id;
    });

    it('POST send requires to and body', async () => {
      const { status } = await ctx.api(
        `/api/agents/${msgAgentAId}/messages/send`,
        {
          method: 'POST',
          body: { subject: 'No recipient' },
        }
      );
      assert.equal(status, 400);
    });

    it('POST send rejects unknown sender', async () => {
      const { status } = await ctx.api(
        `/api/agents/nonexistent-id/messages/send`,
        {
          method: 'POST',
          body: { to: msgAgentBId, body: 'test' },
        }
      );
      assert.equal(status, 404);
    });

    it('POST send rejects unknown recipient', async () => {
      const { status } = await ctx.api(
        `/api/agents/${msgAgentAId}/messages/send`,
        {
          method: 'POST',
          body: { to: 'nonexistent-id', body: 'test' },
        }
      );
      assert.equal(status, 404);
    });

    it('GET /api/agents/:id/messages lists inbox', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${msgAgentBId}/messages`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.messages));
      assert.ok(body.messages.some((m: any) => m.id === msgId));
    });

    it('GET ?status=unread filters to unread messages', async () => {
      const { body } = await ctx.api(
        `/api/agents/${msgAgentBId}/messages?status=unread`
      );
      assert.ok(body.messages.some((m: any) => m.id === msgId));
    });

    it('PUT /api/agents/:id/messages/:msgId marks message as read', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${msgAgentBId}/messages/${msgId}`,
        {
          method: 'PUT',
        }
      );
      assert.equal(status, 200);
      assert.equal(body.status, 'read');
    });

    it('GET ?status=unread returns empty after marking read', async () => {
      const { body } = await ctx.api(
        `/api/agents/${msgAgentBId}/messages?status=unread`
      );
      assert.ok(!body.messages.some((m: any) => m.id === msgId));
    });

    it('POST read-all marks all messages as read', async () => {
      // Send another message first
      await ctx.api(`/api/agents/${msgAgentAId}/messages/send`, {
        method: 'POST',
        body: { to: msgAgentBId, subject: 'Second', body: 'Another message' },
      });

      const { status, body } = await ctx.api(
        `/api/agents/${msgAgentBId}/messages/read-all`,
        {
          method: 'POST',
        }
      );
      assert.equal(status, 200);
      assert.ok(typeof body.updated === 'number');

      const { body: inbox } = await ctx.api(
        `/api/agents/${msgAgentBId}/messages?status=unread`
      );
      assert.equal(inbox.messages.length, 0);
    });

    it('GET /api/agents/:id/messages/sent returns sent messages', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${msgAgentAId}/messages/sent`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.messages));
      assert.ok(body.messages.length >= 2);
    });

    it('PUT nonexistent message returns 404', async () => {
      const { status } = await ctx.api(
        `/api/agents/${msgAgentBId}/messages/nonexistent-id`,
        {
          method: 'PUT',
        }
      );
      assert.equal(status, 404);
    });

    it('system prompt includes unread messages', async () => {
      // Send a fresh message so there's at least one unread
      await ctx.api(`/api/agents/${msgAgentAId}/messages/send`, {
        method: 'POST',
        body: { to: msgAgentBId, subject: 'Urgent', body: 'Check this out' },
      });

      const { buildSystemPrompt } = await import(
        '../../src/services/system-prompt'
      );
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();
      const agent = db
        .prepare('SELECT * FROM agents WHERE id = ?')
        .get(msgAgentBId) as any;
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(msgProjId) as any;
      if (agent && project) {
        const prompt = buildSystemPrompt(agent, project);
        assert.ok(
          prompt.includes('message') ||
            prompt.includes('Message') ||
            prompt.includes('Urgent')
        );
      }
    });
  });

  describe('Agent层级结构 (#523/#528)', () => {
    let hierarchyProjectId: string;
    let hierarchyControllerId: string;
    let managerAgentId: string;
    let leafAgentId: string;
    let siblingAgentId: string;
    let otherProjectId: string;
    let otherProjectAgentId: string;

    before(async () => {
      const { body: proj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'hierarchy-test-proj',
          description: 'Hierarchy test',
          task_description: 'Test parent_agent_id hierarchy',
          command_template: 'echo',
        },
      });
      hierarchyProjectId = proj.id;
      await ctx.api(`/api/projects/${hierarchyProjectId}`, {
        method: 'PUT',
        body: { status: 'paused' },
      });

      const { body: projectAgents } = await ctx.api(
        `/api/projects/${hierarchyProjectId}/agents`
      );
      hierarchyControllerId = projectAgents.find(
        (agent: any) => agent.is_controller
      )?.id;
      assert.ok(hierarchyControllerId, 'project should have a controller');

      const manager = await ctx.api(
        `/api/projects/${hierarchyProjectId}/agents`,
        {
          method: 'POST',
          body: {
            name: 'hier-manager',
            role: 'manager',
            parent_agent_id: hierarchyControllerId,
          },
        }
      );
      assert.equal(manager.status, 201);
      managerAgentId = manager.body.id;
      assert.equal(manager.body.parent_agent_id, hierarchyControllerId);

      const leaf = await ctx.api(`/api/projects/${hierarchyProjectId}/agents`, {
        method: 'POST',
        body: {
          name: 'hier-leaf',
          role: 'leaf',
          parent_agent_id: managerAgentId,
        },
      });
      assert.equal(leaf.status, 201);
      leafAgentId = leaf.body.id;

      const sibling = await ctx.api(
        `/api/projects/${hierarchyProjectId}/agents`,
        {
          method: 'POST',
          body: {
            name: 'hier-sibling',
            role: 'sibling',
            parent_agent_id: managerAgentId,
          },
        }
      );
      assert.equal(sibling.status, 201);
      siblingAgentId = sibling.body.id;

      const { body: otherProj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'hierarchy-other-proj',
          description: 'Hierarchy other project',
          task_description: 'Test cross-project parent validation',
          command_template: 'echo',
        },
      });
      otherProjectId = otherProj.id;
      await ctx.api(`/api/projects/${otherProjectId}`, {
        method: 'PUT',
        body: { status: 'paused' },
      });

      const otherAgent = await ctx.api(
        `/api/projects/${otherProjectId}/agents`,
        {
          method: 'POST',
          body: { name: 'hier-other', role: 'other project agent' },
        }
      );
      assert.equal(otherAgent.status, 201);
      otherProjectAgentId = otherAgent.body.id;
    });

    it('GET /api/projects/:pid/agents returns parent_agent_id', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${hierarchyProjectId}/agents`
      );
      assert.equal(status, 200);
      const manager = body.find((agent: any) => agent.id === managerAgentId);
      const leaf = body.find((agent: any) => agent.id === leafAgentId);
      assert.equal(manager.parent_agent_id, hierarchyControllerId);
      assert.equal(leaf.parent_agent_id, managerAgentId);
    });

    it('POST /api/projects/:pid/agents rejects parent agents from other projects', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${hierarchyProjectId}/agents`,
        {
          method: 'POST',
          body: {
            name: 'bad-parent',
            role: 'invalid',
            parent_agent_id: otherProjectAgentId,
          },
        }
      );
      assert.equal(status, 400);
      assert.equal(body.error, 'Parent agent must belong to the same project');
    });

    it('PUT /api/agents/:id rejects descendant parent assignment to prevent cycles', async () => {
      const { status, body } = await ctx.api(`/api/agents/${managerAgentId}`, {
        method: 'PUT',
        body: { parent_agent_id: leafAgentId },
      });
      assert.equal(status, 400);
      assert.equal(
        body.error,
        'Parent agent cannot be a descendant of this agent'
      );
    });

    it('hierarchy messaging allows direct parent communication', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${leafAgentId}/messages/send`,
        {
          method: 'POST',
          body: {
            to: managerAgentId,
            subject: 'parent',
            body: 'direct parent is allowed',
          },
        }
      );
      assert.equal(status, 201);
      assert.equal(body.to_agent_id, managerAgentId);
    });

    it('hierarchy messaging rejects sibling communication with fixed 403 message', async () => {
      const { status, body } = await ctx.api(
        `/api/agents/${leafAgentId}/messages/send`,
        {
          method: 'POST',
          body: {
            to: siblingAgentId,
            subject: 'sibling',
            body: 'this should fail',
          },
        }
      );
      assert.equal(status, 403);
      assert.equal(body.error, '只能与直接上级或下属通信');
    });

    it('system prompt includes direct parent, direct children and hierarchy restriction', async () => {
      const { buildSystemPrompt } = await import(
        '../../src/services/system-prompt'
      );
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();

      const manager = db
        .prepare('SELECT * FROM agents WHERE id = ?')
        .get(managerAgentId) as any;
      const leaf = db
        .prepare('SELECT * FROM agents WHERE id = ?')
        .get(leafAgentId) as any;
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(hierarchyProjectId) as any;

      const managerPrompt = buildSystemPrompt(manager, project);
      const leafPrompt = buildSystemPrompt(leaf, project);

      assert.ok(
        managerPrompt.includes('你的直接下属'),
        'manager prompt should list direct children'
      );
      assert.ok(
        managerPrompt.includes('hier-leaf') &&
          managerPrompt.includes('hier-sibling')
      );
      assert.ok(leafPrompt.includes('你的直接上级是 hier-manager'));
      assert.ok(leafPrompt.includes('只能通过消息与直接上级或直接下属沟通'));
    });
  });

  describe('Agent侧边栏树状展示验证 (#571)', () => {
    let treeProjectId: string;
    let treeControllerId: string;
    let treeManagerId: string;
    let treeLeafId: string;
    let treeLeaf2Id: string;
    let flatProjectId: string;
    let flatControllerId: string;
    let flatWorkerId: string;

    before(async () => {
      // Create project with hierarchy
      const { body: proj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'tree-sidebar-test',
          description: 'Sidebar tree display test',
          task_description: 'Test tree rendering in sidebar',
          command_template: 'echo',
        },
      });
      treeProjectId = proj.id;
      await ctx.api(`/api/projects/${treeProjectId}`, {
        method: 'PUT',
        body: { status: 'paused' },
      });

      const { body: agents } = await ctx.api(
        `/api/projects/${treeProjectId}/agents`
      );
      treeControllerId = agents.find((a: any) => a.is_controller)?.id;

      const mgr = await ctx.api(`/api/projects/${treeProjectId}/agents`, {
        method: 'POST',
        body: {
          name: 'tree-manager',
          role: 'manager',
          parent_agent_id: treeControllerId,
        },
      });
      treeManagerId = mgr.body.id;

      const leaf = await ctx.api(`/api/projects/${treeProjectId}/agents`, {
        method: 'POST',
        body: {
          name: 'tree-leaf',
          role: 'leaf worker',
          parent_agent_id: treeManagerId,
        },
      });
      treeLeafId = leaf.body.id;

      const leaf2 = await ctx.api(`/api/projects/${treeProjectId}/agents`, {
        method: 'POST',
        body: {
          name: 'tree-leaf2',
          role: 'leaf worker 2',
          parent_agent_id: treeManagerId,
        },
      });
      treeLeaf2Id = leaf2.body.id;

      // Create flat project (no hierarchy)
      const { body: flatProj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'flat-sidebar-test',
          description: 'Flat sidebar test',
          task_description: 'Test flat rendering in sidebar',
          command_template: 'echo',
        },
      });
      flatProjectId = flatProj.id;
      await ctx.api(`/api/projects/${flatProjectId}`, {
        method: 'PUT',
        body: { status: 'paused' },
      });

      const { body: flatAgents } = await ctx.api(
        `/api/projects/${flatProjectId}/agents`
      );
      flatControllerId = flatAgents.find((a: any) => a.is_controller)?.id;

      const worker = await ctx.api(`/api/projects/${flatProjectId}/agents`, {
        method: 'POST',
        body: { name: 'flat-worker', role: 'worker' },
      });
      flatWorkerId = worker.body.id;
    });

    it('hierarchical project returns agents with correct parent_agent_id chain', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${treeProjectId}/agents`
      );
      assert.equal(status, 200);

      const controller = body.find((a: any) => a.id === treeControllerId);
      const manager = body.find((a: any) => a.id === treeManagerId);
      const leaf = body.find((a: any) => a.id === treeLeafId);
      const leaf2 = body.find((a: any) => a.id === treeLeaf2Id);

      // Controller has no parent
      assert.equal(controller.parent_agent_id, null);
      // Manager's parent is controller
      assert.equal(manager.parent_agent_id, treeControllerId);
      // Leaves' parent is manager (3-level hierarchy)
      assert.equal(leaf.parent_agent_id, treeManagerId);
      assert.equal(leaf2.parent_agent_id, treeManagerId);
    });

    it('flat project agents have no parent_agent_id', async () => {
      const { status, body } = await ctx.api(
        `/api/projects/${flatProjectId}/agents`
      );
      assert.equal(status, 200);

      for (const agent of body) {
        assert.equal(
          agent.parent_agent_id,
          null,
          `agent ${agent.name} should have no parent`
        );
      }
    });

    it('GET /api/agents/:id returns correct detail for hierarchical agent', async () => {
      const { status, body } = await ctx.api(`/api/agents/${treeLeafId}`);
      assert.equal(status, 200);
      assert.equal(body.name, 'tree-leaf');
      assert.equal(body.parent_agent_id, treeManagerId);
    });

    it('agent pause/unpause works on hierarchical agents', async () => {
      // Pause leaf agent using dedicated pause endpoint
      const pause = await ctx.api(`/api/agents/${treeLeafId}/pause`, {
        method: 'POST',
      });
      assert.equal(pause.status, 200);
      assert.equal(pause.body.success, true);

      // Verify agent is paused
      const statusAfterPause = await ctx.api(
        `/api/agents/${treeLeafId}/status`
      );
      assert.equal(statusAfterPause.body.paused, true);

      // Unpause leaf agent using dedicated unpause endpoint
      const unpause = await ctx.api(`/api/agents/${treeLeafId}/unpause`, {
        method: 'POST',
      });
      assert.equal(unpause.status, 200);
      assert.equal(unpause.body.success, true);

      // Verify agent is unpaused
      const statusAfterUnpause = await ctx.api(
        `/api/agents/${treeLeafId}/status`
      );
      assert.equal(statusAfterUnpause.body.paused, false);
    });

    it('agent update preserves parent_agent_id', async () => {
      const { status, body } = await ctx.api(`/api/agents/${treeLeafId}`, {
        method: 'PUT',
        body: { role: 'updated leaf role' },
      });
      assert.equal(status, 200);
      assert.equal(body.parent_agent_id, treeManagerId);
      assert.equal(body.role, 'updated leaf role');
    });

    it('can reassign parent within same project', async () => {
      // Move leaf2 directly under controller
      const { status, body } = await ctx.api(`/api/agents/${treeLeaf2Id}`, {
        method: 'PUT',
        body: { parent_agent_id: treeControllerId },
      });
      assert.equal(status, 200);
      assert.equal(body.parent_agent_id, treeControllerId);

      // Verify the tree structure changed
      const { body: agents } = await ctx.api(
        `/api/projects/${treeProjectId}/agents`
      );
      const movedLeaf = agents.find((a: any) => a.id === treeLeaf2Id);
      assert.equal(movedLeaf.parent_agent_id, treeControllerId);

      // Restore original parent
      await ctx.api(`/api/agents/${treeLeaf2Id}`, {
        method: 'PUT',
        body: { parent_agent_id: treeManagerId },
      });
    });

    it('delete child agent does not affect parent or siblings', async () => {
      // Create a temporary child to delete
      const tmp = await ctx.api(`/api/projects/${treeProjectId}/agents`, {
        method: 'POST',
        body: {
          name: 'tree-temp',
          role: 'temp',
          parent_agent_id: treeManagerId,
        },
      });
      assert.equal(tmp.status, 201);

      // Delete it
      const del = await ctx.api(`/api/agents/${tmp.body.id}`, {
        method: 'DELETE',
      });
      assert.equal(del.status, 200);

      // Verify parent and siblings unaffected
      const { body: agents } = await ctx.api(
        `/api/projects/${treeProjectId}/agents`
      );
      const manager = agents.find((a: any) => a.id === treeManagerId);
      const leaf = agents.find((a: any) => a.id === treeLeafId);
      assert.ok(manager, 'manager should still exist');
      assert.ok(leaf, 'sibling leaf should still exist');
      assert.equal(manager.parent_agent_id, treeControllerId);
      assert.equal(leaf.parent_agent_id, treeManagerId);
    });
  });

  describe('Child issue auto-sets parent to pending (#326)', () => {
    let pendingProjectId: string;
    let issueAId: string;
    let issueBId: string;
    let doneProjId: string;
    let doneParentId: string;
    let closedParentId: string;

    before(async () => {
      const { body: proj } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'pending-test-proj',
          description: 'Pending test',
          task_description: 'Test pending auto-set',
        },
      });
      pendingProjectId = proj.id;

      // Create issue A (parent candidate)
      const { body: issueA } = await ctx.api(
        `/api/projects/${pendingProjectId}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Issue A',
            body: 'parent',
            created_by: 'user',
            assigned_to: 'user',
          },
        }
      );
      issueAId = issueA.id;

      // Project for done/closed parent tests
      const { body: proj2 } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'pending-done-test',
          description: 'Done closed parent test',
          task_description: 'Test done/closed parent',
        },
      });
      doneProjId = proj2.id;

      const { body: dp } = await ctx.api(`/api/projects/${doneProjId}/issues`, {
        method: 'POST',
        body: {
          title: 'Done Parent',
          body: 'done parent',
          created_by: 'user',
          assigned_to: 'user',
        },
      });
      doneParentId = dp.id;
      await ctx.api(`/api/issues/${doneParentId}`, {
        method: 'PUT',
        body: { status: 'done', actor: 'user' },
      });

      const { body: cp } = await ctx.api(`/api/projects/${doneProjId}/issues`, {
        method: 'POST',
        body: {
          title: 'Closed Parent',
          body: 'closed parent',
          created_by: 'user',
          assigned_to: 'user',
        },
      });
      closedParentId = cp.id;
      await ctx.api(`/api/issues/${closedParentId}`, {
        method: 'PUT',
        body: { status: 'closed', actor: 'user' },
      });
    });

    it('creating child issue auto-sets parent to pending', async () => {
      const { body: issueB, status } = await ctx.api(
        `/api/projects/${pendingProjectId}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Issue B',
            body: 'child',
            created_by: 'user',
            assigned_to: 'user',
            parent_id: issueAId,
          },
        }
      );
      assert.equal(status, 201);
      issueBId = issueB.id;

      const { body: parentAfter } = await ctx.api(`/api/issues/${issueAId}`);
      assert.equal(
        parentAfter.status,
        'pending',
        'Parent issue A should be pending after child B is created'
      );
    });

    it('creating another child on already-pending parent does not error', async () => {
      const { status } = await ctx.api(
        `/api/projects/${pendingProjectId}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Issue C',
            body: 'second child',
            created_by: 'user',
            assigned_to: 'user',
            parent_id: issueAId,
          },
        }
      );
      assert.equal(
        status,
        201,
        'Creating second child on pending parent should succeed'
      );

      const { body: parentAfter } = await ctx.api(`/api/issues/${issueAId}`);
      assert.equal(
        parentAfter.status,
        'pending',
        'Parent should remain pending'
      );
    });

    it('infers parent_id from leading parent issue marker in body', async () => {
      const { body: parent } = await ctx.api(
        `/api/projects/${pendingProjectId}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Implicit Parent',
            body: 'implicit parent candidate',
            created_by: 'controller-agent',
            assigned_to: 'worker-agent',
          },
        }
      );

      const { body: child, status } = await ctx.api(
        `/api/projects/${pendingProjectId}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Implicit Child',
            body: `父 issue: #${parent.number}\n\ncontroller forgot parent_id but left a marker`,
            created_by: 'controller-agent',
            assigned_to: 'worker-agent',
          },
        }
      );
      assert.equal(status, 201);
      assert.equal(
        child.parent_id,
        parent.id,
        'Body marker should auto-link the child to the parent issue'
      );

      const { body: parentAfter } = await ctx.api(`/api/issues/${parent.id}`);
      assert.equal(
        parentAfter.status,
        'pending',
        'Implicitly linked parent should be pushed to pending'
      );
    });

    it('PUT /api/issues/:id status=pending succeeds (no SQLITE_CONSTRAINT_CHECK)', async () => {
      // Create a fresh issue and set it to pending via API
      const { body: freshIssue } = await ctx.api(
        `/api/projects/${pendingProjectId}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Fresh issue for pending test',
            body: 'test',
            created_by: 'user',
            assigned_to: 'user',
          },
        }
      );
      const { status, body } = await ctx.api(`/api/issues/${freshIssue.id}`, {
        method: 'PUT',
        body: { status: 'pending', actor: 'user' },
      });
      assert.equal(
        status,
        200,
        'Setting status=pending via PUT should return 200'
      );
      assert.equal(body.status, 'pending');
    });

    it('done parent is NOT changed to pending when child is created', async () => {
      const { status } = await ctx.api(`/api/projects/${doneProjId}/issues`, {
        method: 'POST',
        body: {
          title: 'Child of Done',
          body: 'child',
          created_by: 'user',
          assigned_to: 'user',
          parent_id: doneParentId,
        },
      });
      assert.equal(status, 201);

      const { body: parentAfter } = await ctx.api(
        `/api/issues/${doneParentId}`
      );
      assert.equal(
        parentAfter.status,
        'done',
        'Done parent should remain done after child creation'
      );
    });

    it('closed parent is NOT changed to pending when child is created', async () => {
      const { status } = await ctx.api(`/api/projects/${doneProjId}/issues`, {
        method: 'POST',
        body: {
          title: 'Child of Closed',
          body: 'child',
          created_by: 'user',
          assigned_to: 'user',
          parent_id: closedParentId,
        },
      });
      assert.equal(status, 201);

      const { body: parentAfter } = await ctx.api(
        `/api/issues/${closedParentId}`
      );
      assert.equal(
        parentAfter.status,
        'closed',
        'Closed parent should remain closed after child creation'
      );
    });

    it('completing all children triggers parent auto-update (re-opens to open)', async () => {
      // Complete all children of issue A
      const { body: parentDetail } = await ctx.api(`/api/issues/${issueAId}`);
      for (const child of parentDetail.children || []) {
        await ctx.api(`/api/issues/${child.id}`, {
          method: 'PUT',
          body: { status: 'done', actor: 'user' },
        });
      }
      const { body: parentAfter } = await ctx.api(`/api/issues/${issueAId}`);
      assert.ok(
        ['open', 'in_progress', 'done'].includes(parentAfter.status),
        `Parent status after all children done should be open/in_progress/done, got: ${parentAfter.status}`
      );
    });
  });

  describe('Scheduler stale pending scan', () => {
    it('finds pending parent whose children are already complete', async () => {
      const { findStalePendingIssue } = await import(
        '../../src/services/scheduler'
      );

      const { body: project } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'stale-pending-parent',
          description: 'scheduler test',
          task_description: 'scheduler test',
        },
      });

      const { body: parent } = await ctx.api(
        `/api/projects/${project.id}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Parent pending',
            body: 'parent',
            created_by: 'controller-agent',
            assigned_to: 'worker-agent',
          },
        }
      );

      const { body: child } = await ctx.api(
        `/api/projects/${project.id}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Child done',
            body: 'child',
            created_by: 'controller-agent',
            assigned_to: 'worker-agent',
            parent_id: parent.id,
          },
        }
      );

      await ctx.api(`/api/issues/${child.id}`, {
        method: 'PUT',
        body: { status: 'done', actor: 'worker-agent' },
      });

      await ctx.api(`/api/issues/${parent.id}`, {
        method: 'PUT',
        body: { status: 'pending', actor: 'controller-agent' },
      });

      const stale = findStalePendingIssue(project.id);
      assert.equal(
        stale?.number,
        parent.number,
        'Completed-child parent should be picked up by system scan'
      );
    });

    it('ignores pending parent that still has active children', async () => {
      const { findStalePendingIssue } = await import(
        '../../src/services/scheduler'
      );

      const { body: project } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'active-child-pending-parent',
          description: 'scheduler test',
          task_description: 'scheduler test',
        },
      });

      const { body: parent } = await ctx.api(
        `/api/projects/${project.id}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Parent pending',
            body: 'parent',
            created_by: 'controller-agent',
            assigned_to: 'worker-agent',
          },
        }
      );

      await ctx.api(`/api/projects/${project.id}/issues`, {
        method: 'POST',
        body: {
          title: 'Child active',
          body: 'child',
          created_by: 'controller-agent',
          assigned_to: 'worker-agent',
          parent_id: parent.id,
        },
      });

      const stale = findStalePendingIssue(project.id);
      assert.equal(
        stale,
        undefined,
        'Pending parent with unfinished child should not be treated as stale'
      );
    });

    it('finds pending blocked issue once the blocker is complete', async () => {
      const { findStalePendingIssue } = await import(
        '../../src/services/scheduler'
      );

      const { body: project } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'resolved-blocker-pending',
          description: 'scheduler test',
          task_description: 'scheduler test',
        },
      });

      const { body: blocker } = await ctx.api(
        `/api/projects/${project.id}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Blocker',
            body: 'blocker',
            created_by: 'controller-agent',
            assigned_to: 'worker-agent',
          },
        }
      );

      const { body: blocked } = await ctx.api(
        `/api/projects/${project.id}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Blocked pending',
            body: 'blocked',
            created_by: 'controller-agent',
            assigned_to: 'worker-agent',
          },
        }
      );

      const relRes = await ctx.api(`/api/issues/${blocker.id}/relations`, {
        method: 'POST',
        body: {
          type: 'blocks',
          target_issue_id: blocked.id,
          actor: 'controller-agent',
        },
      });
      assert.equal(relRes.status, 201);

      await ctx.api(`/api/issues/${blocked.id}`, {
        method: 'PUT',
        body: { status: 'pending', actor: 'controller-agent' },
      });
      await ctx.api(`/api/issues/${blocker.id}`, {
        method: 'PUT',
        body: { status: 'done', actor: 'worker-agent' },
      });

      const stale = findStalePendingIssue(project.id);
      assert.equal(
        stale?.number,
        blocked.number,
        'Pending issue with resolved blocker should be picked up by system scan'
      );
    });

    it('ignores pending blocked issue while blocker is still active', async () => {
      const { findStalePendingIssue } = await import(
        '../../src/services/scheduler'
      );

      const { body: project } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: 'active-blocker-pending',
          description: 'scheduler test',
          task_description: 'scheduler test',
        },
      });

      const { body: blocker } = await ctx.api(
        `/api/projects/${project.id}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Blocker',
            body: 'blocker',
            created_by: 'controller-agent',
            assigned_to: 'worker-agent',
          },
        }
      );

      const { body: blocked } = await ctx.api(
        `/api/projects/${project.id}/issues`,
        {
          method: 'POST',
          body: {
            title: 'Blocked pending',
            body: 'blocked',
            created_by: 'controller-agent',
            assigned_to: 'worker-agent',
          },
        }
      );

      const relRes = await ctx.api(`/api/issues/${blocker.id}/relations`, {
        method: 'POST',
        body: {
          type: 'blocks',
          target_issue_id: blocked.id,
          actor: 'controller-agent',
        },
      });
      assert.equal(relRes.status, 201);

      await ctx.api(`/api/issues/${blocked.id}`, {
        method: 'PUT',
        body: { status: 'pending', actor: 'controller-agent' },
      });

      const stale = findStalePendingIssue(project.id);
      assert.equal(
        stale,
        undefined,
        'Pending issue with active blocker should not be treated as stale'
      );
    });
  });
}
