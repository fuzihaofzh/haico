import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';
import { initializeScheduler, stopAllSchedulers } from '../../src/scheduler';

describe('scheduler runtime', () => {
  afterEach(() => {
    stopAllSchedulers();
    mock.restoreAll();
  });

  it('registers and stops the runtime cron tasks', () => {
    const expressions: string[] = [];
    const stopped: string[] = [];

    mock.method(cron, 'schedule', (expression: string) => {
      expressions.push(expression);
      return {
        stop: () => stopped.push(expression),
      } as any;
    });

    initializeScheduler();
    assert.deepEqual(expressions, [
      '0 3 * * *',
      '*/1 * * * *',
      '*/2 * * * *',
      '0 4 * * *',
    ]);

    stopAllSchedulers();
    assert.deepEqual(stopped, expressions);
  });
});
