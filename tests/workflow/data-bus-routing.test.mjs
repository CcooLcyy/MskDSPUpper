import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../../src/utils/config-export.ts', import.meta.url), 'utf8');

test('DataBus export resolves routes from stable endpoint fields before conn_id', () => {
  assert.match(
    source,
    /if \(endpoint\.module_name && endpoint\.conn_name\) \{[\s\S]*module_name: endpoint\.module_name,[\s\S]*conn_name: endpoint\.conn_name,[\s\S]*tag: endpoint\.tag,/,
  );
  assert.match(source, /stripRuntimeConnId\(resolveStableDataBusEndpoint\(route\.src, connectionMap\)\)/);
  assert.match(source, /stripRuntimeConnId\(resolveStableDataBusEndpoint\(route\.dst, connectionMap\)\)/);
});

test('DataBus import upserts stable route fields with optional runtime conn_id', () => {
  assert.match(
    source,
    /src:\s*\{[\s\S]*module_name: route\.src\.module_name,[\s\S]*conn_name: route\.src\.conn_name,[\s\S]*tag: route\.src\.tag,[\s\S]*conn_id: srcConnection\.conn_id,/,
  );
  assert.match(
    source,
    /dst:\s*\{[\s\S]*module_name: route\.dst\.module_name,[\s\S]*conn_name: route\.dst\.conn_name,[\s\S]*tag: route\.dst\.tag,[\s\S]*conn_id: dstConnection\.conn_id,/,
  );
});

test('Legacy conn_id routes are migrated through the DataCenter connection registry', () => {
  assert.match(source, /async function migrateLegacyDataBusRoutes/);
  assert.match(source, /api\.dcListConnections\(\)/);
  assert.match(source, /connectionsById\.get\(connId\)/);
  assert.match(source, /当前连接注册表不存在该连接，无法迁移为稳定路由/);
  assert.match(source, /await migrateLegacyDataBusRoutes\(scopedSnapshot, runningModules\)/);
});

// 验证数据总线页面隐藏控制编排自动维护的内部路由且不会批量删除它们。
test('DataBus hides ControlOrchestrator managed routes from manual configuration', () => {
  const page = readFileSync(new URL('../../src/pages/DataBus/index.tsx', import.meta.url), 'utf8');

  assert.match(page, /isControlOrchestratorRoute/);
  assert.match(page, /routes\.filter\(\(route\) => !isControlOrchestratorRoute\(route\)\)/);
  assert.match(page, /deleteRouteBatch\(visibleRoutes/);
  assert.match(page, /控制编排自动维护的内部路由不在本页显示/);
});
