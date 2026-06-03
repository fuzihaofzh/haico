import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import {
  checkChildCpuActivity,
  clearCpuSnapshot,
} from '../../src/services/process-manager';

describe('Watchdog CPU活跃度检测 (#429)', () => {
  it('首次调用在有子进程时建立基线，否则返回no_children', () => {
    const result = checkChildCpuActivity('test-agent-cpu-1', process.pid);
    assert.ok(
      ['active', 'no_children'].includes(result),
      `首次调用应返回 active 或 no_children，实际: ${result}`
    );
    clearCpuSnapshot('test-agent-cpu-1');
  });

  it('无子进程时返回no_children', () => {
    const result = checkChildCpuActivity('test-agent-cpu-2', 99999999);
    assert.equal(result, 'no_children', '无子进程时应返回 no_children');
    clearCpuSnapshot('test-agent-cpu-2');
  });

  it('当前进程有子进程时CPU变化返回可识别状态', async () => {
    const child: ChildProcess = spawn('sh', [
      '-c',
      'i=0; while [ $i -lt 10000 ]; do i=$((i+1)); done; echo done',
    ]);

    try {
      await new Promise<void>((resolve) => {
        child.stdout?.once('data', () => resolve());
        child.on('close', () => resolve());
        setTimeout(resolve, 2000);
      });

      const pid = child.pid!;
      checkChildCpuActivity('test-agent-cpu-3', pid);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = checkChildCpuActivity('test-agent-cpu-3', pid);
      assert.ok(
        ['active', 'warming', 'no_children'].includes(result),
        `存在子进程时结果应为 active/warming/no_children，实际: ${result}`
      );
    } finally {
      clearCpuSnapshot('test-agent-cpu-3');
      child.kill();
    }
  });

  it('CPU连续不变3次后返回stale（环境无法枚举子进程时允许no_children）', async () => {
    const child: ChildProcess = spawn('sh', [
      '-c',
      'sleep 5 & child=$!; trap "kill $child 2>/dev/null" TERM INT EXIT; wait $child',
    ]);

    try {
      const pid = child.pid!;
      await new Promise((resolve) => setTimeout(resolve, 200));

      const r1 = checkChildCpuActivity('test-agent-stale', pid);
      if (r1 === 'no_children') {
        assert.equal(r1, 'no_children');
        return;
      }
      assert.equal(r1, 'active', '第1次应返回 active（建立基线）');

      await new Promise((resolve) => setTimeout(resolve, 100));
      const r2 = checkChildCpuActivity('test-agent-stale', pid);
      assert.equal(
        r2,
        'warming',
        '第2次CPU未变应返回 warming（staleCount=1）'
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      const r3 = checkChildCpuActivity('test-agent-stale', pid);
      assert.equal(
        r3,
        'warming',
        '第3次CPU未变应返回 warming（staleCount=2）'
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      const r4 = checkChildCpuActivity('test-agent-stale', pid);
      assert.equal(r4, 'stale', '第4次CPU未变应返回 stale（达到阈值）');
    } finally {
      clearCpuSnapshot('test-agent-stale');
      child.kill();
    }
  });

  it('clearCpuSnapshot清除后再次调用返回初始状态', () => {
    checkChildCpuActivity('test-agent-clear', process.pid);
    clearCpuSnapshot('test-agent-clear');

    const result = checkChildCpuActivity('test-agent-clear', process.pid);
    assert.ok(
      ['active', 'no_children'].includes(result),
      `清除快照后应重新进入初始状态，实际: ${result}`
    );
    clearCpuSnapshot('test-agent-clear');
  });
});
