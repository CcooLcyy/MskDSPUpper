import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPlatformLogoutAllowed,
  isPlatformWorkspaceResetting,
  registerPlatformLogoutGuard,
  reloadPlatformWorkspace,
} from '../../src/auth/platform-workspace-lifecycle.ts';

// 退出确认执行时重新读取任务状态，正在升级时保留会话，任务完成后允许退出。
test('logout guards read live task state and unregister cleanly', () => {
  let running = false;
  const remove = registerPlatformLogoutGuard(() => running ? '下位机更新正在执行，请等待完成后再退出。' : null);
  assert.doesNotThrow(assertPlatformLogoutAllowed);
  running = true;
  assert.throws(assertPlatformLogoutAllowed, /下位机更新正在执行/);
  running = false;
  assert.doesNotThrow(assertPlatformLogoutAllowed);
  remove();
  running = true;
  assert.doesNotThrow(assertPlatformLogoutAllowed);
});

// 重建失败不能抑制后续未保存内容提示，原工作台继续保持锁定并支持重试。
test('failed workspace reload restores unload protection', async () => {
  await assert.rejects(reloadPlatformWorkspace(() => { throw Error('重建失败'); }), /重建失败/);
  assert.equal(isPlatformWorkspaceResetting(), false);
});

// 重建期间不再次询问放弃草稿，也不在旧页面重新开放账号登录。
test('workspace reload keeps the old controller waiting until navigation', async () => {
  let reloads = 0;
  let completed = false;
  void reloadPlatformWorkspace(() => { reloads++; }).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(reloads, 1);
  assert.equal(isPlatformWorkspaceResetting(), true);
  assert.equal(completed, false);
});
