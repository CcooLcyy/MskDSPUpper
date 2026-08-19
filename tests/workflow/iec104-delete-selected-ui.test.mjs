import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pageSource = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');

// 验证 IEC104 批量删除只移除勾选点位，并通过现有点表覆盖保存入口提交。
test('IEC104 支持删除选中点位并保留未选中点位', () => {
  assert.match(pageSource, /const handleDeleteSelectedPoints = useCallback/);
  assert.match(pageSource, /const selectedTags = new Set\(selectedPointTags\)/);
  assert.match(pageSource, /const selectedPoints = points\.filter\(\(point\) => selectedTags\.has\(point\.tag\)\)/);
  assert.match(pageSource, /const newPoints = points\.filter\(\(point\) => !selectedTags\.has\(point\.tag\)\)/);
  assert.match(pageSource, /runSelectedLinkStopped\(\(\) => api\.iec104UpsertPointTable\(selectedConn, newPoints, true\)\)/);
  assert.match(pageSource, /setSelectedPointTags\(\[\]\)/);
});

// 验证删除点位入口合并为下拉菜单，并保留全部删除/选中删除两种选项。
test('IEC104 删除点位下拉菜单提供两种删除范围', () => {
  assert.match(pageSource, /const pointDeleteMenuItems: MenuProps\['items'\] = \[/);
  assert.match(pageSource, /key: 'all',[\s\S]*label: '删除全部点位'/);
  assert.match(pageSource, /key: 'selected',[\s\S]*label: `删除选中点位/);
  assert.match(pageSource, /menu=\{\{ items: pointDeleteMenuItems, onClick: handlePointDeleteMenuClick \}\}/);
  assert.match(pageSource, /<Button danger size="small" icon=\{<DeleteOutlined \/>\} disabled=\{pointDeleteDisabled\}>[\s\S]*删除点位/);
});

// 验证下拉菜单选择后统一通过受控确认框执行对应删除操作。
test('IEC104 删除点位下拉菜单沿用二次确认', () => {
  assert.match(pageSource, /const \[pointDeleteConfirmMode, setPointDeleteConfirmMode\] = useState<PointDeleteMode \| null>\(null\)/);
  assert.match(pageSource, /if \(key === 'all' \|\| key === 'selected'\) \{[\s\S]*setPointDeleteConfirmMode\(key\)/);
  assert.match(pageSource, /title=\{pointDeleteConfirmMode === 'all' \? '确认删除全部点位？' : '确认删除选中点位？'\}/);
  assert.match(pageSource, /open=\{pointDeleteConfirmMode !== null\}/);
  assert.match(pageSource, /const handlePointDeleteConfirm = useCallback\([\s\S]*handleDeleteAllPoints\(\)[\s\S]*handleDeleteSelectedPoints\(\)/);
});
