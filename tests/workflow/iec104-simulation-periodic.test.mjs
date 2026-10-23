import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSimulationPeriodicMock, validateSimulationInterval, getSimulationPeriodicInterval } from '../../src/pages/IEC104/simulation-periodic.ts';

function fixture() {
  let now = 1000;
  const contexts = new Map([
    ['甲', { slave: true, hasSimulation: true, active: true }],
    ['乙', { slave: true, hasSimulation: true, active: true }],
    ['主站', { slave: false, hasSimulation: true, active: true }],
  ]);
  const timers = new Map();
  let timerId = 0;
  const mock = createSimulationPeriodicMock({
    now: () => now,
    context: (conn) => contexts.get(conn),
    schedule: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return () => timers.delete(id); },
  });
  return { mock, contexts, timers, time: (value) => { now = value; } };
}

test('周期上报间隔仅允许1至3600整数，拒绝空值和非有限值', () => {
  for (const value of [1, 5, 3600]) assert.equal(validateSimulationInterval(value), value);
  for (const value of [null, 0, -1, 1.5, 3601, NaN, Infinity]) assert.throws(() => validateSimulationInterval(value), /1.*3600/);
});

test('关闭始终使用已生效间隔，不被空或非法草稿阻挡；显式应用间隔仍校验', () => {
  for (const draft of [null, NaN, 0, 1.5, 3601]) {
    assert.equal(getSimulationPeriodicInterval(false, draft, 10), 10);
    assert.throws(() => getSimulationPeriodicInterval(true, draft, 10));
    assert.throws(() => getSimulationPeriodicInterval(false, draft, 10, true));
  }
  assert.equal(getSimulationPeriodicInterval(false, 3, 10, true), 3);
});

test('默认关闭且查询无发送副作用，启用等待周期，重复设置不重建任务', () => {
  const { mock, timers, time } = fixture();
  assert.deepEqual(mock.get('甲'), { conn_name: '甲', enabled: false, interval_seconds: 5, running: false, last_sent_ms: 0 });
  assert.equal(mock.set('甲', true, 5).last_sent_ms, 0);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 5000);
  const timer = [...timers.values()][0];
  mock.set('甲', true, 5);
  assert.equal([...timers.values()][0], timer);
  time(6000);
  assert.equal(mock.get('甲').last_sent_ms, 0);
  timer.callback();
  assert.equal(mock.get('甲').last_sent_ms, 6000);
});

test('断线暂停且恢复不追补，变更间隔重建任务，多连接相互隔离', () => {
  const { mock, contexts, timers, time } = fixture();
  mock.set('甲', true, 5);
  mock.set('乙', true, 1);
  contexts.get('甲').active = false;
  time(6000);
  for (const timer of timers.values()) timer.callback();
  assert.equal(mock.get('甲').running, false);
  assert.equal(mock.get('甲').enabled, true);
  assert.equal(mock.get('甲').last_sent_ms, 0);
  assert.equal(mock.get('乙').last_sent_ms, 6000);
  contexts.get('甲').active = true;
  assert.equal(mock.get('甲').last_sent_ms, 0);
  mock.set('甲', true, 10);
  assert.equal(timers.size, 2);
  assert.deepEqual([...timers.values()].map((timer) => timer.ms).sort((a, b) => a - b), [1000, 10000]);
});

test('校验失败保留已有任务；清除关闭但保留间隔，删除释放任务', () => {
  const { mock, contexts, timers } = fixture();
  mock.set('甲', true, 10);
  assert.throws(() => mock.set('甲', true, 0));
  assert.equal(mock.get('甲').interval_seconds, 10);
  assert.throws(() => mock.set('主站', true, 5), /从站/);
  assert.throws(() => mock.get('不存在'), /连接/);
  contexts.get('乙').hasSimulation = false;
  assert.throws(() => mock.set('乙', true, 5), /模拟/);
  assert.equal(timers.size, 1);
  mock.clear('甲');
  assert.equal(timers.size, 0);
  assert.equal(mock.get('甲').enabled, false);
  assert.equal(mock.get('甲').interval_seconds, 10);
  mock.set('甲', true, 10);
  mock.remove('甲');
  assert.equal(timers.size, 0);
  assert.equal(mock.get('甲').interval_seconds, 5);
});

test('连接重命名迁移状态并释放旧任务，后续回调只查询新连接', () => {
  const { mock, contexts, timers, time } = fixture();
  mock.set('甲', true, 10);
  time(11000);
  [...timers.values()][0].callback();
  contexts.set('新甲', contexts.get('甲'));
  contexts.delete('甲');
  mock.rename('甲', '新甲');
  assert.equal(timers.size, 1);
  assert.equal(mock.get('新甲').enabled, true);
  assert.equal(mock.get('新甲').last_sent_ms, 11000);
  time(21000);
  assert.doesNotThrow(() => [...timers.values()][0].callback());
  assert.equal(mock.get('新甲').last_sent_ms, 21000);
});
