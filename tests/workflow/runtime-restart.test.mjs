import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runWithRuntimeRestart } from '../../src/utils/runtime-restart.ts';

// 运行中的分组保存前应先停止，保存后再启动。
test('runtime restart stops, runs, then starts when initial state is running', async () => {
  const calls = [];
  const result = await runWithRuntimeRestart({
    initialState: 2,
    loadState: async () => 1,
    stop: async () => calls.push('stop'),
    run: async () => calls.push('run'),
    start: async () => calls.push('start'),
  });

  assert.deepEqual(calls, ['stop', 'run', 'start']);
  assert.equal(result.stoppedBeforeRun, true);
  assert.equal(result.restartedAfterRun, true);
  assert.equal(result.retriedAfterRunningPrecondition, false);
});

// 已停止的分组不应额外调用停止或启动，只执行保存操作。
test('runtime restart only runs when initial state is stopped', async () => {
  const calls = [];
  const result = await runWithRuntimeRestart({
    initialState: 1,
    stop: async () => calls.push('stop'),
    run: async () => calls.push('run'),
    start: async () => calls.push('start'),
  });

  assert.deepEqual(calls, ['run']);
  assert.equal(result.stoppedBeforeRun, false);
  assert.equal(result.restartedAfterRun, false);
  assert.equal(result.retriedAfterRunningPrecondition, false);
});

// 运行态更新被后端拒绝时，重新读取状态并重试停止、保存、启动流程。
test('runtime restart retries after a running precondition failure', async () => {
  const calls = [];
  const states = [2, 1];
  let runAttempts = 0;

  const result = await runWithRuntimeRestart({
    initialState: 1,
    loadState: async () => {
      calls.push('state');
      return states.shift();
    },
    stop: async () => calls.push('stop'),
    run: async () => {
      calls.push('run');
      runAttempts += 1;
      if (runAttempts === 1) {
        throw new Error('status: FAILED_PRECONDITION, group is running');
      }
    },
    start: async () => calls.push('start'),
  });

  assert.deepEqual(calls, ['run', 'state', 'stop', 'state', 'run', 'start']);
  assert.equal(result.stoppedBeforeRun, true);
  assert.equal(result.restartedAfterRun, true);
  assert.equal(result.retriedAfterRunningPrecondition, true);
});
