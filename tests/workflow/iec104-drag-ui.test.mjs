import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const iec104Source = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');
const pointerReorderSource = readFileSync(new URL('../../src/components/interaction/use-pointer-reorder.ts', import.meta.url), 'utf8');

// 验证 IEC104 拖拽会写入标准载荷，允许不同 WebView 建立拖放会话。
test('IEC104 点位排序拖拽写入移动载荷', () => {
  assert.match(iec104Source, /const setPointDraftDragData = \(event: React\.DragEvent<HTMLElement>, key: string\): void => \{[\s\S]*event\.dataTransfer\.effectAllowed = 'move';[\s\S]*event\.dataTransfer\.setData\('text\/plain', `\$\{POINT_DRAFT_DRAG_PREFIX\}\$\{key\}`\);/);
  assert.equal((iec104Source.match(/setPointDraftDragData\(event, draft\.key\);/g) ?? []).length, 2);
});

// 验证两个 IEC104 点位排序列表均允许投放并在结束时清理拖拽状态。
test('IEC104 点位排序拖放读取载荷并清理状态', () => {
  assert.equal((iec104Source.match(/event\.dataTransfer\.dropEffect = 'move';/g) ?? []).length, 2);
  assert.equal((iec104Source.match(/const sourceKey = getPointDraftDragKey\(event,/g) ?? []).length, 2);
  assert.match(iec104Source, /if \(sourceKey\) reorderIoaAdjustDrafts\(sourceKey, draft\.key\);[\s\S]*onDragEnd=\{\(\) => setIoaAdjustDragKey\(null\)\}/);
  assert.match(iec104Source, /if \(sourceKey\) reorderImportDrafts\(sourceKey, draft\.key\);[\s\S]*onDragEnd=\{\(\) => setImportDragKey\(null\)\}/);
});

// 验证 IEC104 同时提供不依赖 HTML5 drag/drop 的指针排序路径。
test('IEC104 点位排序支持指针拖动', () => {
  assert.match(pointerReorderSource, /window\.addEventListener\('pointerup', handlePointerEnd\);[\s\S]*window\.addEventListener\('pointercancel', handlePointerEnd\)/);
  assert.match(pointerReorderSource, /event\.preventDefault\(\);[\s\S]*dragRef\.current = \{ key, pointerId: event\.pointerId \};/);
  assert.equal((iec104Source.match(/usePointerReorder\(\{/g) ?? []).length, 2);
  assert.equal((iec104Source.match(/onPointerDown=\{\(event\) => (?:ioaAdjustPointerReorder|importPointerReorder)\.onPointerDown\(event, draft\.key\)\}/g) ?? []).length, 2);
  assert.equal((iec104Source.match(/onPointerEnter=\{\(event\) => (?:ioaAdjustPointerReorder|importPointerReorder)\.onPointerEnter\(event, draft\.key\)\}/g) ?? []).length, 2);
});
