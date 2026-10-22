import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyManagerRuntimeRefreshed, subscribeManagerRuntimeRefreshed } from '../../src/utils/manager-runtime-events.ts';

// 验证一次通知分别刷新各页面，并且页面离开后的清理可重复执行。
test('业务连接刷新通知只送达当前订阅者，取消订阅后不再刷新', () => {
  const target = new EventTarget();
  const calls = [];
  const unsubscribeModules = subscribeManagerRuntimeRefreshed(() => calls.push('modules'), target);
  const unsubscribeOverview = subscribeManagerRuntimeRefreshed(() => calls.push('overview'), target);
  assert.deepEqual(calls, []);
  notifyManagerRuntimeRefreshed(target);
  assert.deepEqual(calls, ['modules', 'overview']);
  unsubscribeModules();
  unsubscribeModules();
  notifyManagerRuntimeRefreshed(target);
  assert.deepEqual(calls, ['modules', 'overview', 'overview']);
  unsubscribeOverview();
  notifyManagerRuntimeRefreshed(target);
  assert.equal(calls.length, 3);
});

// 验证其他应用事件与独立事件目标不会触发业务连接刷新。
test('业务连接刷新事件与其他事件、其他事件目标隔离', () => {
  const target = new EventTarget();
  let calls = 0;
  const unsubscribe = subscribeManagerRuntimeRefreshed(() => { calls += 1; }, target);
  target.dispatchEvent(new Event('unrelated'));
  notifyManagerRuntimeRefreshed(new EventTarget());
  assert.equal(calls, 0);
  notifyManagerRuntimeRefreshed(target);
  assert.equal(calls, 1);
  unsubscribe();
});

// 验证辅助方法不依赖窗口，页面重新进入后每次通知只触发一个订阅。
test('默认事件目标可在无窗口环境中通知，并支持页面重新订阅', () => {
  let calls = 0;
  const first = subscribeManagerRuntimeRefreshed(() => { calls += 1; });
  notifyManagerRuntimeRefreshed();
  first();
  const second = subscribeManagerRuntimeRefreshed(() => { calls += 1; });
  notifyManagerRuntimeRefreshed();
  second();
  assert.equal(calls, 2);
});
