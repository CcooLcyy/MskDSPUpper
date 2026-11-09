import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfigDraftStore } from '../../src/drafts/config-drafts.ts';
import { changeConfigDraftTarget, getConfigDraftTarget } from '../../src/drafts/config-draft-target.ts';

test('草稿按设备、工作区、页面及配置对象隔离', () => {
  const store = createConfigDraftStore();
  const page = '/protocol/modbus-rtu';
  const value = { mode: 2, blocks: [] };
  store.write('设备 A', page, '连接 1', value);

  assert.deepEqual(store.read('设备 A', page, '连接 1'), value);
  assert.equal(store.read('设备 A', page, '连接 2'), undefined);
  assert.equal(store.read('设备 B', page, '连接 1'), undefined);
  assert.equal(store.read('离线工作区', page, '连接 1'), undefined);
  assert.equal(store.read('设备 A', '/calc', '连接 1'), undefined);
  assert.equal(createConfigDraftStore().has('设备 A', page), false);
});

test('页标记保留到最后一份草稿清除', () => {
  const store = createConfigDraftStore();
  const scope = '设备 A';
  const page = '/protocol/iec61850';
  const states = [];
  const unsubscribe = store.subscribe(() => states.push(store.has(scope, page)));
  store.write(scope, page, '通信配置', { conn: 'IED 1' });
  store.write(scope, page, '点映射', { conn: 'IED 1' });
  store.clear(scope, page, '通信配置');
  assert.equal(store.has(scope, page), true);
  store.clear(scope, page, '点映射');
  unsubscribe();

  assert.deepEqual(states, [true, false]);
  assert.equal(store.read(scope, page, '通信配置'), undefined);
  assert.equal(store.read(scope, page, '点映射'), undefined);
});

test('并发切换设备时等待最后一个请求结束再核对草稿目标', async () => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const initial = getConfigDraftTarget();
  const firstChange = changeConfigDraftTarget(() => first.promise);
  const secondChange = changeConfigDraftTarget(() => second.promise);

  assert.equal(getConfigDraftTarget().pending, 2);
  first.resolve();
  await firstChange;
  assert.equal(getConfigDraftTarget().pending, 1);

  second.reject(new Error('切换失败'));
  await assert.rejects(secondChange, /切换失败/);
  assert.equal(getConfigDraftTarget().pending, 0);
  assert.equal(getConfigDraftTarget().revision, initial.revision + 4);
});
