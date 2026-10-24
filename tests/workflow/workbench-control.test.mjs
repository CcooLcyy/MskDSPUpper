import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyDataBusQueryView,
  dataBusViewForWorkbench,
  selectControlMemberColumns,
  startControlDisplayClock,
  workbenchViewForDataBusQuery,
} from '../../src/components/control/workbench-control.ts';
import { summarizeControlRuntime } from '../../src/utils/control-runtime-values.ts';

// 验证不同控制模块的运行视图均聚焦成员反馈，工程列和输入数组保持不变。
test('控制成员视图保留列对象及配置，按工程和运行任务选择信息', () => {
  for (const prefix of ['p', 'q']) {
    const columns = [
      { key: 'member_name' }, { key: 'weight' }, { key: `${prefix}_meas` },
      { key: `${prefix}_meas_value` }, { key: `${prefix}_set` }, { key: `${prefix}_set_value` },
      { key: 'controllable' }, { key: 'runtime_quality' },
    ];
    const before = [...columns];
    const runtime = selectControlMemberColumns(columns, 'runtime');
    assert.deepEqual(runtime.map(({ key }) => key), ['member_name', `${prefix}_meas_value`, `${prefix}_set_value`, 'controllable', 'runtime_quality']);
    assert.deepEqual(selectControlMemberColumns(columns, 'engineering').map(({ key }) => key), ['member_name', 'weight', `${prefix}_meas`, `${prefix}_set`, 'controllable']);
    assert.deepEqual(columns, before);
    assert.equal(runtime[0], columns[0]);
  }
});

// 验证数据总线跟随全局工作视图，普通进入页面不会隐式切回工程配置。
test('数据总线工作视图与明确导航参数分别解析', () => {
  assert.equal(dataBusViewForWorkbench('engineering'), 'config');
  assert.equal(dataBusViewForWorkbench('runtime'), 'monitor');
  assert.equal(workbenchViewForDataBusQuery('config'), 'engineering');
  assert.equal(workbenchViewForDataBusQuery('monitor'), 'runtime');
  for (const query of [null, '', 'unknown']) assert.equal(workbenchViewForDataBusQuery(query), null);
});

// 验证旧地址不会因在线能力恢复而重写全局偏好，实际导航变化仍然生效。
test('数据总线在离线往返后不重放旧查询参数', () => {
  const handled = { current: undefined };
  let preference = 'runtime';
  const onlineSetter = (view) => { preference = view; };
  applyDataBusQueryView('config', handled, onlineSetter);
  assert.equal(preference, 'engineering');
  preference = 'runtime';
  applyDataBusQueryView('config', handled, () => {});
  applyDataBusQueryView('config', handled, (view) => { preference = view; });
  assert.equal(preference, 'runtime');
  applyDataBusQueryView('monitor', handled, onlineSetter);
  applyDataBusQueryView('config', handled, onlineSetter);
  assert.equal(preference, 'engineering');
  applyDataBusQueryView(null, handled, onlineSetter);
  preference = 'runtime';
  applyDataBusQueryView('config', handled, onlineSetter);
  assert.equal(preference, 'engineering');
});

// 验证读取请求始终未返回时，成员最后一次有效点值仍会从正常变陈旧，退出后不再计时。
test('控制成员展示时钟独立于请求完成并在清理后停止', (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const updates = { measured: { ts_ms: 100000, quality: 1, value: { type: 'Double', value: 7 } } };
  const states = [];
  const stop = startControlDisplayClock((now) => {
    states.push(summarizeControlRuntime(updates, ['measured'], now, 30000).state);
  });
  context.mock.timers.tick(0);
  assert.equal(states.at(-1), 'ok');
  context.mock.timers.tick(30000);
  assert.equal(states.at(-1), 'ok');
  context.mock.timers.tick(1000);
  assert.equal(states.at(-1), 'stale');
  assert.equal(updates.measured.ts_ms, 100000);
  stop();
  const count = states.length;
  context.mock.timers.tick(5000);
  assert.equal(states.length, count);
});

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

// 验证切换仅作用于同一页面内部展示，不按视图重新挂载控制模块或替换编辑表单。
test('控制页面保留模块实例、表单草稿与既有数据质量提示', () => {
  const host = read('src/pages/Control/index.tsx');
  assert.doesNotMatch(host, /key=\{[^}]*[Vv]iew/);
  for (const module of ['AGC', 'AVC']) {
    const source = read(`src/pages/${module}/index.tsx`);
    assert.match(source, /useWorkbench\(\)/);
    assert.match(source, /control-workbench-page--\$\{workbenchView\}/);
    assert.match(source, /columns=\{visibleMemberColumns\}/);
    assert.match(source, /<ControlRuntimeStatus/);
    assert.match(source, /startControlDisplayClock\(setRuntimeDisplayNow\)/);
    assert.match(source, /summarizeControlRuntime\(runtimeUpdates, tags, runtimeDisplayNow/);
    assert.match(source, /title="控制日志暂未接入"/);
    assert.match(source, /确认后返回成员列表，保存控制组时下发成员与路由/);
    assert.doesNotMatch(source, /key=\{workbenchView\}|setMembersDraft\([^\n]*workbenchView/);
  }
});
