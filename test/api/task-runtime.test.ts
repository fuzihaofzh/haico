import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiTestHarness, createTestSession, type ApiTestHarness } from './helpers';

describe('Task runtime', () => {
  let ctx: ApiTestHarness;

  before(async () => {
    ctx = await createApiTestHarness('task-runtime');
    await createTestSession(ctx);
  });

  after(async () => {
    await ctx.close();
  });

  async function createProject(
    commandTemplate: string,
    opts: { orchestrator_engine?: 'native' | 'langgraph' } = {}
  ): Promise<{ projectId: string; workerId: string; workerName: string }> {
    const project = await ctx.api('/api/projects', {
      method: 'POST',
      body: {
        name: `task-runtime-${Date.now()}`,
        task_description: 'Task runtime test project',
        command_template: commandTemplate,
        ...(opts.orchestrator_engine ? { orchestrator_engine: opts.orchestrator_engine } : {}),
      },
    });
    assert.equal(project.status, 201, project.raw);
    const projectId = project.body.id;

    const worker = await ctx.api(`/api/projects/${projectId}/agents`, {
      method: 'POST',
      body: { name: `worker-${Date.now()}`, role: 'Task runtime worker' },
    });
    assert.equal(worker.status, 201, worker.raw);
    assert.equal(worker.body.runtime_state.status, 'idle');
    assert.ok(worker.body.constraints_json);
    assert.ok(worker.body.context_json);
    assert.ok(worker.body.capabilities_json);
    assert.ok(worker.body.executor_preferences_json);
    return { projectId, workerId: worker.body.id, workerName: worker.body.name };
  }

  async function waitForTaskStatus(taskId: string, expectedStatus: string): Promise<any> {
    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    for (let i = 0; i < 30; i++) {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
      if (row?.status === expectedStatus) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
  }

  it('manual start creates task, task_run, and stdin log', async () => {
    const { workerId } = await createProject('sh -c "cat >/dev/null; echo task-runtime-ok"');

    const start = await ctx.api(`/api/agents/${workerId}/start`, {
      method: 'POST',
      body: { prompt: 'hello task runtime', priority: 7, metadata: { test: true } },
    });
    assert.equal(start.status, 200, start.raw);
    assert.equal(start.body.success, true);
    assert.ok(start.body.task_id);
    assert.ok(start.body.task_run_id);
    assert.ok(start.body.run_id);
    assert.ok(typeof start.body.pid === 'number');

    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(start.body.task_id) as any;
    assert.equal(task.target_agent_id, workerId);
    assert.equal(task.source, 'user-manual');
    assert.equal(task.task_type, 'manual');
    assert.equal(task.priority, 7);
    assert.equal(task.current_task_run_id, start.body.task_run_id);
    assert.match(task.executor_snapshot_json, /command_template/);
    assert.match(task.context_snapshot_json, /Task runtime worker/);

    const taskRun = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(start.body.task_run_id) as any;
    assert.equal(taskRun.task_id, start.body.task_id);
    assert.equal(taskRun.agent_id, workerId);
    assert.equal(taskRun.run_id, start.body.run_id);
    assert.match(taskRun.prompt_snapshot, /hello task runtime/);

    const stdinLog = db.prepare(
      "SELECT * FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stdin'"
    ).get(workerId, start.body.run_id) as any;
    assert.ok(stdinLog);
    assert.match(stdinLog.content, /hello task runtime/);

    for (let i = 0; i < 20; i++) {
      const status = await ctx.api(`/api/agents/${workerId}/status`);
      if (status.body.runtime_state.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const finalTask = db.prepare('SELECT status FROM tasks WHERE id = ?').get(start.body.task_id) as any;
    assert.equal(finalTask.status, 'completed');
  });

  it('queues issue-mention tasks and lets the scheduler start them', async () => {
    const { projectId, workerId, workerName } = await createProject('sh -c "cat >/dev/null; echo mention-task"');

    const issue = await ctx.api(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: {
        title: 'Mention worker through Task runtime',
        body: `Please review this, @${workerName}`,
        created_by: 'user',
      },
    });
    assert.equal(issue.status, 201, issue.raw);

    const { getDatabase } = await import('../../src/db/database');
    const { runTaskSchedulerTick } = await import('../../src/services/tasks');
    const db = getDatabase();
    const task = db.prepare(`
      SELECT *
      FROM tasks
      WHERE target_agent_id = ? AND source = 'issue-mention'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(workerId) as any;
    assert.ok(task);
    assert.equal(task.source_ref, issue.body.id);
    assert.equal(task.task_type, 'issue-work');
    assert.equal(task.status, 'pending');
    assert.match(task.prompt, /Mention worker through Task runtime/);

    const event = db.prepare(`
      SELECT body, meta
      FROM issue_comments
      WHERE issue_id = ? AND author_id = 'system'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(issue.body.id) as any;
    assert.match(event.body, /Task queued/);
    assert.equal(JSON.parse(event.meta).task_id, task.id);

    const tick = runTaskSchedulerTick(5);
    assert.ok(tick.started >= 1);
    assert.ok(tick.taskIds.includes(task.id));

    const completed = await waitForTaskStatus(task.id, 'completed');
    assert.equal(completed.status, 'completed');
  });

  it('queues assigned issue-work tasks without directly starting the agent', async () => {
    const { projectId, workerId } = await createProject('sh -c "cat >/dev/null; echo assigned-task"');

    const issue = await ctx.api(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: {
        title: 'Assigned issue through Task runtime',
        body: 'This should become an issue-work task.',
        created_by: 'user',
        assigned_to: workerId,
      },
    });
    assert.equal(issue.status, 201, issue.raw);

    const { getDatabase } = await import('../../src/db/database');
    const { autoStartAgentForDispatchableIssues } = await import('../../src/services/issue/agent-autostart');
    const { runTaskSchedulerTick } = await import('../../src/services/tasks');
    const db = getDatabase();
    const task = db.prepare(`
      SELECT *
      FROM tasks
      WHERE target_agent_id = ? AND source = 'issue-assignment'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(workerId) as any;
    assert.ok(task);
    assert.equal(task.source_ref, issue.body.id);
    assert.equal(task.task_type, 'issue-work');
    assert.equal(task.status, 'pending');
    assert.match(task.prompt, /Current batch \(1\/1 assigned issue\(s\)\)/);
    assert.match(task.prompt, /Assigned issue through Task runtime/);

    const statusBeforeTick = await ctx.api(`/api/agents/${workerId}/status`);
    assert.notEqual(statusBeforeTick.body.runtime_state.status, 'running');

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(workerId) as any;
    const duplicate = autoStartAgentForDispatchableIssues(db, project, agent, { source: 'test-dedupe' });
    assert.equal(duplicate.started, false);
    assert.match(duplicate.reason, /same unchanged issue batch/i);
    const taskCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE target_agent_id = ? AND source = 'issue-assignment'
    `).get(workerId) as any;
    assert.equal(taskCount.count, 1);

    const tick = runTaskSchedulerTick(5);
    assert.ok(tick.started >= 1);
    assert.ok(tick.taskIds.includes(task.id));

    const completed = await waitForTaskStatus(task.id, 'completed');
    assert.equal(completed.status, 'completed');
  });

  it('queues user-comment tasks for controller reassignment without direct start', async () => {
    const { projectId } = await createProject('sh -c "cat >/dev/null; echo comment-task"');

    const agents = await ctx.api(`/api/projects/${projectId}/agents`);
    const controller = agents.body.find((agent: any) => agent.is_controller);
    assert.ok(controller);

    const issue = await ctx.api(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: {
        title: 'User comment routed through Task runtime',
        body: 'Initial issue body.',
        created_by: 'user',
      },
    });
    assert.equal(issue.status, 201, issue.raw);

    const comment = await ctx.api(`/api/issues/${issue.body.id}/comments`, {
      method: 'POST',
      body: {
        author_id: 'user',
        body: 'No mention here, please review the new context.',
      },
    });
    assert.equal(comment.status, 201, comment.raw);

    const { getDatabase } = await import('../../src/db/database');
    const { runTaskSchedulerTick } = await import('../../src/services/tasks');
    const db = getDatabase();
    const task = db.prepare(`
      SELECT *
      FROM tasks
      WHERE target_agent_id = ? AND source = 'user-comment'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(controller.id) as any;
    assert.ok(task);
    assert.equal(task.source_ref, comment.body.id);
    assert.equal(task.task_type, 'issue-work');
    assert.equal(task.status, 'pending');
    assert.match(task.prompt, /No mention here/);
    assert.match(task.prompt, /User comment routed through Task runtime/);
    db.prepare(`
      UPDATE tasks
      SET status = 'cancelled'
      WHERE target_agent_id = ? AND id <> ? AND status IN ('pending', 'blocked')
    `).run(controller.id, task.id);

    const statusBeforeTick = await ctx.api(`/api/agents/${controller.id}/status`);
    assert.notEqual(statusBeforeTick.body.runtime_state.status, 'running');

    const tick = runTaskSchedulerTick(5);
    assert.ok(tick.started >= 1);
    assert.ok(tick.taskIds.includes(task.id));

    const completed = await waitForTaskStatus(task.id, 'completed');
    assert.equal(completed.status, 'completed');
  });

  it('queues agent-message tasks for direct messages without direct start', async () => {
    const { projectId, workerId } = await createProject('sh -c "cat >/dev/null; echo message-task"');

    const agents = await ctx.api(`/api/projects/${projectId}/agents`);
    const controller = agents.body.find((agent: any) => agent.is_controller);
    assert.ok(controller);

    const message = await ctx.api(`/api/agents/${controller.id}/messages/send`, {
      method: 'POST',
      body: {
        to: workerId,
        subject: 'Please review',
        body: 'Can you review the direct message task path?',
      },
    });
    assert.equal(message.status, 201, message.raw);

    const { getDatabase } = await import('../../src/db/database');
    const { runTaskSchedulerTick } = await import('../../src/services/tasks');
    const db = getDatabase();
    const task = db.prepare(`
      SELECT *
      FROM tasks
      WHERE target_agent_id = ? AND source = 'agent-message'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(workerId) as any;
    assert.ok(task);
    assert.equal(task.source_ref, message.body.id);
    assert.equal(task.task_type, 'message');
    assert.equal(task.status, 'pending');
    assert.match(task.prompt, /Please review/);
    assert.match(task.prompt, /direct message task path/);

    const statusBeforeTick = await ctx.api(`/api/agents/${workerId}/status`);
    assert.notEqual(statusBeforeTick.body.runtime_state.status, 'running');

    const tick = runTaskSchedulerTick(5);
    assert.ok(tick.started >= 1);
    assert.ok(tick.taskIds.includes(task.id));

    const completed = await waitForTaskStatus(task.id, 'completed');
    assert.equal(completed.status, 'completed');
  });

  it('queues native controller orchestration as a controller task', async () => {
    const { projectId } = await createProject('sh -c "cat >/dev/null; echo native-controller-task"', {
      orchestrator_engine: 'native',
    });

    const { getDatabase } = await import('../../src/db/database');
    const { triggerControllerAgent } = await import('../../src/services/controller');
    const { runTaskSchedulerTick } = await import('../../src/services/tasks');
    const db = getDatabase();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    const controller = db.prepare('SELECT * FROM agents WHERE project_id = ? AND is_controller = 1').get(projectId) as any;
    assert.ok(controller);

    triggerControllerAgent(project, true);

    const task = db.prepare(`
      SELECT *
      FROM tasks
      WHERE target_agent_id = ? AND task_type = 'controller'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(controller.id) as any;
    assert.ok(task);
    assert.equal(task.source, 'controller-orchestration');
    assert.equal(task.status, 'pending');
    assert.match(task.prompt, /Project Task/);

    const orch = db.prepare(`
      SELECT *
      FROM orchestration_runs
      WHERE project_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(projectId) as any;
    assert.ok(orch);
    assert.equal(orch.engine, 'native');
    assert.equal(orch.decision, 'execute_controller');
    assert.equal(orch.controller_started, 1);
    assert.match(orch.dispatch_summary, new RegExp(task.id));

    const statusBeforeTick = await ctx.api(`/api/agents/${controller.id}/status`);
    assert.notEqual(statusBeforeTick.body.runtime_state.status, 'running');

    const tick = runTaskSchedulerTick(5);
    assert.ok(tick.started >= 1);
    assert.ok(tick.taskIds.includes(task.id));

    const completed = await waitForTaskStatus(task.id, 'completed');
    assert.equal(completed.status, 'completed');
  });

  it('queues LangGraph worker dispatch as issue-work tasks', async () => {
    const { projectId, workerId } = await createProject('sh -c "cat >/dev/null; echo langgraph-worker-task"', {
      orchestrator_engine: 'native',
    });

    const issue = await ctx.api(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: {
        title: 'LangGraph dispatch issue',
        body: 'The worker should receive a task from LangGraph dispatch.',
        created_by: 'user',
        assigned_to: workerId,
      },
    });
    assert.equal(issue.status, 201, issue.raw);

    const { getDatabase } = await import('../../src/db/database');
    const { runControllerWithLangGraph } = await import('../../src/services/langgraph-runner');
    const { resetAgentWakeupState } = await import('../../src/services/agent-wakeup-guard');
    const db = getDatabase();
    db.prepare("DELETE FROM tasks WHERE target_agent_id = ? AND status = 'pending'").run(workerId);
    resetAgentWakeupState(workerId);

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    const controller = db.prepare('SELECT * FROM agents WHERE project_id = ? AND is_controller = 1').get(projectId) as any;
    const result = await runControllerWithLangGraph({
      project,
      controller,
      taskPrompt: 'Check whether workers need dispatch.',
    });

    assert.equal(result.decision, 'finish');
    assert.equal(result.dispatchCount, 1);
    assert.equal(result.dispatchResults[0]?.agentId, workerId);
    assert.ok(result.dispatchResults[0]?.taskId);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.dispatchResults[0].taskId) as any;
    assert.ok(task);
    assert.equal(task.source, 'langgraph-dispatch');
    assert.equal(task.task_type, 'issue-work');
    assert.equal(task.status, 'pending');
    assert.match(task.prompt, /LangGraph dispatch issue/);
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE project_id = ? AND status IN ('pending', 'blocked')").run(projectId);
  });

  it('queues LangGraph controller execution as a controller task', async () => {
    const { projectId } = await createProject('sh -c "cat >/dev/null; echo langgraph-controller-task"');

    const issue = await ctx.api(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: {
        title: 'Unassigned controller issue',
        body: 'This should require controller action.',
        created_by: 'user',
      },
    });
    assert.equal(issue.status, 201, issue.raw);

    const { getDatabase } = await import('../../src/db/database');
    const { runControllerWithLangGraph } = await import('../../src/services/langgraph-runner');
    const { buildControllerTaskPrompt } = await import('../../src/services/controller');
    const db = getDatabase();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    const controller = db.prepare('SELECT * FROM agents WHERE project_id = ? AND is_controller = 1').get(projectId) as any;

    const result = await runControllerWithLangGraph({
      project,
      controller,
      taskPrompt: buildControllerTaskPrompt(project),
    });

    assert.equal(result.decision, 'execute_controller');
    assert.equal(result.controllerStarted, true);
    assert.ok(result.controllerTaskId);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.controllerTaskId) as any;
    assert.ok(task);
    assert.equal(task.source, 'langgraph-controller');
    assert.equal(task.task_type, 'controller');
    assert.equal(task.status, 'pending');
    assert.match(task.prompt, /Unassigned controller issue/);
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE project_id = ? AND status IN ('pending', 'blocked')").run(projectId);
  });

  it('issue recovery creates task producers instead of direct starts', async () => {
    const { projectId, workerId } = await createProject('sh -c "cat >/dev/null; echo recovery-task"');

    const issue = await ctx.api(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: {
        title: 'Recovery dispatch issue',
        body: 'Recovery should recreate a queued task.',
        created_by: 'user',
        assigned_to: workerId,
      },
    });
    assert.equal(issue.status, 201, issue.raw);

    const { getDatabase } = await import('../../src/db/database');
    const { runIssueRecoveryScan } = await import('../../src/services/issue/recovery');
    const { resetAgentWakeupState } = await import('../../src/services/agent-wakeup-guard');
    const db = getDatabase();
    db.prepare("DELETE FROM tasks WHERE target_agent_id = ? AND status = 'pending'").run(workerId);
    resetAgentWakeupState(workerId);

    const logs: any[] = [];
    runIssueRecoveryScan(db, {
      debug: (...args: any[]) => logs.push(args),
      info: (...args: any[]) => logs.push(args),
      error: (...args: any[]) => logs.push(args),
    });

    const task = db.prepare(`
      SELECT *
      FROM tasks
      WHERE target_agent_id = ? AND source = 'issue-assignment'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(workerId) as any;
    assert.ok(task);
    assert.equal(JSON.parse(task.metadata_json).source, 'issue-recovery');
    assert.equal(task.task_type, 'issue-work');
    assert.equal(task.status, 'pending');
    assert.match(task.prompt, /Recovery dispatch issue/);
  });

  it('rejects a second manual task while the agent has an active task_run', async () => {
    const { workerId } = await createProject('sh -c "sleep 5"');

    const first = await ctx.api(`/api/agents/${workerId}/start`, {
      method: 'POST',
      body: { prompt: 'long task' },
    });
    assert.equal(first.status, 200, first.raw);

    const second = await ctx.api(`/api/agents/${workerId}/start`, {
      method: 'POST',
      body: { prompt: 'should not run' },
    });
    assert.equal(second.status, 409, second.raw);

    const stopped = await ctx.api(`/api/agents/${workerId}/stop`, { method: 'POST' });
    assert.equal(stopped.status, 200, stopped.raw);

    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    const taskRun = db.prepare('SELECT status, failure_kind FROM task_runs WHERE id = ?').get(first.body.task_run_id) as any;
    assert.equal(taskRun.status, 'cancelled');
    assert.equal(taskRun.failure_kind, 'user_stopped');
  });

  it('derives error runtime state from failed task_runs', async () => {
    const { workerId } = await createProject('sh -c "echo failing >&2; exit 42"');

    const start = await ctx.api(`/api/agents/${workerId}/start`, {
      method: 'POST',
      body: { prompt: 'fail please' },
    });
    assert.equal(start.status, 200, start.raw);

    for (let i = 0; i < 20; i++) {
      const status = await ctx.api(`/api/agents/${workerId}/status`);
      if (status.body.runtime_state.status === 'error') {
        assert.equal(status.body.status, 'error');
        assert.equal(status.body.runtime_state.last_task_run_id, start.body.task_run_id);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.fail('agent runtime state did not become error');
  });

  it('returns 400 when retry has no failed or cancelled TaskRun', async () => {
    const { workerId } = await createProject('sh -c "echo ok"');
    const retry = await ctx.api(`/api/agents/${workerId}/retry`, { method: 'POST' });
    assert.equal(retry.status, 400);
    assert.match(retry.body.error, /No previous prompt to retry/);
  });

  it('retries the latest failed TaskRun as a new attempt on the same Task', async () => {
    const { workerId } = await createProject('sh -c "cat >/dev/null; exit 9"');
    const first = await ctx.api(`/api/agents/${workerId}/start`, {
      method: 'POST',
      body: { prompt: 'retry failed task' },
    });
    assert.equal(first.status, 200, first.raw);

    const firstTask = await waitForTaskStatus(first.body.task_id, 'failed');
    assert.equal(firstTask.status, 'failed');

    const retry = await ctx.api(`/api/agents/${workerId}/retry`, {
      method: 'POST',
      body: { force_new_session: true },
    });
    assert.equal(retry.status, 200, retry.raw);
    assert.equal(retry.body.task_id, first.body.task_id);
    assert.notEqual(retry.body.task_run_id, first.body.task_run_id);

    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    const runs = db.prepare(`
      SELECT attempt, status
      FROM task_runs
      WHERE task_id = ?
      ORDER BY attempt ASC
    `).all(first.body.task_id) as Array<{ attempt: number; status: string }>;
    assert.deepEqual(runs.map((run) => run.attempt), [1, 2]);
  });

  it('treats paused agents as a scheduling constraint and does not create manual tasks', async () => {
    const { workerId } = await createProject('sh -c "echo paused-should-not-run"');

    const paused = await ctx.api(`/api/agents/${workerId}/pause`, { method: 'POST' });
    assert.equal(paused.status, 200, paused.raw);

    const start = await ctx.api(`/api/agents/${workerId}/start`, {
      method: 'POST',
      body: { prompt: 'should be rejected while paused' },
    });
    assert.equal(start.status, 409, start.raw);
    assert.match(start.body.error, /paused/i);

    const status = await ctx.api(`/api/agents/${workerId}/status`);
    assert.equal(status.body.runtime_state.status, 'paused');
    assert.equal(status.body.runtime_state.active_task_id, null);
    assert.equal(status.body.runtime_state.active_task_run_id, null);

    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    const taskCount = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE target_agent_id = ?').get(workerId) as any;
    assert.equal(taskCount.count, 0);
  });

  it('snapshots force_new_session into executor session policy', async () => {
    const { workerId } = await createProject('sh -c "echo forced-session"');
    const start = await ctx.api(`/api/agents/${workerId}/start`, {
      method: 'POST',
      body: { prompt: 'force session', force_new_session: true },
    });
    assert.equal(start.status, 200, start.raw);

    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    const task = db.prepare('SELECT executor_snapshot_json, metadata_json FROM tasks WHERE id = ?').get(start.body.task_id) as any;
    const snapshot = JSON.parse(task.executor_snapshot_json);
    const metadata = JSON.parse(task.metadata_json);
    assert.equal(snapshot.session_policy.new_session_per_run, true);
    assert.equal(metadata.force_new_session, true);
  });

  it('syncs project command_template updates into the default executor profile', async () => {
    const { projectId, workerId } = await createProject('sh -c "cat >/dev/null; echo old-profile"');
    const updated = await ctx.api(`/api/projects/${projectId}`, {
      method: 'PUT',
      body: { command_template: 'sh -c "cat >/dev/null; echo new-profile"' },
    });
    assert.equal(updated.status, 200, updated.raw);

    const start = await ctx.api(`/api/agents/${workerId}/start`, {
      method: 'POST',
      body: { prompt: 'use updated executor profile' },
    });
    assert.equal(start.status, 200, start.raw);

    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    const taskRun = db.prepare('SELECT command_snapshot FROM task_runs WHERE id = ?').get(start.body.task_run_id) as any;
    assert.match(taskRun.command_snapshot, /new-profile/);

    for (let i = 0; i < 20; i++) {
      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(start.body.task_id) as any;
      if (row.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const stdoutLog = db.prepare(
      "SELECT content FROM conversation_logs WHERE agent_id = ? AND run_id = ? AND stream = 'stdout' ORDER BY id DESC LIMIT 1"
    ).get(workerId, start.body.run_id) as any;
    assert.match(String(stdoutLog?.content || ''), /new-profile/);
  });

  it('stores executor session continuity outside legacy agent execution fields', async () => {
    const { workerId } = await createProject('sh -c "cat >/dev/null; echo session-ok"');

    const first = await ctx.api(`/api/agents/${workerId}/start`, {
      method: 'POST',
      body: { prompt: 'first session run' },
    });
    assert.equal(first.status, 200, first.raw);
    const firstTask = await waitForTaskStatus(first.body.task_id, 'completed');
    assert.equal(firstTask.status, 'completed');

    const second = await ctx.api(`/api/agents/${workerId}/start`, {
      method: 'POST',
      body: { prompt: 'second session run' },
    });
    assert.equal(second.status, 200, second.raw);
    const secondTask = await waitForTaskStatus(second.body.task_id, 'completed');
    assert.equal(secondTask.status, 'completed');

    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    const task = db.prepare('SELECT executor_profile_id FROM tasks WHERE id = ?').get(first.body.task_id) as any;
    const session = db.prepare(`
      SELECT session_id, run_count
      FROM executor_sessions
      WHERE agent_id = ? AND executor_profile_id = ?
    `).get(workerId, task.executor_profile_id) as any;
    assert.ok(session);
    assert.equal(session.session_id, first.body.run_id);
    assert.equal(session.run_count, 2);

    const agent = db.prepare('SELECT session_id, session_run_count FROM agents WHERE id = ?').get(workerId) as any;
    assert.equal(agent.session_id, null);
    assert.equal(agent.session_run_count, 0);
  });

  it('blocks dependency tasks until dependency completes, then scheduler starts them', async () => {
    const { workerId } = await createProject('sh -c "cat >/dev/null; echo scheduled"');
    const { createManualAgentTask, runTaskImmediately, runTaskSchedulerTick } = await import('../../src/services/tasks');
    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();

    const dependency = createManualAgentTask(workerId, { prompt: 'dependency task' });
    const dependent = createManualAgentTask(workerId, { prompt: 'dependent task' });
    db.prepare(
      "INSERT INTO task_dependencies (task_id, depends_on_task_id, dependency_type) VALUES (?, ?, 'blocks')"
    ).run(dependent.id, dependency.id);

    assert.throws(() => runTaskImmediately(dependent.id), /dependency/i);
    const blocked = db.prepare('SELECT status, failure_kind FROM tasks WHERE id = ?').get(dependent.id) as any;
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.failure_kind, 'dependency_blocked');

    const firstRun = runTaskImmediately(dependency.id);
    assert.ok(firstRun.task_run_id);
    for (let i = 0; i < 20; i++) {
      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(dependency.id) as any;
      if (row.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const tick = runTaskSchedulerTick(5);
    assert.ok(tick.started >= 1);
    assert.ok(tick.taskIds.includes(dependent.id));
  });

  it('records spawn failures on task and task_run', async () => {
    const { workerId } = await createProject('sh -c "echo not used"');
    const { createManualAgentTask } = await import('../../src/services/tasks');
    const { failTaskRunSpawn } = await import('../../src/services/tasks/completion');
    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    const task = createManualAgentTask(workerId, { prompt: 'spawn failure task' });
    const taskRunId = 'spawn-failure-run';
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, project_id, agent_id, executor_profile_id, run_id, attempt,
        status, prompt_snapshot, command_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'starting', ?, ?)
    `).run(
      taskRunId,
      task.id,
      task.project_id,
      workerId,
      task.executor_profile_id,
      'spawn-failure-log-run',
      task.prompt,
      'missing-command'
    );
    db.prepare("UPDATE tasks SET status = 'running', current_task_run_id = ? WHERE id = ?").run(taskRunId, task.id);

    failTaskRunSpawn(taskRunId, 'spawn exploded');

    const taskRun = db.prepare('SELECT status, failure_kind, failure_message FROM task_runs WHERE id = ?').get(taskRunId) as any;
    const failedTask = db.prepare('SELECT status, failure_kind, failure_message FROM tasks WHERE id = ?').get(task.id) as any;
    assert.equal(taskRun.status, 'failed');
    assert.equal(taskRun.failure_kind, 'spawn_failed');
    assert.match(taskRun.failure_message, /spawn exploded/);
    assert.equal(failedTask.status, 'failed');
    assert.equal(failedTask.failure_kind, 'spawn_failed');
  });

  it('lists TaskRun history for an agent', async () => {
    const { workerId } = await createProject('sh -c "cat >/dev/null; echo history"');
    const start = await ctx.api(`/api/agents/${workerId}/start`, {
      method: 'POST',
      body: { prompt: 'history task' },
    });
    assert.equal(start.status, 200, start.raw);
    const completed = await waitForTaskStatus(start.body.task_id, 'completed');
    assert.equal(completed.status, 'completed');

    const history = await ctx.api(`/api/agents/${workerId}/task-runs?limit=5`);
    assert.equal(history.status, 200, history.raw);
    assert.equal(history.body.task_runs[0].task_run_id, start.body.task_run_id);
    assert.equal(history.body.task_runs[0].task_id, start.body.task_id);
    assert.equal(history.body.task_runs[0].attempt, 1);
    assert.equal(history.body.task_runs[0].task_run_status, 'completed');
  });

  it('TaskRun watchdog fails active DB rows with missing processes', async () => {
    const { workerId } = await createProject('sh -c "echo not used"');
    const { createManualAgentTask, runTaskRunWatchdogScan } = await import('../../src/services/tasks');
    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    const task = createManualAgentTask(workerId, { prompt: 'missing process task' });
    const taskRunId = 'missing-process-run';
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, project_id, agent_id, executor_profile_id, run_id, attempt,
        status, prompt_snapshot, command_snapshot, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'running', ?, ?, datetime('now'))
    `).run(
      taskRunId,
      task.id,
      task.project_id,
      workerId,
      task.executor_profile_id,
      'missing-process-log-run',
      task.prompt,
      'missing-command'
    );
    db.prepare("UPDATE tasks SET status = 'running', current_task_run_id = ? WHERE id = ?").run(taskRunId, task.id);

    const result = runTaskRunWatchdogScan(db);
    assert.equal(result.failedMissingProcess, 1);

    const taskRun = db.prepare('SELECT status, failure_kind FROM task_runs WHERE id = ?').get(taskRunId) as any;
    const failedTask = db.prepare('SELECT status, failure_kind FROM tasks WHERE id = ?').get(task.id) as any;
    assert.equal(taskRun.status, 'failed');
    assert.equal(taskRun.failure_kind, 'process_missing');
    assert.equal(failedTask.status, 'failed');
  });

  it('TaskRun watchdog completes lingering processes after Final Result timeout', async () => {
    const { workerId } = await createProject('sh -c "echo not used"');
    const { createManualAgentTask, runTaskRunWatchdogScan } = await import('../../src/services/tasks');
    const { FINAL_RESULT_KILL_DELAY_MS } = await import('../../src/services/process-manager');
    const state = await import('../../src/services/process-manager/state');
    const { getDatabase } = await import('../../src/db/database');
    const db = getDatabase();
    const task = createManualAgentTask(workerId, { prompt: 'final result linger task' });
    const taskRunId = 'final-result-linger-run';
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, project_id, agent_id, executor_profile_id, run_id, attempt,
        status, prompt_snapshot, command_snapshot, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'running', ?, ?, datetime('now'))
    `).run(
      taskRunId,
      task.id,
      task.project_id,
      workerId,
      task.executor_profile_id,
      'final-result-linger-log-run',
      task.prompt,
      'linger-command'
    );
    db.prepare("UPDATE tasks SET status = 'running', current_task_run_id = ? WHERE id = ?").run(taskRunId, task.id);
    state.runningProcesses.set(taskRunId, { kill() {} } as any);
    state.lastActivityTime.set(taskRunId, Date.now());
    state.agentFinalResultTime.set(workerId, Date.now() - FINAL_RESULT_KILL_DELAY_MS - 1000);

    const result = runTaskRunWatchdogScan(db);
    assert.equal(result.completedAfterFinalResult, 1);

    const taskRun = db.prepare('SELECT status, failure_kind FROM task_runs WHERE id = ?').get(taskRunId) as any;
    const completedTask = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as any;
    assert.equal(taskRun.status, 'completed');
    assert.equal(taskRun.failure_kind, null);
    assert.equal(completedTask.status, 'completed');

    state.runningProcesses.delete(taskRunId);
    state.lastActivityTime.delete(taskRunId);
    state.agentFinalResultTime.delete(workerId);
  });
});
