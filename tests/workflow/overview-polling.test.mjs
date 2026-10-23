import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { startOverviewPolling } from '../../src/utils/overview-polling.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

// 验证地址尚未就绪或刷新代次已失效时，不发出指标请求。
test('总览轮询在当前地址尚未就绪时不发请求', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = startOverviewPolling({
    isCurrent: () => false,
    read: async () => { calls += 1; },
    onValue: () => assert.fail('不应发布指标'),
    onError: () => assert.fail('不应提示错误'),
    intervalMs: 1000,
  });
  t.after(stop);
  await setImmediate();
  t.mock.timers.tick(5000);
  assert.equal(calls, 0);
});

// 验证第一次吞吐量读取失败后继续重试，成功结果可以替换错误状态。
test('总览吞吐量首次失败后下个周期恢复读取', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const values = [];
  const errors = [];
  let calls = 0;
  const stop = startOverviewPolling({
    isCurrent: () => true,
    read: async () => {
      calls += 1;
      if (calls === 1) throw new Error('DataCenter 暂不可用');
      return { source: 'backend', current_points_per_second: 12 };
    },
    onValue: (value) => values.push(value),
    onError: (error) => errors.push(error.message),
    intervalMs: 1000,
  });
  t.after(stop);
  await setImmediate();
  assert.deepEqual(errors, ['DataCenter 暂不可用']);
  assert.deepEqual(values, []);
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(calls, 2);
  assert.equal(values[0].current_points_per_second, 12);
});

// 验证慢请求结束前不创建下一请求，避免旧采样晚返回覆盖新采样。
test('总览轮询等待慢请求完成后才安排下个周期', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  let calls = 0;
  const stop = startOverviewPolling({
    isCurrent: () => true,
    read: () => { calls += 1; return pending.promise; },
    onValue: () => {},
    onError: () => assert.fail('不应失败'),
    intervalMs: 5000,
  });
  t.after(stop);
  t.mock.timers.tick(20000);
  assert.equal(calls, 1);
  pending.resolve(1);
  await setImmediate();
  t.mock.timers.tick(4999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2);
});

// 验证手动刷新开始后，即使 React 尚未清理旧 effect，旧采样也不能回写或继续调度。
test('总览刷新代次切换后丢弃旧结果并启动新的指标读取', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let generation = 1;
  const pending = deferred();
  const values = [];
  const stopOld = startOverviewPolling({
    isCurrent: () => generation === 1,
    read: () => pending.promise,
    onValue: (value) => values.push(value),
    onError: () => assert.fail('旧请求不应提示'),
    intervalMs: 1000,
  });
  t.after(stopOld);
  generation = 2;
  const stopNew = startOverviewPolling({
    isCurrent: () => generation === 2,
    read: async () => '新指标',
    onValue: (value) => values.push(value),
    onError: () => assert.fail('新请求不应失败'),
    intervalMs: 1000,
  });
  t.after(stopNew);
  pending.resolve('旧指标');
  await setImmediate();
  assert.deepEqual(values, ['新指标']);
  stopNew();
  t.mock.timers.tick(5000);
  await setImmediate();
  assert.deepEqual(values, ['新指标']);
});

// 验证页面卸载后的迟到成功与失败均不更新状态、不弹提示、不重建定时器。
for (const failed of [false, true]) {
  test(`总览取消轮询后忽略迟到${failed ? '失败' : '成功'}并停止调度`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = deferred();
    let calls = 0;
    const stop = startOverviewPolling({
      isCurrent: () => true,
      read: () => { calls += 1; return pending.promise; },
      onValue: () => assert.fail('卸载后不应写状态'),
      onError: () => assert.fail('卸载后不应提示错误'),
      intervalMs: 1000,
    });
    stop();
    stop();
    if (failed) pending.reject(new Error('迟到的失败'));
    else pending.resolve('迟到的成功');
    await setImmediate();
    t.mock.timers.tick(10000);
    assert.equal(calls, 1);
  });
}
