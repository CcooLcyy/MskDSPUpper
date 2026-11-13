import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../../src/pages/AVC/index.tsx', import.meta.url), 'utf8');

// 验证组弹窗读取映射基线，保存使用字段差异计划，失败计划保留在弹窗外供重试。
test('AVC integrates mapping baseline, staged save and retained retry', () => {
  assert.match(source, /useControlMappings\('AVC', memberModalOpen\)/);
  assert.match(source, /usePendingControlRoutes\('AVC'\)/);
  assert.match(source, /mappings\.error \|\| pendingRouteError/);
  assert.match(source, /groupName=\{currentGroupName\}/);
  assert.match(source, /mappings\.open\('', undefined\)/);
  assert.match(source, /mappings\.open\(selectedConfig\.group_name, selectedGroup\?\.conn_id\)/);
  assert.match(source, /mappings\.plan\(planFields, \[\], config\.group_name, clearedFields\)/);
  assert.match(source, /removedRoutes: plan\.removedRoutes/);
  assert.match(source, /setPendingRouteError\(routeSaveError\)/);
  assert.match(source, /<ControlRouteRetry error=\{pendingRouteError\}/);
  assert.match(source, /<ControlMappingsEditor mapping=\{mappings\} fields=\{mappingFields\}/);
  assert.match(source, /groupSubmitting \|\| mappings\.loading \|\| mappings\.error/);
});

// 跨页保存仍校验基础字段，恢复草稿时回到原页签。
test('AVC keeps all three editor tabs mounted and restores the draft tab', () => {
  assert.match(source, /key: 'basic', label: '基础与总控', forceRender: true/);
  assert.match(source, /key: 'members', label: `成员设备[^,]*, forceRender: true/);
  assert.match(source, /key: 'report', label: '数据上送', forceRender: true/);
  assert.match(source, /editorTab: groupEditorTab/);
  assert.match(source, /setGroupEditorTab\(draft\.member \? 'members' : draft\.editorTab \?\? 'basic'\)/);
  assert.match(source, /groupForm\.validateFields\(\)\.catch[\s\S]*?setGroupEditorTab\('basic'\)[\s\S]*?groupForm\.scrollToField/);
});

// AVC 固定无功输出与成员路由共用控制组保存计划。
test('AVC reports the three default reactive power points through output mappings', () => {
  assert.match(source, /const AVC_REPORT_FIELDS = \['总无功实测', '总无功目标', '总无功偏差'\][\s\S]*?direction: 'output'/);
  assert.match(source, /key: 'report'[\s\S]*?fields=\{AVC_REPORT_FIELDS\}/);
  assert.match(source, /const planFields = \[\s*\.\.\.buildAvcMappingFields\(config\),\s*\.\.\.AVC_REPORT_FIELDS,/);
});

// 验证成员只暂存、关闭草稿需确认、运行中编辑有原因提示。
test('AVC protects group and member drafts and explains stopped editing', () => {
  assert.match(source, /okText="确认成员"/);
  assert.match(source, /保存控制组时下发成员与路由/);
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
  assert.match(source, /<AvcMemberEditor/);
  assert.match(source, /error=\{mappings\.error\}/);
  assert.match(source, /endpoint\.module_name !== AVC_MODULE_NAME \|\| option\.endpoint\.conn_name !== currentGroupName/);
});
