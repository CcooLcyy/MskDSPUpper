import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModuleOpsRequestScope } from '../../src/utils/module-ops-request.ts';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// 验证旧请求成功晚于新请求时不能作为有效结果返回。
test('new request abandons old success without clearing new request', async () => {
  const scope = createModuleOpsRequestScope();
  const old = deferred();
  const pending = scope.run(() => old.promise);
  const next = scope.run(async () => '新列表');
  old.resolve('旧列表');
  assert.deepEqual(await pending, { current: false });
  assert.deepEqual(await next, { current: true, value: '新列表' });
});

// 验证地址、模式切换或离开页面可以立刻结束等待，且旧失败不冒泡。
test('cancel releases a hanging request and ignores its later rejection', async () => {
  const scope = createModuleOpsRequestScope();
  const old = deferred();
  const pending = scope.run(() => old.promise);
  scope.cancel();
  assert.deepEqual(await pending, { current: false });
  old.reject(new Error('旧失败'));
  await Promise.resolve();
  assert.deepEqual(await scope.run(async () => '恢复'), { current: true, value: '恢复' });
});

// 验证整次操作只有一个超时预算，超时后旧结果失效且可以重试。
test('direct operation times out and can recover', async () => {
  const scope = createModuleOpsRequestScope();
  const old = deferred();
  await assert.rejects(scope.run(() => old.promise, 10), /无法连接.*超时/);
  old.resolve('迟到列表');
  assert.deepEqual(await scope.run(async () => '重试成功'), { current: true, value: '重试成功' });
});

// 验证取消信号阻止旧连接继续调用后续读取步骤。
test('cancel prevents the next stage of an old operation', async () => {
  const scope = createModuleOpsRequestScope();
  const old = deferred();
  let reads = 0;
  const pending = scope.run(async signal => {
    await old.promise;
    signal.throwIfAborted();
    reads += 1;
  });
  scope.cancel();
  old.resolve();
  await pending;
  await Promise.resolve();
  assert.equal(reads, 0);
});

// 验证现场超时预算不会自动应用到平台远程请求。
test('remote operation retains its own timeout policy', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const scope = createModuleOpsRequestScope();
  const remote = deferred();
  const pending = scope.run(() => remote.promise);
  context.mock.timers.tick(6000);
  remote.resolve('远程列表');
  assert.deepEqual(await pending, { current: true, value: '远程列表' });
});
