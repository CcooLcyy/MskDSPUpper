import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../../src/pages/AVC/index.tsx', import.meta.url), 'utf8');

// 验证组弹窗读取映射基线，保存使用字段差异计划，失败计划保留在弹窗外供重试。
test('AVC integrates mapping baseline, staged save and retained retry', () => {
  assert.match(source, /useControlMappings\('AVC'\)/);
  assert.match(source, /usePendingControlRoutes\('AVC'\)/);
  assert.match(source, /mappings\.error \|\| pendingRouteError/);
  assert.match(source, /groupName=\{currentGroupName\}/);
  assert.match(source, /mappings\.open\('', undefined\)/);
  assert.match(source, /mappings\.open\(selectedConfig\.group_name, selectedGroup\?\.conn_id\)/);
  assert.match(source, /mappings\.plan\(buildAvcMappingFields\(config\), routeBindings, config\.group_name\)/);
  assert.match(source, /removedRoutes: plan\.removedRoutes/);
  assert.match(source, /setPendingRouteError\(routeSaveError\)/);
  assert.match(source, /<ControlRouteRetry error=\{pendingRouteError\}/);
  assert.match(source, /<ControlMappingsEditor mapping=\{mappings\} fields=\{mappingFields\}/);
  assert.match(source, /groupSubmitting \|\| mappings\.loading \|\| mappings\.error/);
});

// 验证成员只暂存、关闭草稿需确认、运行中编辑有原因提示。
test('AVC protects group and member drafts and explains stopped editing', () => {
  assert.match(source, /okText="暂存成员"/);
  assert.match(source, /仍需保存控制组/);
  assert.match(source, /closeGroupDraft/);
  assert.match(source, /closeMemberDraft/);
  assert.match(source, /放弃未保存的控制组改动/);
  assert.match(source, /放弃未暂存的成员改动/);
  assert.match(source, /AVC 控制组运行中，请先停止控制组后再编辑/);
});

// 验证监视使用点值时间与质量，并保留查询错误，快速选点失败不伪装为空列表。
test('AVC reports runtime freshness and endpoint loading errors', () => {
  assert.match(source, /<ControlRuntimeStatus/);
  assert.match(source, /offline=\{!!runtimeStatus\.error\}/);
  assert.match(source, /Math\.max\(30000,/);
  assert.doesNotMatch(source, /updatedAt: Date\.now\(\)/);
  assert.match(source, /dataBusEndpointError/);
  assert.match(source, /刷新快速选点/);
  assert.match(source, /connection\.module_name === AVC_MODULE_NAME && connection\.conn_name === currentGroupName/);
});
