import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ─── Final Result 自动Kill (#434/#438) ───

describe('Final Result自动Kill (#434)', () => {
  let getAgentFinalResultAge: (agentId: string) => number;

  before(async () => {
    const pm = await import('../../src/services/process-manager');
    getAgentFinalResultAge = pm.getAgentFinalResultAge;
  });

  it('getAgentFinalResultAge对未知agent返回-1', () => {
    const result = getAgentFinalResultAge('non-existent-agent-xyz');
    assert.equal(result, -1, '未知agent的finalResultAge应返回-1');
  });

  it('FINAL_RESULT_KILL_DELAY_MS已导出且为正数', async () => {
    const { FINAL_RESULT_KILL_DELAY_MS } = await import(
      '../../src/services/process-manager'
    );
    assert.ok(
      typeof FINAL_RESULT_KILL_DELAY_MS === 'number',
      'FINAL_RESULT_KILL_DELAY_MS应为数字'
    );
    assert.ok(
      FINAL_RESULT_KILL_DELAY_MS > 0,
      'FINAL_RESULT_KILL_DELAY_MS应为正数'
    );
    // 默认2分钟
    assert.equal(
      FINAL_RESULT_KILL_DELAY_MS,
      2 * 60 * 1000,
      'FINAL_RESULT_KILL_DELAY_MS应为2分钟'
    );
  });
});

describe('Agent watchdog maintenance', () => {
  it('uses the TaskRun watchdog instead of the removed legacy agent.status watchdog', async () => {
    const { runTaskRunWatchdogScan } = await import(
      '../../src/services/tasks'
    );
    assert.equal(typeof runTaskRunWatchdogScan, 'function');
  });
});

describe('Agent issue batching', () => {
  let getAgentIssueBatch: (issues: any[], maxIssues?: number) => any;
  let buildAssignedIssuesPrompt: (batch: any, options?: any) => string;

  before(async () => {
    const batch = await import('../../src/services/issue/batch');
    getAgentIssueBatch = batch.getAgentIssueBatch;
    buildAssignedIssuesPrompt = batch.buildAssignedIssuesPrompt;
  });

  it('limits each run to a small highest-priority batch', () => {
    const issues = [
      {
        id: '3',
        number: 3,
        title: 'low',
        body: 'low body',
        status: 'open',
        priority: 1,
        created_at: '2026-03-31 10:02:00',
      },
      {
        id: '1',
        number: 1,
        title: 'high-a',
        body: 'high a body',
        status: 'open',
        priority: 5,
        created_at: '2026-03-31 10:00:00',
      },
      {
        id: '2',
        number: 2,
        title: 'high-b',
        body: 'high b body',
        status: 'in_progress',
        priority: 5,
        created_at: '2026-03-31 10:01:00',
      },
    ];

    const batch = getAgentIssueBatch(issues);
    assert.equal(batch.currentBatch.length, 2);
    assert.equal(batch.queuedIssues.length, 1);
    assert.deepEqual(
      batch.currentBatch.map((issue: any) => issue.number),
      [1, 2]
    );
    assert.deepEqual(
      batch.queuedIssues.map((issue: any) => issue.number),
      [3]
    );
  });

  it('prompt explicitly tells the agent to stop after the current batch', () => {
    const batch = getAgentIssueBatch([
      {
        id: '1',
        number: 1,
        title: 'alpha',
        body: 'alpha body',
        status: 'open',
        priority: 5,
        created_at: '2026-03-31 10:00:00',
      },
      {
        id: '2',
        number: 2,
        title: 'beta',
        body: 'beta body',
        status: 'open',
        priority: 4,
        created_at: '2026-03-31 10:01:00',
      },
      {
        id: '3',
        number: 3,
        title: 'gamma',
        body: 'gamma body',
        status: 'open',
        priority: 3,
        created_at: '2026-03-31 10:02:00',
      },
    ]);

    const prompt = buildAssignedIssuesPrompt(batch);
    assert.ok(prompt.includes('Current batch (2/3 assigned issue(s))'));
    assert.ok(prompt.includes('Queued for later (1 more assigned issue(s))'));
    assert.ok(prompt.includes('Only work on the current batch in this run.'));
    assert.ok(prompt.includes('#3 [open] [p3] gamma'));
  });
});

describe('Agent wakeup guard', () => {
  it('suppresses repeated auto-wake for the same unchanged issue batch', async () => {
    const {
      buildAgentWakeupSignature,
      getAgentWakeupDecision,
      recordAgentWakeup,
      resetAgentWakeupState,
    } = await import('../../src/services/agent-wakeup-guard');

    const agent = { id: 'wake-agent-1', status: 'idle', paused: false } as any;
    const issues = [
      {
        id: 'iss-1',
        project_id: 'proj-1',
        number: 1,
        title: 'alpha',
        body: 'alpha',
        created_by: 'user',
        assigned_to: agent.id,
        priority: 5,
        status: 'open',
        labels: '',
        milestone_id: null,
        parent_id: null,
        created_at: '2026-04-01 10:00:00',
        updated_at: '2026-04-01 10:00:00',
      },
    ];

    resetAgentWakeupState(agent.id);
    const first = getAgentWakeupDecision(agent, issues, { source: 'test' });
    assert.equal(first.allowed, true);
    recordAgentWakeup(agent.id, first.signature, 'test', first.activityKey);

    const second = getAgentWakeupDecision(agent, issues, { source: 'test' });
    assert.equal(second.allowed, false);
    assert.match(
      second.reason,
      /same unchanged issue batch already auto-started/i
    );
  });

  it('allows auto-wake again once the issue activity changes', async () => {
    const { getAgentWakeupDecision, recordAgentWakeup, resetAgentWakeupState } =
      await import('../../src/services/agent-wakeup-guard');

    const agent = { id: 'wake-agent-2', status: 'idle', paused: false } as any;
    const baseIssue = {
      id: 'iss-2',
      project_id: 'proj-1',
      number: 2,
      title: 'beta',
      body: 'beta',
      created_by: 'user',
      assigned_to: agent.id,
      priority: 5,
      status: 'open',
      labels: '',
      milestone_id: null,
      parent_id: null,
      created_at: '2026-04-01 10:00:00',
    };
    const toDbTimestamp = (ms: number) =>
      new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    const firstUpdatedAt = toDbTimestamp(Date.now() - 60_000);
    const changedUpdatedAt = toDbTimestamp(Date.now() + 60_000);

    resetAgentWakeupState(agent.id);
    const first = getAgentWakeupDecision(
      agent,
      [{ ...baseIssue, updated_at: firstUpdatedAt }],
      { source: 'test' }
    );
    assert.equal(first.allowed, true);
    recordAgentWakeup(agent.id, first.signature, 'test', first.activityKey);

    const changed = getAgentWakeupDecision(
      agent,
      [{ ...baseIssue, updated_at: changedUpdatedAt }],
      { source: 'test' }
    );
    assert.equal(
      changed.allowed,
      true,
      'updated_at change should count as new activity and allow another wake'
    );
  });

  it('allows a cooled-down retry for the same unchanged issue batch after an error', async () => {
    const {
      buildAgentWakeupSignature,
      getAgentWakeupDecision,
      recordAgentWakeup,
      resetAgentWakeupState,
    } = await import('../../src/services/agent-wakeup-guard');

    const nowMs = Date.now();
    const agent = { id: 'wake-agent-3', status: 'error', paused: false } as any;
    const issues = [
      {
        id: 'iss-3',
        project_id: 'proj-1',
        number: 3,
        title: 'gamma',
        body: 'gamma',
        created_by: 'user',
        assigned_to: agent.id,
        priority: 5,
        status: 'in_progress',
        labels: '',
        milestone_id: null,
        parent_id: null,
        created_at: '2026-04-01 10:00:00',
        updated_at: '2026-04-01 10:00:00',
      },
    ];

    resetAgentWakeupState(agent.id);
    const signatureInfo = buildAgentWakeupSignature(issues);
    recordAgentWakeup(
      agent.id,
      signatureInfo.signature,
      'test',
      signatureInfo.activityKey,
      nowMs - 6 * 60 * 1000
    );

    const retry = getAgentWakeupDecision(agent, issues, {
      source: 'test',
      allowStatuses: ['idle', 'error'],
      nowMs,
    });
    assert.equal(
      retry.allowed,
      true,
      'errored unchanged batch should be allowed a cooled-down retry'
    );
    assert.match(retry.reason, /retrying unchanged issue batch after error/i);
  });

  it('suppresses unchanged error batch after retry budget is exhausted', async () => {
    const {
      buildAgentWakeupSignature,
      getAgentWakeupDecision,
      recordAgentWakeup,
      resetAgentWakeupState,
    } = await import('../../src/services/agent-wakeup-guard');

    const nowMs = Date.now();
    const agent = { id: 'wake-agent-4', status: 'error', paused: false } as any;
    const issues = [
      {
        id: 'iss-4',
        project_id: 'proj-1',
        number: 4,
        title: 'delta',
        body: 'delta',
        created_by: 'user',
        assigned_to: agent.id,
        priority: 5,
        status: 'in_progress',
        labels: '',
        milestone_id: null,
        parent_id: null,
        created_at: '2026-04-01 10:00:00',
        updated_at: '2026-04-01 10:00:00',
      },
    ];

    resetAgentWakeupState(agent.id);
    const signatureInfo = buildAgentWakeupSignature(issues);
    recordAgentWakeup(
      agent.id,
      signatureInfo.signature,
      'test',
      signatureInfo.activityKey,
      nowMs - 18 * 60 * 1000
    );
    recordAgentWakeup(
      agent.id,
      signatureInfo.signature,
      'test',
      signatureInfo.activityKey,
      nowMs - 12 * 60 * 1000
    );
    recordAgentWakeup(
      agent.id,
      signatureInfo.signature,
      'test',
      signatureInfo.activityKey,
      nowMs - 6 * 60 * 1000
    );

    const blocked = getAgentWakeupDecision(agent, issues, {
      source: 'test',
      allowStatuses: ['idle', 'error'],
      nowMs,
    });
    assert.equal(
      blocked.allowed,
      false,
      'unchanged errored batch should stop auto-retrying after the retry budget'
    );
    assert.match(
      blocked.reason,
      /still errors; waiting for issue activity or manual intervention/i
    );
  });
});

describe('Run completion classification', () => {
  let classifyAgentExitStatus: (input: {
    currentStatus?: string | null;
    exitCode: number | null;
    requiresCompletionSignal: boolean;
    sawClosedStdinSessionError: boolean;
    sawCompletionSignal: boolean;
    hadFinalResult: boolean;
  }) => 'idle' | 'error' | 'stopped';

  before(async () => {
    const pm = await import('../../src/services/process-manager');
    classifyAgentExitStatus = pm.classifyAgentExitStatus;
  });

  it('marks structured zero-exit runs without completion as error', () => {
    const status = classifyAgentExitStatus({
      exitCode: 0,
      requiresCompletionSignal: true,
      sawClosedStdinSessionError: false,
      sawCompletionSignal: false,
      hadFinalResult: false,
    });
    assert.equal(status, 'error');
  });

  it('accepts structured completion signals on zero-exit runs', () => {
    const status = classifyAgentExitStatus({
      exitCode: 0,
      requiresCompletionSignal: true,
      sawClosedStdinSessionError: false,
      sawCompletionSignal: true,
      hadFinalResult: false,
    });
    assert.equal(status, 'idle');
  });

  it('keeps plain shell zero-exit runs successful', () => {
    const status = classifyAgentExitStatus({
      exitCode: 0,
      requiresCompletionSignal: false,
      sawClosedStdinSessionError: false,
      sawCompletionSignal: false,
      hadFinalResult: false,
    });
    assert.equal(status, 'idle');
  });

  it('stopped state removed — classifyAgentExitStatus returns idle or error', () => {
    // The 'stopped' state was removed in refactor; the function now only returns idle/error.
    // An exit with code 1 and closed stdin session error → 'error'
    const status = classifyAgentExitStatus({
      currentStatus: 'idle',
      exitCode: 1,
      requiresCompletionSignal: true,
      sawClosedStdinSessionError: true,
      sawCompletionSignal: false,
      hadFinalResult: false,
    });
    assert.equal(status, 'error');
  });
});
