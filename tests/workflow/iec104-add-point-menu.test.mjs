import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pageSource = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');

// 验证点表工具栏把三种添加入口收敛到“添加点位”下拉菜单。
test('IEC104 添加点位下拉菜单提供单个、批量和数据总线入口', () => {
  assert.match(pageSource, /const pointAddMenuItems: MenuProps\['items'\] = \[/);
  assert.match(pageSource, /key: 'single',[\s\S]*label: '添加点位'/);
  assert.match(pageSource, /key: 'batch',[\s\S]*label: '批量添加点位'/);
  assert.match(pageSource, /key: 'import',[\s\S]*label: '从数据总线导入'/);
  assert.match(pageSource, /menu=\{\{ items: pointAddMenuItems, onClick: handlePointAddMenuClick \}\}/);
  assert.match(pageSource, /const pointAddDisabled = !selectedConn \|\| actionsDisabled;/);
  assert.match(pageSource, /<Button type="primary" size="small" icon=\{<PlusOutlined \/>\} disabled=\{pointAddDisabled\}>[\s\S]*添加点位/);
});

// 验证菜单点击会按入口打开对应弹窗，并保留批量入口仅在配置视图可用的限制。
test('IEC104 添加点位下拉菜单分派到三个入口处理器', () => {
  const handlerStart = pageSource.indexOf('const handlePointAddMenuClick');
  const handlerEnd = pageSource.indexOf('\n  const ', handlerStart + 1);
  assert.ok(handlerStart >= 0, '缺少添加点位菜单点击处理器');
  assert.ok(handlerEnd > handlerStart, '添加点位菜单点击处理器位置异常');

  const handlerSource = pageSource.slice(handlerStart, handlerEnd);
  assert.match(handlerSource, /key === 'single'[\s\S]*openCreatePoint\(\)/);
  assert.match(handlerSource, /key === 'batch'[\s\S]*openBatchPointModal\(\)/);
  assert.match(handlerSource, /key === 'import'[\s\S]*openImportPointModal\(\)/);
  assert.match(pageSource, /key: 'batch',[\s\S]*disabled: pointAddDisabled \|\| pointTableView !== 'config'/);
});
