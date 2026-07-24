import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const dataBusSource = readFileSync(new URL('../../src/pages/DataBus/index.tsx', import.meta.url), 'utf8');

// 验证数据中心路由配对拖拽写入标准载荷，避免依赖 React 状态刷新时机。
test('DataBus 路由排序拖拽写入并解析移动载荷', () => {
  assert.match(dataBusSource, /event\.dataTransfer\.effectAllowed = 'move';[\s\S]*event\.dataTransfer\.setData\('text\/plain', serializeRouteTagDrag\(drag\)\);/);
  assert.match(dataBusSource, /parseRouteTagDrag\(event\.dataTransfer\.getData\('text\/plain'\)\) \?\? routeDrag/);
});

// 验证数据中心路由配对仅同侧重排，且取消拖动会清理状态。
test('DataBus 路由排序拖放允许投放并清理状态', () => {
  assert.match(dataBusSource, /event\.preventDefault\(\);[\s\S]*event\.dataTransfer\.dropEffect = 'move';/);
  assert.match(dataBusSource, /if \(drag\?\.side === side\) reorderRouteTags\(side, drag\.index, index\);[\s\S]*setRouteDrag\(null\);/);
  assert.equal((dataBusSource.match(/onDragEnd=\{\(\) => setRouteDrag\(null\)\}/g) ?? []).length, 2);
});
