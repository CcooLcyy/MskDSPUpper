import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingControlRouteStore } from '../../src/components/control/usePendingControlRoutes.ts';
import { ControlGroupRoutesError } from '../../src/utils/control-auto-routing.ts';

// 验证切换页面后重新订阅的实例能收到旧请求完成产生的清理通知。
test('映射重试完成会同步当前已挂载的所有订阅实例', () => {
  const pending = new ControlGroupRoutesError(new Error('网络中断'));
  pendingControlRouteStore.update('AGC', pending);
  const oldValues = [];
  const unsubscribeOld = pendingControlRouteStore.subscribe(() => oldValues.push(pendingControlRouteStore.getSnapshot('AGC')));
  unsubscribeOld();
  const currentValues = [];
  const unsubscribeCurrent = pendingControlRouteStore.subscribe(() => currentValues.push(pendingControlRouteStore.getSnapshot('AGC')));
  assert.equal(pendingControlRouteStore.getSnapshot('AGC'), pending);

  pendingControlRouteStore.update('AGC', null);
  assert.deepEqual(oldValues, []);
  assert.deepEqual(currentValues, [null]);
  assert.equal(pendingControlRouteStore.getSnapshot('AGC'), null);
  unsubscribeCurrent();
});

// 验证一个模块清理待处理计划不会丢弃其他模块的失败草稿。
test('待重试计划按模块隔离且重复读取保持快照稳定', () => {
  const agc = new ControlGroupRoutesError(new Error('AGC网络中断'));
  const avc = new ControlGroupRoutesError(new Error('AVC网络中断'));
  pendingControlRouteStore.update('AGC', agc);
  pendingControlRouteStore.update('AVC', avc);
  assert.equal(pendingControlRouteStore.getSnapshot('AGC'), agc);
  assert.equal(pendingControlRouteStore.getSnapshot('AGC'), pendingControlRouteStore.getSnapshot('AGC'));
  pendingControlRouteStore.update('AGC', null);
  assert.equal(pendingControlRouteStore.getSnapshot('AGC'), null);
  assert.equal(pendingControlRouteStore.getSnapshot('AVC'), avc);
  pendingControlRouteStore.update('AVC', null);
});
