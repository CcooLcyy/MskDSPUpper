import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ControlGroupRoutesError,
  buildControlDataBusRoutes,
  saveControlGroupWithOptionalRoutes,
} from '../../src/utils/control-auto-routing.ts';

const agcSource = readFileSync(new URL('../../src/pages/AGC/index.tsx', import.meta.url), 'utf8');
const avcSource = readFileSync(new URL('../../src/pages/AVC/index.tsx', import.meta.url), 'utf8');

// 验证控制组输入与输出按字段语义生成相反方向的稳定 DataCenter 路由。
test('control auto routing builds stable input and output routes', () => {
  const routes = buildControlDataBusRoutes({
    moduleName: 'AGC',
    groupName: 'group-1',
    bindings: [
      {
        direction: 'input',
        groupTag: 'pcs_1_p_meas',
        external: {
          module_name: 'ModbusRTU',
          conn_name: 'pcs-1',
          tag: 'active_power',
          conn_id: 101,
        },
      },
      {
        direction: 'output',
        groupTag: 'pcs_1_p_set',
        external: {
          module_name: 'ModbusRTU',
          conn_name: 'pcs-1',
          tag: 'active_power_set',
          conn_id: 101,
        },
      },
    ],
  });

  assert.deepEqual(routes, [
    {
      src: { module_name: 'ModbusRTU', conn_name: 'pcs-1', tag: 'active_power' },
      dst: { module_name: 'AGC', conn_name: 'group-1', tag: 'pcs_1_p_meas' },
    },
    {
      src: { module_name: 'AGC', conn_name: 'group-1', tag: 'pcs_1_p_set' },
      dst: { module_name: 'ModbusRTU', conn_name: 'pcs-1', tag: 'active_power_set' },
    },
  ]);
});

// 验证空端点被忽略，完全相同的稳定路由不会重复下发。
test('control auto routing ignores incomplete bindings and deduplicates routes', () => {
  const repeatedBinding = {
    direction: 'input',
    groupTag: 'voltage_meas',
    external: { module_name: 'ModbusRTU', conn_name: 'meter-1', tag: 'voltage' },
  };
  const routes = buildControlDataBusRoutes({
    moduleName: 'AVC',
    groupName: 'group-1',
    bindings: [
      repeatedBinding,
      repeatedBinding,
      {
        direction: 'input',
        groupTag: '',
        external: { module_name: 'ModbusRTU', conn_name: 'meter-1', tag: 'ignored' },
      },
    ],
  });

  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].dst, {
    module_name: 'AVC',
    conn_name: 'group-1',
    tag: 'voltage_meas',
  });
});

// 验证当前控制组连接不能被当作外部点位生成自引用路由。
test('control auto routing rejects the current group connection as an external endpoint', () => {
  assert.throws(
    () => buildControlDataBusRoutes({
      moduleName: 'AGC',
      groupName: 'group-1',
      bindings: [
        {
          direction: 'input',
          groupTag: 'p_meas',
          external: { module_name: 'AGC', conn_name: 'group-1', tag: 'source' },
        },
      ],
    }),
    /不能将当前控制组连接作为自动路由的外部端点/,
  );
});

// 验证默认关闭自动路由时仅保存控制组。
test('control group save skips routes when auto routing is disabled', async () => {
  const calls = [];
  const result = await saveControlGroupWithOptionalRoutes({
    createRoutes: false,
    routes: [{ src: { module_name: 'A', conn_name: 'a', tag: 'x' }, dst: { module_name: 'B', conn_name: 'b', tag: 'y' } }],
    saveGroup: async () => calls.push('group'),
    saveRoutes: async () => calls.push('routes'),
  });

  assert.deepEqual(calls, ['group']);
  assert.equal(result.routesSubmitted, 0);
});

// 验证开启自动路由时必须先保存控制组，再增量保存路由。
test('control group save submits routes after the group', async () => {
  const calls = [];
  const routes = [{ src: { module_name: 'A', conn_name: 'a', tag: 'x' }, dst: { module_name: 'B', conn_name: 'b', tag: 'y' } }];
  const result = await saveControlGroupWithOptionalRoutes({
    createRoutes: true,
    routes,
    saveGroup: async () => calls.push('group'),
    saveRoutes: async (nextRoutes) => {
      calls.push('routes');
      assert.equal(nextRoutes, routes);
    },
  });

  assert.deepEqual(calls, ['group', 'routes']);
  assert.equal(result.routesSubmitted, 1);
});

// 验证路由保存失败时能明确区分“控制组已保存”的部分成功结果。
test('control group save reports route failure after the group was saved', async () => {
  const routeError = new Error('DataCenter 不可用');

  await assert.rejects(
    saveControlGroupWithOptionalRoutes({
      createRoutes: true,
      routes: [{ src: { module_name: 'A', conn_name: 'a', tag: 'x' }, dst: { module_name: 'B', conn_name: 'b', tag: 'y' } }],
      saveGroup: async () => undefined,
      saveRoutes: async () => {
        throw routeError;
      },
    }),
    (error) => {
      assert.ok(error instanceof ControlGroupRoutesError);
      assert.equal(error.groupSaved, true);
      assert.equal(error.routeError, routeError);
      return true;
    },
  );
});

// 验证 AGC 仅为成员快速选点提供默认关闭的自动路由，p_cmd 继续手动填写。
test('AGC member picker exposes opt-in auto routing while p_cmd stays manual', () => {
  assert.match(agcSource, /const \[createMemberRoutes, setCreateMemberRoutes\] = useState\(false\)/);
  assert.match(agcSource, /保存控制组时自动创建 DataCenter 路由/);
  assert.doesNotMatch(agcSource, /从数据总线点位回填 p_cmd/);
  assert.match(agcSource, /moduleName: connection\.module_name/);
});

// 验证 AGC 成员量测/base_tag 为输入路由，p_set 为输出路由，并在组保存后增量提交。
test('AGC auto routing maps member fields to the correct directions', () => {
  assert.match(agcSource, /direction: 'input',[\s\S]*groupTag: member\.p_meas\.tag/);
  assert.match(agcSource, /direction: 'output',[\s\S]*groupTag: member\.p_set\.signal\.tag/);
  assert.match(agcSource, /direction: 'input',[\s\S]*groupTag: member\.p_set\.base_tag/);
  assert.match(agcSource, /member\.controllable && routeDraft\.endpoints\.p_set/);
  assert.match(
    agcSource,
    /saveGroup: \(\) => api\.agcUpsertGroup\(config, createOnly\)[\s\S]*saveRoutes: \(nextRoutes\) => api\.dcUpsertRoutes\(nextRoutes, false\)/,
  );
  assert.match(agcSource, /控制组已保存，路由创建失败/);
});

// 验证 AVC 组级与成员级自动路由开关均默认关闭，并保留完整外部端点。
test('AVC group and member pickers expose opt-in auto routing', () => {
  assert.match(avcSource, /const \[groupAutoRouteEnabled, setGroupAutoRouteEnabled\] = useState\(false\)/);
  assert.match(avcSource, /const \[memberAutoRouteEnabled, setMemberAutoRouteEnabled\] = useState\(false\)/);
  assert.match(avcSource, /保存时自动创建组级 DataCenter 路由/);
  assert.match(avcSource, /保存控制组时自动创建该成员的 DataCenter 路由/);
  assert.match(avcSource, /moduleName: connection\.module_name/);
});

// 验证 AVC 组级和成员量测为输入，q_set 为输出，并在组保存后增量提交。
test('AVC auto routing maps group and member fields to the correct directions', () => {
  assert.match(avcSource, /addRouteBinding\('input', config\.voltage_meas\?\.tag/);
  assert.match(avcSource, /addRouteBinding\('input', config\.voltage_cmd\.tag/);
  assert.match(avcSource, /addRouteBinding\('input', config\.q_total_cmd\.signal\?\.tag/);
  assert.match(avcSource, /addRouteBinding\('input', member\.q_meas\?\.tag/);
  assert.match(avcSource, /addRouteBinding\('output', member\.q_set\.signal\?\.tag/);
  assert.match(
    avcSource,
    /savedGroup = await api\.avcUpsertGroup\(config, createOnly\)[\s\S]*saveRoutes: \(nextRoutes\) => api\.dcUpsertRoutes\(nextRoutes, false\)/,
  );
  assert.match(avcSource, /AVC 控制组已保存，路由创建失败/);
});
