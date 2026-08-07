import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reconnectManagerRuntime } from '../../src/utils/manager-connection.ts';

// 验证手动重连严格按“清理旧状态、刷新模块地址”的顺序执行。
test('manual reconnect refreshes module addresses after reconnecting', async () => {
  const calls = [];
  const result = await reconnectManagerRuntime('192.168.1.219:17000', {
    setManagerAddr: async (addr, forceReconnect) => calls.push(`set:${addr}:${forceReconnect}`),
    refreshManagerState: async () => {
      calls.push('refresh');
      return 'ready';
    },
  });

  assert.equal(result, 'ready');
  assert.deepEqual(calls, [
    'set:192.168.1.219:17000:true',
    'refresh',
  ]);
});

// 验证模块地址刷新失败时直接保留原始错误，不再启动旧影子实时流。
test('manual reconnect preserves module refresh failure', async () => {
  const calls = [];

  await assert.rejects(
    reconnectManagerRuntime('192.168.1.219:17000', {
      setManagerAddr: async () => calls.push('set'),
      refreshManagerState: async () => {
        calls.push('refresh');
        throw new Error('刷新失败');
      },
    }),
    /刷新失败/,
  );

  assert.deepEqual(calls, ['set', 'refresh']);
});
