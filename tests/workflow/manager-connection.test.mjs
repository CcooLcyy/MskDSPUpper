import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reconnectManagerRuntime } from '../../src/utils/manager-connection.ts';

// 验证手动重连严格按“清理旧状态、刷新模块地址、恢复实时流”的顺序执行。
test('manual reconnect refreshes module addresses before restarting realtime stream', async () => {
  const calls = [];
  const result = await reconnectManagerRuntime('192.168.1.219:17000', {
    setManagerAddr: async (addr, forceReconnect) => calls.push(`set:${addr}:${forceReconnect}`),
    refreshManagerState: async () => {
      calls.push('refresh');
      return 'ready';
    },
    startRealtimeStream: async () => calls.push('stream'),
  });

  assert.equal(result, 'ready');
  assert.deepEqual(calls, [
    'set:192.168.1.219:17000:true',
    'refresh',
    'stream',
  ]);
});

// 验证模块地址刷新失败时仍恢复后台流重试，但连接动作保持失败。
test('manual reconnect restores realtime retries when module address refresh fails', async () => {
  const calls = [];

  await assert.rejects(
    reconnectManagerRuntime('192.168.1.219:17000', {
      setManagerAddr: async () => calls.push('set'),
      refreshManagerState: async () => {
        calls.push('refresh');
        throw new Error('刷新失败');
      },
      startRealtimeStream: async () => calls.push('stream'),
    }),
    /刷新失败/,
  );

  assert.deepEqual(calls, ['set', 'refresh', 'stream']);
});
