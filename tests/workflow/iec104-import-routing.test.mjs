import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ImportedPointRoutesError,
  buildImportedPointRoutes,
  saveImportedPointsWithOptionalRoutes,
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
      },
    ],
    {
      moduleName: 'IEC104',
      connName: 'station-1',
    },
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

// 验证未勾选自动路由时仅保存 IEC104 点表。
test('IEC104 import skips DataCenter routes when the option is disabled', async () => {
  const calls = [];
  const result = await saveImportedPointsWithOptionalRoutes({
    createRoutes: false,
    routes: [{ src: { module_name: 'A', conn_name: 'a', tag: 'x' }, dst: { module_name: 'B', conn_name: 'b', tag: 'y' } }],
    savePointTable: async () => calls.push('point-table'),
    saveRoutes: async () => calls.push('routes'),
  });

  assert.deepEqual(calls, ['point-table']);
  assert.equal(result.routesCreated, 0);
});

// 验证勾选自动路由时必须先保存点表、再增量保存路由。
test('IEC104 import saves the point table before DataCenter routes', async () => {
  const calls = [];
  const routes = [{ src: { module_name: 'A', conn_name: 'a', tag: 'x' }, dst: { module_name: 'B', conn_name: 'b', tag: 'y' } }];
  const result = await saveImportedPointsWithOptionalRoutes({
    createRoutes: true,
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

// 验证路由失败时能区分“点表已保存”的部分成功结果。
test('IEC104 import reports route failure after the point table was saved', async () => {
  const routeError = new Error('DataCenter 不可用');
  const calls = [];

  await assert.rejects(
    saveImportedPointsWithOptionalRoutes({
      createRoutes: true,
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

// 验证导入页面的自动路由默认关闭，并对 IEC104 MASTER 命令语义给出提示。
test('IEC104 import page exposes an opt-in route checkbox and MASTER warning', () => {
  assert.match(pageSource, /const \[createImportRoutes, setCreateImportRoutes\] = useState\(false\)/);
  assert.match(pageSource, /const openImportPointModal = useCallback\(\(\) => \{[\s\S]*setCreateImportRoutes\(false\)/);
  assert.match(pageSource, /checked=\{createImportRoutes\}/);
  assert.match(pageSource, /同时创建 DataCenter 路由（来源点位 → 当前 IEC104 点位）/);
  assert.match(pageSource, /当前 IEC104 连接为 MASTER/);
  assert.match(pageSource, /config\.station_role === 0 && config\.role === ROLE_CLIENT/);
});

// 验证页面在同一次停链窗口内先保存点表，再增量创建 DataCenter 路由。
test('IEC104 import page keeps point-table and route saves in one stopped operation', () => {
  assert.match(
    pageSource,
    /runSelectedLinkStopped\(async \(\) => \{[\s\S]*saveImportedPointsWithOptionalRoutes\(\{[\s\S]*savePointTable: \(\) => api\.iec104UpsertPointTable\([\s\S]*saveRoutes: \(routes\) => api\.dcUpsertRoutes\(routes, false\)/,
  );
  assert.match(
    pageSource,
    /if \(routeSaveError\) \{[\s\S]*setPoints\(newPoints\)[\s\S]*点表已保存，路由创建失败/,
  );
});
