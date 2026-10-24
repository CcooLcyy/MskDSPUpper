import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkbenchViewStore, resolveWorkbenchView } from '../../src/workbench/workbench-view.ts';
import { readSplitSize } from '../../src/components/layout/split-size.ts';

const storage = initial => {
  let value = initial;
  return { getItem: () => value, setItem: (_key, next) => { value = next; } };
};

// 损坏或不存在的偏好应回到工程配置，避免首次进入空白视图。
test('工作视图恢复有效偏好并容忍未知值', () => {
  assert.equal(createWorkbenchViewStore(storage('runtime')).getSnapshot(), 'runtime');
  assert.equal(createWorkbenchViewStore(storage('unknown')).getSnapshot(), 'engineering');
  assert.equal(createWorkbenchViewStore(storage(null)).getSnapshot(), 'engineering');
});

// 离线降级只作用于实际展示，不覆盖在线使用时的运行偏好。
test('离线展示工程配置，在线恢复原运行偏好', () => {
  const store = createWorkbenchViewStore(storage('runtime'));
  assert.equal(resolveWorkbenchView(store.getSnapshot(), false), 'engineering');
  assert.equal(store.getSnapshot(), 'runtime');
  assert.equal(resolveWorkbenchView(store.getSnapshot(), true), 'runtime');
});

// 一次切换只通知一次，取消订阅后不会更新已离开的工作台。
test('工作视图切换通知与持久化保持一致', () => {
  const saved = storage(null);
  const store = createWorkbenchViewStore(saved);
  let changes = 0;
  const unsubscribe = store.subscribe(() => changes++);
  store.setView('runtime');
  store.setView('runtime');
  assert.equal(changes, 1);
  assert.equal(createWorkbenchViewStore(saved).getSnapshot(), 'runtime');
  unsubscribe();
  store.setView('engineering');
  assert.equal(changes, 1);
});

// 存储被禁用时仍可切换界面，不能将本机偏好失败升级为配置失败。
test('存储不可用时工作视图仍可在内存中切换', () => {
  const store = createWorkbenchViewStore({ getItem() { throw Error('不可读'); }, setItem() { throw Error('不可写'); } });
  assert.equal(store.getSnapshot(), 'engineering');
  store.setView('runtime');
  assert.equal(store.getSnapshot(), 'runtime');
});

// 首次进入新布局使用默认值，历史拖动值继续生效且受边界限制。
test('分栏布局正确恢复缺失、损坏与越界的本机偏好', () => {
  for (const raw of [null, '', 'unknown']) assert.equal(readSplitSize(storage(raw), 'layout', 240, 160, 620), 240);
  assert.equal(readSplitSize(storage('380'), 'layout', 240, 160, 620), 380);
  assert.equal(readSplitSize(storage('900'), 'layout', 240, 160, 620), 620);
  assert.equal(readSplitSize(storage('0'), 'layout', 240, 160, 620), 160);
  assert.equal(readSplitSize(undefined, 'layout', 240, 160, 620), 240);
  assert.equal(readSplitSize({ getItem() { throw Error('不可读'); } }, 'layout', 240, 160, 620), 240);
});
