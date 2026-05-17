import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { ApiTestContext } from './helpers';

export interface SchedulingRegressionState {
  readonly projectId: string;
}

export function registerSchedulingRegressionSuites(
  ctx: ApiTestContext,
  state: SchedulingRegressionState
): void {
  describe('成本优化/调度回归 (#497/#498)', () => {
    let restoreMockClaude: (() => void) | null = null;
    let fallbackProjectId: string | null = null;

    before(() => {
      const tmpDir = fs.mkdtempSync(
        path.join(require('os').tmpdir(), 'haico-mock-claude-')
      );
      const binPath = path.join(tmpDir, 'claude');
      fs.writeFileSync(
        binPath,
        `#!/bin/sh
set -eu

prompt="\${HAICO_PROMPT:-}"
prompt_file="\${HAICO_PROMPT_FILE:-}"
prompt_truncated="\${HAICO_PROMPT_TRUNCATED:-0}"

if [ "$prompt_truncated" = "1" ] && [ -n "$prompt_file" ] && [ -f "$prompt_file" ]; then
  prompt="$(cat "$prompt_file")"
fi

contains() {
  printf '%s' "$prompt" | grep -q "$1"
}

if contains 'API_RETRY_FAIL'; then
  echo 'Unable to connect to API' >&2
  exit 1
fi

if contains 'TAIL_SESSION'; then
  cat <<'JSON'
{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"tiny"}]}}
{"type":"result","result":"tail session done","usage":{"input_tokens":10,"output_tokens":20},"total_cost_usd":0}
JSON
  exit 0
fi

if contains 'PRECTRL_KEEPALIVE'; then
  sleep 10
  cat <<'JSON'
{"type":"result","result":"pre-controller done","usage":{"input_tokens":10,"output_tokens":120},"total_cost_usd":0}
JSON
  exit 0
fi

if contains 'LOW_OUTPUT'; then
  cat <<'JSON'
{"type":"result","result":"low output done","usage":{"input_tokens":10,"output_tokens":50},"total_cost_usd":0}
JSON
  exit 0
fi

cat <<'JSON'
{"type":"result","result":"normal output done","usage":{"input_tokens":10,"output_tokens":150},"total_cost_usd":0}
JSON
`,
        { mode: 0o755 }
      );

      const prevPath = process.env.PATH || '';
      process.env.PATH = `${tmpDir}:${prevPath}`;
      restoreMockClaude = () => {
        process.env.PATH = prevPath;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      };
    });

    after(() => {
      restoreMockClaude?.();
    });

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function getMainProjectId(): Promise<string> {
      if (state.projectId) return state.projectId;
      if (fallbackProjectId) return fallbackProjectId;

      const { status, body } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: `scheduling-regression-main-${Date.now()}`,
          description:
            'fallback project for focused scheduling regression runs',
          task_description: 'regression test',
          command_template: 'echo',
        },
      });
      assert.equal(status, 201);
      fallbackProjectId = body.id;
      return fallbackProjectId;
    }

    async function createMockWorker(name: string): Promise<string> {
      const projectId = await getMainProjectId();
      const { status, body } = await ctx.api(
        `/api/projects/${projectId}/agents`,
        {
          method: 'POST',
          body: {
            name,
            role: 'Mock regression worker',
            command_template: 'claude',
          },
        }
      );
      assert.equal(status, 201);
      return body.id;
    }

    async function createIsolatedOrchestrationProject(
      namePrefix: string
    ): Promise<{ projectId: string; controllerId: string }> {
      const { getDatabase } = await import('../../src/db/database');
      const uniqueName = `${namePrefix}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2, 8)}`;
      const { status, body } = await ctx.api('/api/projects', {
        method: 'POST',
        body: {
          name: uniqueName,
          description: 'orchestration regression project',
          task_description: 'regression test',
          command_template: 'echo',
        },
      });
      assert.equal(status, 201);

      const db = getDatabase();
      const controller = db
        .prepare(
          'SELECT id FROM agents WHERE project_id = ? AND is_controller = 1'
        )
        .get(body.id) as { id: string } | undefined;
      assert.ok(controller?.id, '应自动创建 controller');

      return {
        projectId: body.id,
        controllerId: controller.id,
      };
    }

    async function waitForAgentStatus(
      agentId: string,
      predicate: (status: string) => boolean,
      maxMs = 5000
    ): Promise<any> {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        const { body } = await ctx.api(`/api/agents/${agentId}/status`);
        if (predicate(body.status)) return body;
        await sleep(100);
      }
      const { body } = await ctx.api(`/api/agents/${agentId}/status`);
      return body;
    }

    async function insertAssignedIssue(
      agentId: string,
      marker: string,
      status = 'in_progress'
    ): Promise<number> {
      const { getDatabase } = await import('../../src/db/database');
      const db = getDatabase();
      const projectId = await getMainProjectId();
      const issueId = `issue-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`;
      const last = db
        .prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?')
        .get(projectId) as { n: number | null };
      const number = (last?.n || 0) + 1;

      db.prepare(
        `
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-10 minutes'))
        `
      ).run(
        issueId,
        projectId,
        number,
        `${marker} title`,
        `${marker} body`,
        'test',
        agentId,
        1,
        status,
        'test'
      );

      return number;
    }

    it('waiting-user orchestration run records finish backoff instead of starting controller', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const { startControllerOrchestration } = await import(
        '../../src/services/orchestrator'
      );
      const { getControllerBackoff, clearControllerBackoff } = await import(
        '../../src/services/controller-backoff'
      );
      const isolated = await createIsolatedOrchestrationProject(
        'waiting-user-orch'
      );

      const db = getDatabase();
      const controller = db
        .prepare('SELECT * FROM agents WHERE id = ?')
        .get(isolated.controllerId) as any;
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(isolated.projectId) as any;
      const issueId = `waiting-user-${Date.now()}`;
      const issueRow = db
        .prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?')
        .get(isolated.projectId) as { n: number | null };
      const issueNumber = (issueRow?.n || 0) + 1;

      db.prepare(
        `
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `
      ).run(
        issueId,
        isolated.projectId,
        issueNumber,
        'waiting user orchestration',
        'waiting on user',
        'test',
        'user',
        1,
        'open',
        'test'
      );

      clearControllerBackoff(isolated.projectId);
      const beforeRow = db
        .prepare(
          'SELECT MAX(id) as id FROM orchestration_runs WHERE project_id = ?'
        )
        .get(isolated.projectId) as { id: number | null };
      startControllerOrchestration({
        project: { ...project, orchestrator_engine: 'langgraph' },
        controller,
        taskPrompt:
          'controller should stay idle when issues are waiting on user',
        activitySnapshot: 'waiting-user-snapshot',
      });

      const deadline = Date.now() + 5000;
      let latest: any;
      while (Date.now() < deadline) {
        latest = db
          .prepare(
            'SELECT id, decision, controller_started, dispatch_count, backoff_ms, backoff_reason, backoff_label FROM orchestration_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1'
          )
          .get(isolated.projectId) as any;
        if (latest && latest.id !== beforeRow?.id) break;
        await sleep(50);
      }

      assert.ok(
        latest && latest.id !== beforeRow?.id,
        '应写入新的 orchestration run'
      );
      assert.equal(latest.decision, 'finish');
      assert.equal(latest.controller_started, 0);
      assert.equal(latest.dispatch_count, 0);
      assert.equal(latest.backoff_label, 'waiting_user');
      assert.equal(latest.backoff_ms, 30 * 60 * 1000);
      assert.match(String(latest.backoff_reason || ''), /waiting on user/);

      const backoff = getControllerBackoff(isolated.projectId);
      assert.ok(backoff, '应记录 controller backoff');
      assert.equal(backoff?.label, 'waiting_user');

      db.prepare('DELETE FROM issues WHERE id = ?').run(issueId);
      clearControllerBackoff(isolated.projectId);
    });

    it('needs_user auto-handoff clears acknowledged_at so inbox marks it action-required again', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const { reconcileNeedsUserOutcomes } = await import(
        '../../src/services/langgraph-runner'
      );
      const isolated = await createIsolatedOrchestrationProject(
        'needs-user-ack'
      );

      const { status: workerStatus, body: worker } = await ctx.api(
        `/api/projects/${isolated.projectId}/agents`,
        {
          method: 'POST',
          body: {
            name: `needs-user-worker-${Date.now()}`,
            role: 'needs user regression worker',
            command_template: 'echo',
          },
        }
      );
      assert.equal(workerStatus, 201);

      const db = getDatabase();
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(isolated.projectId) as any;
      const agents = db
        .prepare('SELECT * FROM agents WHERE project_id = ?')
        .all(isolated.projectId) as any[];
      const issueId = `needs-user-ack-${Date.now()}`;
      const issueRow = db
        .prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?')
        .get(isolated.projectId) as { n: number | null };
      const issueNumber = (issueRow?.n || 0) + 1;

      db.prepare(
        `
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, acknowledged_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 minutes'), datetime('now', '-10 minutes'))
      `
      ).run(
        issueId,
        isolated.projectId,
        issueNumber,
        'needs_user acknowledged regression',
        'worker is waiting on the user',
        'user',
        worker.id,
        1,
        'open'
      );

      const result = reconcileNeedsUserOutcomes(
        project,
        [
          {
            agentId: worker.id,
            signal: 'needs_user',
            summary:
              'latest output indicates user decision/confirmation is needed',
            excerpt: 'waiting for user confirmation',
            issueCount: 1,
            issueIds: [issueId],
            issueNumbers: [issueNumber],
          },
        ] as any,
        agents
      );

      assert.equal(result.movedCount, 1);

      const updated = db
        .prepare('SELECT assigned_to, acknowledged_at FROM issues WHERE id = ?')
        .get(issueId) as
        | { assigned_to: string | null; acknowledged_at: string | null }
        | undefined;
      assert.equal(updated?.assigned_to, 'user');
      assert.equal(updated?.acknowledged_at, null);

      const { body: notifications } = await ctx.api('/api/notifications');
      const found = notifications.user_issues.find(
        (issue: any) => issue.id === issueId
      );
      assert.ok(found, 'auto-handed-off issue should appear in notifications');
      assert.equal(
        found.acknowledged_at,
        null,
        'auto-handed-off issue should be unread/action-required again'
      );
    });

    it('controller trigger respects unchanged backoff snapshot', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const { triggerControllerAgent } = await import(
        '../../src/services/controller'
      );
      const {
        applyControllerBackoff,
        buildControllerActivitySnapshot,
        clearControllerBackoff,
      } = await import('../../src/services/controller-backoff');
      const isolated = await createIsolatedOrchestrationProject(
        'backoff-snapshot'
      );

      const db = getDatabase();
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(isolated.projectId) as any;
      const issueId = `trigger-wait-${Date.now()}`;
      const issueRow = db
        .prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?')
        .get(isolated.projectId) as { n: number | null };
      const issueNumber = (issueRow?.n || 0) + 1;

      db.prepare(
        `
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `
      ).run(
        issueId,
        isolated.projectId,
        issueNumber,
        'backoff snapshot issue',
        'still waiting',
        'test',
        'user',
        1,
        'open',
        'test'
      );

      const beforeRow = db
        .prepare(
          'SELECT MAX(id) as id FROM orchestration_runs WHERE project_id = ?'
        )
        .get(isolated.projectId) as { id: number | null };
      const snapshot = buildControllerActivitySnapshot(isolated.projectId);
      applyControllerBackoff(isolated.projectId, {
        source: 'waiting_user',
        snapshot,
        ms: 30 * 60 * 1000,
        reason: 'user still needs to reply',
        label: 'waiting_user',
      });

      triggerControllerAgent(project, false, 1);
      await sleep(150);

      const afterRow = db
        .prepare(
          'SELECT MAX(id) as id FROM orchestration_runs WHERE project_id = ?'
        )
        .get(isolated.projectId) as { id: number | null };
      assert.equal(
        afterRow?.id || null,
        beforeRow?.id || null,
        'backoff 生效时不应新增 orchestration run'
      );

      db.prepare('DELETE FROM issues WHERE id = ?').run(issueId);
      clearControllerBackoff(isolated.projectId);
    });

    it('fresh activity clears backoff and bypasses debounce', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const { triggerControllerAgent } = await import(
        '../../src/services/controller'
      );
      const { clearControllerBackoff, getControllerBackoff } = await import(
        '../../src/services/controller-backoff'
      );
      const isolated = await createIsolatedOrchestrationProject(
        'backoff-bypass'
      );

      const db = getDatabase();
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(isolated.projectId) as any;
      const issueId = `fresh-activity-${Date.now()}`;

      db.prepare(
        `
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `
      ).run(
        issueId,
        isolated.projectId,
        'fresh activity issue',
        'waiting on user',
        'test',
        'user',
        1,
        'open',
        'test'
      );

      clearControllerBackoff(isolated.projectId);
      triggerControllerAgent(project, false, 1);

      const firstDeadline = Date.now() + 5000;
      let firstRun: any;
      while (Date.now() < firstDeadline) {
        firstRun = db
          .prepare(
            'SELECT id, decision, controller_started, backoff_label FROM orchestration_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1'
          )
          .get(isolated.projectId) as any;
        if (firstRun?.backoff_label === 'waiting_user') break;
        await sleep(50);
      }

      assert.ok(firstRun?.id, '首次 waiting_user 调度应写入 orchestration run');
      assert.equal(firstRun.controller_started, 0);
      assert.equal(firstRun.backoff_label, 'waiting_user');
      assert.ok(
        getControllerBackoff(isolated.projectId),
        '首次调度后应存在 backoff'
      );

      db.prepare(
        "UPDATE issues SET assigned_to = 'all', updated_at = datetime('now', '+1 second') WHERE id = ?"
      ).run(issueId);

      triggerControllerAgent(project, false);

      const secondDeadline = Date.now() + 5000;
      let secondRun: any;
      while (Date.now() < secondDeadline) {
        secondRun = db
          .prepare(
            'SELECT id, decision, controller_started, backoff_label FROM orchestration_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1'
          )
          .get(isolated.projectId) as any;
        if (secondRun && secondRun.id !== firstRun.id) break;
        await sleep(50);
      }

      assert.ok(
        secondRun && secondRun.id !== firstRun.id,
        '新活动应绕过 debounce，立即生成新的 orchestration run'
      );
      assert.equal(secondRun.decision, 'execute_controller');
      assert.equal(secondRun.controller_started, 1);
      assert.equal(
        getControllerBackoff(isolated.projectId),
        undefined,
        '真实新活动后应清除旧 backoff'
      );

      db.prepare('DELETE FROM issues WHERE id = ?').run(issueId);
      clearControllerBackoff(isolated.projectId);
    });

    it('issue scan resumes idle worker for ready pending issue after blocker resolves', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const { runIssueScanOnce } = await import('../../src/services/scheduler');
      const isolated = await createIsolatedOrchestrationProject(
        'scan-pending-worker'
      );

      const { status: workerStatus, body: worker } = await ctx.api(
        `/api/projects/${isolated.projectId}/agents`,
        {
          method: 'POST',
          body: {
            name: `scan-worker-${Date.now()}`,
            role: 'scan recovery worker',
            command_template: 'echo',
          },
        }
      );
      assert.equal(workerStatus, 201);

      const db = getDatabase();
      const blockerId = `scan-blocker-${Date.now()}`;
      const blockedId = `scan-blocked-${Date.now()}`;
      const relationId = `scan-rel-${Date.now()}`;
      const issueRow = db
        .prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?')
        .get(isolated.projectId) as { n: number | null };
      const blockerNumber = (issueRow?.n || 0) + 1;
      const blockedNumber = blockerNumber + 1;

      db.prepare(
        `
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-10 minutes'))
      `
      ).run(
        blockerId,
        isolated.projectId,
        blockerNumber,
        'resolved blocker',
        'done blocker',
        'test',
        worker.id,
        1,
        'done',
        'test'
      );

      db.prepare(
        `
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-10 minutes'))
      `
      ).run(
        blockedId,
        isolated.projectId,
        blockedNumber,
        'blocked pending recovery',
        'resume me after blocker resolves',
        'test',
        worker.id,
        1,
        'pending',
        'test'
      );

      db.prepare(
        'INSERT INTO issue_relations (id, from_issue_id, to_issue_id, relation_type, created_by) VALUES (?, ?, ?, ?, ?)'
      ).run(relationId, blockerId, blockedId, 'blocks', 'test');

      runIssueScanOnce();

      const deadline = Date.now() + 3000;
      let updatedIssue: any;
      let updatedAgent: any;
      while (Date.now() < deadline) {
        updatedIssue = db
          .prepare('SELECT status FROM issues WHERE id = ?')
          .get(blockedId) as any;
        updatedAgent = db
          .prepare('SELECT last_prompt FROM agents WHERE id = ?')
          .get(worker.id) as any;
        if (
          updatedIssue?.status === 'in_progress' &&
          String(updatedAgent?.last_prompt || '').includes(
            'blocked pending recovery'
          )
        )
          break;
        await sleep(50);
      }

      assert.equal(updatedIssue?.status, 'in_progress');
      assert.match(
        String(updatedAgent?.last_prompt || ''),
        /blocked pending recovery/
      );
    });

    it('issue scan does not repeatedly wake the same worker for the same unchanged issue batch', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const { runIssueScanOnce } = await import('../../src/services/scheduler');
      const { resetAgentWakeupState } = await import(
        '../../src/services/agent-wakeup-guard'
      );
      const isolated = await createIsolatedOrchestrationProject(
        'scan-dedup-worker'
      );

      const { status: workerStatus, body: worker } = await ctx.api(
        `/api/projects/${isolated.projectId}/agents`,
        {
          method: 'POST',
          body: {
            name: `scan-dedup-worker-${Date.now()}`,
            role: 'scan dedup worker',
            command_template: 'echo',
          },
        }
      );
      assert.equal(workerStatus, 201);

      const db = getDatabase();
      const issueId = `scan-dedup-issue-${Date.now()}`;
      const issueRow = db
        .prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?')
        .get(isolated.projectId) as { n: number | null };
      const issueNumber = (issueRow?.n || 0) + 1;

      db.prepare(
        `
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-10 minutes'))
      `
      ).run(
        issueId,
        isolated.projectId,
        issueNumber,
        'dedup open issue',
        'should only auto-wake once while unchanged',
        'test',
        worker.id,
        1,
        'open',
        'test'
      );

      resetAgentWakeupState(worker.id);

      runIssueScanOnce();

      const firstDeadline = Date.now() + 3000;
      let firstPromptCount = 0;
      while (Date.now() < firstDeadline) {
        firstPromptCount =
          (
            db
              .prepare(
                "SELECT COUNT(*) as c FROM conversation_logs WHERE agent_id = ? AND stream = 'stdin'"
              )
              .get(worker.id) as any
          )?.c || 0;
        if (firstPromptCount >= 1) break;
        await sleep(50);
      }
      assert.equal(
        firstPromptCount,
        1,
        'first scan should start the worker once'
      );

      const idleDeadline = Date.now() + 3000;
      let workerState: any;
      while (Date.now() < idleDeadline) {
        workerState = db
          .prepare('SELECT status FROM agents WHERE id = ?')
          .get(worker.id) as any;
        if (workerState?.status === 'idle') break;
        await sleep(50);
      }
      assert.equal(
        workerState?.status,
        'idle',
        'echo worker should have finished before second scan'
      );

      runIssueScanOnce();
      await sleep(300);

      const secondPromptCount =
        (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM conversation_logs WHERE agent_id = ? AND stream = 'stdin'"
            )
            .get(worker.id) as any
        )?.c || 0;
      assert.equal(
        secondPromptCount,
        1,
        'second scan should not re-wake the same unchanged issue batch'
      );
    });

    it('issue assignment auto-start includes all dispatchable assigned issues, including ready pending ones', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const isolated = await createIsolatedOrchestrationProject(
        'issue-autostart-batch'
      );

      const { status: workerStatus, body: worker } = await ctx.api(
        `/api/projects/${isolated.projectId}/agents`,
        {
          method: 'POST',
          body: {
            name: `issue-autostart-worker-${Date.now()}`,
            role: 'issue autostart batch worker',
            command_template: 'echo',
          },
        }
      );
      assert.equal(workerStatus, 201);

      const db = getDatabase();
      const nextIssueNumber = () => {
        const row = db
          .prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?')
          .get(isolated.projectId) as { n: number | null };
        return (row?.n || 0) + 1;
      };

      db.prepare(
        `
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-12 minutes'), datetime('now', '-12 minutes'))
      `
      ).run(
        `ready-pending-${Date.now()}`,
        isolated.projectId,
        nextIssueNumber(),
        'ready pending issue',
        'should be included in assigned issue batch',
        'test',
        worker.id,
        3,
        'pending',
        'test'
      );

      db.prepare(
        `
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-11 minutes'), datetime('now', '-11 minutes'))
      `
      ).run(
        `existing-open-${Date.now()}`,
        isolated.projectId,
        nextIssueNumber(),
        'existing open issue',
        'already assigned before trigger',
        'test',
        worker.id,
        2,
        'open',
        'test'
      );

      const createRes = await ctx.api(
        `/api/projects/${isolated.projectId}/issues`,
        {
          method: 'POST',
          body: {
            title: 'trigger assigned issue',
            body: 'this user-created issue should wake the worker with the full batch',
            created_by: 'user',
            assigned_to: worker.id,
          },
        }
      );
      assert.equal(createRes.status, 201);

      const idleState = await waitForAgentStatus(
        worker.id,
        (status) => status === 'idle',
        3000
      );
      assert.equal(
        idleState.status,
        'idle',
        'echo worker should finish quickly'
      );

      const { body: workerAfter } = await ctx.api(`/api/agents/${worker.id}`);
      const prompt = String(workerAfter.last_prompt || '');
      assert.match(prompt, /Current batch \(2\/3 assigned issue\(s\)\)/);
      assert.match(prompt, /ready pending issue/);
      assert.match(prompt, /existing open issue/);
      assert.match(prompt, /trigger assigned issue/);
      assert.match(prompt, /#\d+ \[pending\] \[p3\] ready pending issue/);
    });

    it('worker finish immediately starts the next changed issue batch without waiting for scheduler', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const { autoStartAgentForDispatchableIssues } = await import(
        '../../src/services/issue/agent-autostart'
      );
      const { resetAgentWakeupState } = await import(
        '../../src/services/agent-wakeup-guard'
      );
      const isolated = await createIsolatedOrchestrationProject(
        'issue-finish-next-batch'
      );

      const workerScriptDir = fs.mkdtempSync(
        path.join(require('os').tmpdir(), 'haico-finish-worker-')
      );
      const workerScriptPath = path.join(workerScriptDir, 'worker.sh');
      fs.writeFileSync(workerScriptPath, '#!/bin/sh\nsleep 0.4\n', {
        mode: 0o755,
      });

      try {
        const { status: workerStatus, body: worker } = await ctx.api(
          `/api/projects/${isolated.projectId}/agents`,
          {
            method: 'POST',
            body: {
              name: `finish-next-batch-worker-${Date.now()}`,
              role: 'finish next batch worker',
              command_template: workerScriptPath,
            },
          }
        );
        assert.equal(workerStatus, 201);

        const db = getDatabase();
        const project = db
          .prepare('SELECT * FROM projects WHERE id = ?')
          .get(isolated.projectId) as any;
        const nextIssueNumber = () => {
          const row = db
            .prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?')
            .get(isolated.projectId) as { n: number | null };
          return (row?.n || 0) + 1;
        };
        const createAssignedIssue = (
          id: string,
          title: string,
          priority: number,
          createdAtOffsetMinutes: number
        ) => {
          db.prepare(
            `
            INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))
          `
          ).run(
            id,
            isolated.projectId,
            nextIssueNumber(),
            title,
            `${title} body`,
            'test',
            worker.id,
            priority,
            'open',
            'test',
            `${createdAtOffsetMinutes} minutes`,
            `${createdAtOffsetMinutes} minutes`
          );
        };

        const firstIssueId = `finish-batch-1-${Date.now()}`;
        const secondIssueId = `finish-batch-2-${Date.now()}`;
        const thirdIssueId = `finish-batch-3-${Date.now()}`;
        createAssignedIssue(firstIssueId, 'finish batch issue 1', 5, -12);
        createAssignedIssue(secondIssueId, 'finish batch issue 2', 4, -11);
        createAssignedIssue(thirdIssueId, 'finish batch issue 3', 3, -10);

        resetAgentWakeupState(worker.id);
        const startResult = autoStartAgentForDispatchableIssues(
          db,
          project,
          worker,
          {
            source: 'test-finish-next-batch',
            allowStatuses: ['idle'],
          }
        );
        assert.equal(startResult.started, true);

        await waitForAgentStatus(
          worker.id,
          (status) => status === 'running',
          3000
        );

        db.prepare(
          "UPDATE issues SET status = 'done', updated_at = datetime('now') WHERE id = ?"
        ).run(firstIssueId);

        const secondPromptDeadline = Date.now() + 5000;
        let stdinCount = 0;
        let workerAfter: any;
        while (Date.now() < secondPromptDeadline) {
          stdinCount =
            (
              db
                .prepare(
                  "SELECT COUNT(*) as c FROM conversation_logs WHERE agent_id = ? AND stream = 'stdin'"
                )
                .get(worker.id) as any
            )?.c || 0;
          workerAfter = db
            .prepare('SELECT last_prompt, status FROM agents WHERE id = ?')
            .get(worker.id) as any;
          if (
            stdinCount >= 2 &&
            String(workerAfter?.last_prompt || '').includes(
              'finish batch issue 3'
            )
          )
            break;
          await sleep(50);
        }

        assert.equal(
          stdinCount,
          2,
          'worker should be restarted for the next batch immediately after finish'
        );
        assert.match(
          String(workerAfter?.last_prompt || ''),
          /Current batch \(2\/2 assigned issue\(s\)\)/
        );
        assert.match(
          String(workerAfter?.last_prompt || ''),
          /finish batch issue 2/
        );
        assert.match(
          String(workerAfter?.last_prompt || ''),
          /finish batch issue 3/
        );
      } finally {
        fs.rmSync(workerScriptDir, { recursive: true, force: true });
      }
    });

    it('issue scan triggers controller recovery for ready pending controller issue', async () => {
      const { getDatabase } = await import('../../src/db/database');
      const { runIssueScanOnce } = await import('../../src/services/scheduler');
      const isolated = await createIsolatedOrchestrationProject(
        'scan-pending-controller'
      );

      const db = getDatabase();
      const issueId = `scan-controller-${Date.now()}`;
      const issueRow = db
        .prepare('SELECT MAX(number) as n FROM issues WHERE project_id = ?')
        .get(isolated.projectId) as { n: number | null };
      const issueNumber = (issueRow?.n || 0) + 1;

      db.prepare(
        `
        INSERT INTO issues (id, project_id, number, title, body, created_by, assigned_to, priority, status, labels, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-10 minutes'))
      `
      ).run(
        issueId,
        isolated.projectId,
        issueNumber,
        'controller pending recovery',
        'controller should resume this pending issue',
        'test',
        isolated.controllerId,
        5,
        'pending',
        'test'
      );

      const beforeRow = db
        .prepare(
          'SELECT MAX(id) as id FROM orchestration_runs WHERE project_id = ?'
        )
        .get(isolated.projectId) as { id: number | null };
      runIssueScanOnce();

      const deadline = Date.now() + 5000;
      let latest: any;
      while (Date.now() < deadline) {
        latest = db
          .prepare(
            'SELECT id, decision, controller_started FROM orchestration_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1'
          )
          .get(isolated.projectId) as any;
        if (latest && latest.id !== beforeRow?.id) break;
        await sleep(50);
      }

      assert.ok(
        latest && latest.id !== beforeRow?.id,
        'issue scan 应触发 controller recovery'
      );
      assert.equal(latest.decision, 'execute_controller');
      assert.equal(latest.controller_started, 1);
    });

    it('large prompts are truncated in HAICO_PROMPT env but full prompt remains in prompt file', async () => {
      const agentId = await createMockWorker(
        `large-prompt-worker-${Date.now()}`
      );
      const marker = 'TAIL_SESSION';
      const hugePrompt = 'A'.repeat(18000) + marker;

      const startRes = await ctx.api(`/api/agents/${agentId}/start`, {
        method: 'POST',
        body: { prompt: hugePrompt },
      });
      assert.equal(startRes.status, 200);

      const finalState = await waitForAgentStatus(
        agentId,
        (status) => status === 'idle',
        7000
      );
      assert.equal(finalState.status, 'idle');

      const { body: logs } = await ctx.api(`/api/agents/${agentId}/logs`);
      const promptLog = logs.find((entry: any) => entry.stream === 'stdin');
      assert.ok(promptLog, '应记录输入 prompt');
      assert.match(String(promptLog.content || ''), /TAIL_SESSION/);
    });

    it('低产出 run 不触发 cooldown，agent 运行完毕后恢复 idle（cooldown 和低产出跟踪已移除）', async () => {
      const { isAgentInCooldown } = await import(
        '../../src/services/process-manager'
      );
      const agentId = await createMockWorker(`cooldown-worker-${Date.now()}`);

      const startRes = await ctx.api(`/api/agents/${agentId}/start`, {
        method: 'POST',
        body: { prompt: 'LOW_OUTPUT first low-output run' },
      });
      assert.equal(startRes.status, 200);

      const finalState = await waitForAgentStatus(
        agentId,
        (status) => status !== 'running' && status !== 'waiting'
      );
      assert.equal(finalState.status, 'idle');
      // Cooldown is disabled — always returns false
      assert.equal(isAgentInCooldown(agentId), false);
    });

    it('低产出 session 尾巴检测已移除，agent 正常完成后变为 idle', async () => {
      // Tail-kill (intra-session consecutive low-output detection) was removed in refactor.
      // Agents now simply run to completion and return to idle.
      const agentId = await createMockWorker(`tail-worker-${Date.now()}`);
      const startRes = await ctx.api(`/api/agents/${agentId}/start`, {
        method: 'POST',
        body: { prompt: 'LOW_OUTPUT run completes normally' },
      });
      assert.equal(startRes.status, 200);

      const finalState = await waitForAgentStatus(
        agentId,
        (status) => status === 'idle',
        7000
      );
      assert.equal(finalState.status, 'idle');
    });

    it('API 连接连续失败两次后停止，并保持 5 分钟重试常量', async () => {
      const agentId = await createMockWorker(`api-retry-worker-${Date.now()}`);
      const originalSetTimeout = global.setTimeout;
      const seenDelays: number[] = [];

      (global as any).setTimeout = ((
        handler: (...args: any[]) => void,
        delay?: number,
        ...args: any[]
      ) => {
        const ms = Number(delay ?? 0);
        seenDelays.push(ms);
        const actualDelay = ms === 5 * 60 * 1000 ? 10 : ms;
        return originalSetTimeout(handler as any, actualDelay, ...args);
      }) as typeof setTimeout;

      try {
        const startRes = await ctx.api(`/api/agents/${agentId}/start`, {
          method: 'POST',
          body: { prompt: 'API_RETRY_FAIL should retry then stop' },
        });
        assert.equal(startRes.status, 200);

        const finalState = await waitForAgentStatus(
          agentId,
          (status) => status === 'error',
          5000
        );
        assert.equal(finalState.status, 'error');
      } finally {
        (global as any).setTimeout = originalSetTimeout;
      }

      assert.ok(seenDelays.includes(5 * 60 * 1000), '应保留 5 分钟重试常量');

      const { body: logs } = await ctx.api(`/api/agents/${agentId}/logs`);
      const joined = logs.map((entry: any) => entry.content).join('\n');
      assert.match(joined, /5分钟后自动重试/);
      assert.match(joined, /API连接持续失败/);
    });

    it('pre-controller 会直接启动 idle worker（cooldown 已移除，低产出不再阻塞重启）', async () => {
      const { tryHandleWithoutLLM } = await import(
        '../../src/services/pre-controller'
      );
      const { isAgentInCooldown } = await import(
        '../../src/services/process-manager'
      );

      const directStartAgentId = await createMockWorker(
        `prectrl-run-${Date.now()}`
      );
      const directStartIssueNumber = await insertAssignedIssue(
        directStartAgentId,
        'PRECTRL_KEEPALIVE'
      );
      const mainProjectId = await getMainProjectId();
      const handled = tryHandleWithoutLLM(
        mainProjectId,
        directStartIssueNumber
      );
      assert.equal(handled, true);

      const runningState = await waitForAgentStatus(
        directStartAgentId,
        (status) => status === 'running',
        2000
      );
      assert.equal(runningState.status, 'running');

      await ctx.api(`/api/agents/${directStartAgentId}/stop`, {
        method: 'POST',
      });
      const stoppedState = await waitForAgentStatus(
        directStartAgentId,
        (status) => status !== 'running',
        7000
      );
      assert.notEqual(stoppedState.status, 'running');

      // Cooldown is disabled — isAgentInCooldown always returns false after refactor
      const cooldownAgentId = await createMockWorker(
        `prectrl-cooldown-${Date.now()}`
      );
      const lowOutputStart = await ctx.api(
        `/api/agents/${cooldownAgentId}/start`,
        {
          method: 'POST',
          body: { prompt: 'LOW_OUTPUT cooldown gate run' },
        }
      );
      assert.equal(lowOutputStart.status, 200);
      const cooldownState = await waitForAgentStatus(
        cooldownAgentId,
        (status) => status !== 'running' && status !== 'waiting'
      );
      assert.equal(cooldownState.status, 'idle');
      // Cooldown always disabled
      assert.equal(isAgentInCooldown(cooldownAgentId), false);

      // Since no cooldown, pre-controller should still start agent directly
      const cooldownIssueNumber = await insertAssignedIssue(
        cooldownAgentId,
        'PRECTRL_KEEPALIVE'
      );
      const handled2 = tryHandleWithoutLLM(mainProjectId, cooldownIssueNumber);
      assert.equal(handled2, true);
    });
  });
}
