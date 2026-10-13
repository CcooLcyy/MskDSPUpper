import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ImportedPointRoutesError,
  buildImportedPointRoutes,
  getImportedPointRouteDirection,
  reverseImportedPointRoutes,
  saveImportedPointsWithRoutes,
} from '../../src/pages/IEC104/import-routing.ts';

const pageSource = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');

// 验证自动路由使用稳定连接主键，并使用用户最终编辑的目标 tag。
test('IEC104 import builds stable source-to-target DataCenter routes', () => {
  const routes = buildImportedPointRoutes(
    [
      {
        source: {
          module_name: 'ModbusRTU',
          conn_name: 'meter-1',
          tag: 'voltage_a',
          conn_id: 101,
        },
        targetTag: 'meter_1_voltage_a',
        businessType: 2,
      },
    ],
    {
      moduleName: 'IEC104',
      connName: 'station-1',
    },
    { stationRole: 'slave' },
  );

  assert.deepEqual(routes, [
    {
      src: {
        module_name: 'ModbusRTU',
        conn_name: 'meter-1',
        tag: 'voltage_a',
      },
      dst: {
        module_name: 'IEC104',
        conn_name: 'station-1',
        tag: 'meter_1_voltage_a',
      },
    },
  ]);
  assert.equal(routes[0].src.conn_id, undefined);
});

// 验证从站遥控/遥调点作为命令源，路由目标为导入时选中的数据总线点。
test('IEC104 slave import reverses remote control and adjust routes', () => {
  const routes = buildImportedPointRoutes(
    [
      {
        source: {
          module_name: 'AGC',
          conn_name: 'group-1',
          tag: 'active_power_setpoint',
          conn_id: 201,
        },
        targetTag: 'station_setpoint',
        businessType: 3,
      },
      {
        source: {
          module_name: 'AVC',
          conn_name: 'group-1',
          tag: 'breaker_command',
          conn_id: 202,
        },
        targetTag: 'station_breaker_command',
        businessType: 4,
      },
    ],
    {
      moduleName: 'IEC104',
      connName: 'station-1',
    },
    { stationRole: 'slave' },
  );

  assert.deepEqual(routes.map((route) => ({ src: route.src, dst: route.dst })), [
    {
      src: { module_name: 'IEC104', conn_name: 'station-1', tag: 'station_setpoint' },
      dst: { module_name: 'AGC', conn_name: 'group-1', tag: 'active_power_setpoint' },
    },
    {
      src: { module_name: 'IEC104', conn_name: 'station-1', tag: 'station_breaker_command' },
      dst: { module_name: 'AVC', conn_name: 'group-1', tag: 'breaker_command' },
    },
  ]);
});

// 验证从站参数和未分类点只导入点表，不自动创建 DataCenter 路由。
test('IEC104 slave import skips parameter and unspecified routes', () => {
  const drafts = [
    {
      source: { module_name: 'AGC', conn_name: 'group-1', tag: 'parameter' },
      targetTag: 'station_parameter',
      businessType: 5,
    },
    {
      source: { module_name: 'AGC', conn_name: 'group-1', tag: 'unknown' },
      targetTag: 'station_unknown',
      businessType: 0,
    },
  ];

  assert.equal(getImportedPointRouteDirection(5, 'slave'), 'skip');
  assert.equal(getImportedPointRouteDirection(0, 'slave'), 'skip');
  assert.deepEqual(buildImportedPointRoutes(drafts, { moduleName: 'IEC104', connName: 'station-1' }, { stationRole: 'slave' }), []);
});

// 验证没有适用路由时仅保存 IEC104 点表，不调用路由清理或保存接口。
test('IEC104 import skips DataCenter writes when no routes apply', async () => {
  const calls = [];
  const result = await saveImportedPointsWithRoutes({
    routes: [],
    savePointTable: async () => calls.push('point-table'),
    deleteRoutes: async () => calls.push('delete-routes'),
    saveRoutes: async () => calls.push('routes'),
  });

  assert.deepEqual(calls, ['point-table']);
  assert.equal(result.routesCreated, 0);
});

// 验证导入无需路由开关，必须先保存点表、再自动增量保存路由。
test('IEC104 import saves the point table before DataCenter routes', async () => {
  const calls = [];
  const routes = [{ src: { module_name: 'A', conn_name: 'a', tag: 'x' }, dst: { module_name: 'B', conn_name: 'b', tag: 'y' } }];
  const result = await saveImportedPointsWithRoutes({
    routes,
    savePointTable: async () => calls.push('point-table'),
    saveRoutes: async (nextRoutes) => {
      calls.push('routes');
      assert.equal(nextRoutes, routes);
    },
  });

  assert.deepEqual(calls, ['point-table', 'routes']);
  assert.equal(result.routesCreated, 1);
});

// 验证创建新方向前会先删除同一端点对的旧反向路由。
test('IEC104 import removes reverse routes before saving the selected direction', async () => {
  const calls = [];
  const routes = [{
    src: { module_name: 'ModbusRTU', conn_name: 'meter-1', tag: 'voltage_a' },
    dst: { module_name: 'IEC104', conn_name: 'station-1', tag: 'meter_voltage_a' },
  }];

  assert.deepEqual(reverseImportedPointRoutes(routes), [{
    src: { module_name: 'IEC104', conn_name: 'station-1', tag: 'meter_voltage_a' },
    dst: { module_name: 'ModbusRTU', conn_name: 'meter-1', tag: 'voltage_a' },
  }]);

  const result = await saveImportedPointsWithRoutes({
    routes,
    savePointTable: async () => calls.push('point-table'),
    deleteRoutes: async (reverseRoutes) => {
      calls.push('delete-reverse-routes');
      assert.deepEqual(reverseRoutes, reverseImportedPointRoutes(routes));
    },
    saveRoutes: async () => calls.push('routes'),
  });

  assert.deepEqual(calls, ['point-table', 'delete-reverse-routes', 'routes']);
  assert.equal(result.routesCreated, 1);
});

// 验证路由失败时能区分“点表已保存”的部分成功结果。
test('IEC104 import reports route failure after the point table was saved', async () => {
  const routeError = new Error('DataCenter 不可用');
  const calls = [];

  await assert.rejects(
    saveImportedPointsWithRoutes({
      routes: [{ src: { module_name: 'A', conn_name: 'a', tag: 'x' }, dst: { module_name: 'B', conn_name: 'b', tag: 'y' } }],
      savePointTable: async () => calls.push('point-table'),
      saveRoutes: async () => {
        calls.push('routes');
        throw routeError;
      },
    }),
    (error) => {
      assert.ok(error instanceof ImportedPointRoutesError);
      assert.equal(error.pointTableSaved, true);
      assert.equal(error.routeError, routeError);
      return true;
    },
  );

  assert.deepEqual(calls, ['point-table', 'routes']);
});

// 验证导入自动创建路由，隐藏开关及规则说明，并保留主站命令提示。
test('IEC104 import page creates routes automatically without an opt-in control', () => {
  assert.doesNotMatch(pageSource, /createImportRoutes|setCreateImportRoutes/);
  assert.doesNotMatch(pageSource, /导入并按业务类型创建 DataCenter 路由|路由使用下方最终确认的 Tag/);
  assert.match(pageSource, /const importRoutesTriggerCommands = isMasterStationConfig\(selectedLink\?\.config\)/);
  assert.match(pageSource, /当前 IEC104 连接为 MASTER/);
  assert.match(pageSource, /config\.station_role === 0 && config\.role === ROLE_CLIENT/);
  assert.match(pageSource, /isSlaveStationConfig/);
  assert.match(pageSource, /routesSkipped = importPointDrafts\.length - importRoutes\.length/);
  assert.doesNotMatch(pageSource, /business_type: item\.business_type \|\| getPointBusinessTypeByCategory\(nextCategory\)/);
  assert.match(pageSource, /business_type: getPointBusinessTypeByCategory\(nextCategory\)/);
});

// 验证页面在同一次停链窗口内先保存点表，再清理反向路由并增量创建 DataCenter 路由。
test('IEC104 import page keeps point-table and route saves in one stopped operation', () => {
  assert.match(
    pageSource,
    /runSelectedLinkStopped\(async \(\) => \{[\s\S]*saveImportedPointsWithRoutes\(\{[\s\S]*savePointTable: \(\) => api\.iec104UpsertPointTable\([\s\S]*deleteRoutes: \(routes\) => api\.dcDeleteRoutes\(routes\)[\s\S]*saveRoutes: \(routes\) => api\.dcUpsertRoutes\(routes, false\)/,
  );
  assert.match(
    pageSource,
    /if \(routeSaveError\) \{[\s\S]*setPoints\(newPoints\)[\s\S]*点表已保存，路由创建失败/,
  );
});
