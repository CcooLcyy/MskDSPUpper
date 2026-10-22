import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLowerUpdateDeploymentController } from '../../src/utils/lower-update-deployment.ts';
import { readLowerUpdatePendingTask } from '../../src/utils/lower-update-pending.ts';

const image = `sha256:${'a'.repeat(64)}`;
function input() {
  return {
    manifest: {
      schema_version: 1, product: 'mskdsp', channel: 'ci', platform: 'linux-x64', version: '1',
      image_id: image, asset: { name: 'pkg', size: 10, sha256: 'c'.repeat(64) }, source: {}, checksum: {},
    },
    packageResult: { package_name: 'pkg', package_path: 'C:/pkg', downloaded_bytes: 10, sha256: 'c'.repeat(64) },
    connection: {
      upload_account: 'user@remote:22', install_dir: '/home/user',
      auth: { method: 'password', password: 'ssh-secret' }, sudo_password: 'sudo-secret',
      remote_target: { endpoint: 'https://platform', device_id: 'device-a' },
    },
    reuseSshPasswordForSudo: false, rememberPassword: false,
  };
}
function status(request, phase = 'succeeded') {
  return { operation_id: request.operation_id, phase, message: phase, expected_image_id: image, actual_image_id: image, log_tail: '' };
}
function fixture(overrides = {}) {
  const calls = [];
  let saved = null;
  const operations = {
    queryRuntime: async request => {
      calls.push(['runtime', request]);
      return { exists: true, running: true, image_id: 'old' };
    },
    upload: async request => {
      calls.push(['upload', request]);
      return { package_name: 'pkg', remote_path: '/home/user/pkg', uploaded_bytes: 10 };
    },
    install: async () => { throw Error('不得同步安装'); },
    cleanup: async () => { throw Error('不得清理回退材料'); },
    saveConnection: async () => {}, credentialRevision: () => 0, sleep: async () => {},
    reconnectRuntime: async request => { calls.push(['reconnect', request]); return true; },
    savePending: async record => { saved = structuredClone(record); calls.push(['persist', record]); },
    loadPending: () => null,
    submitTask: async request => { calls.push(['submit', request]); return status(request, 'installing'); },
    queryTask: async request => { calls.push(['query', request]); return status(request); },
    ...overrides,
  };
  return { controller: createLowerUpdateDeploymentController(operations), calls, saved: () => saved };
}

// 验证平台更新成功和原任务恢复成功后均恢复固定目标，重连请求不携带凭据。
test('远程更新及恢复查询成功后自动恢复业务连接', async () => {
  const f = fixture();
  await f.controller.start(input());
  const request = f.calls.find(([name]) => name === 'reconnect')[1];
  assert.deepEqual(request, { upload_account: 'user@remote:22', remote_target: input().connection.remote_target });
  const uncertain = fixture({ queryTask: async () => { throw Error('离线'); } });
  await uncertain.controller.start(input());
  assert.equal(uncertain.calls.some(([name]) => name === 'reconnect'), false);
  const recovered = fixture({ loadPending: () => uncertain.saved() });
  await recovered.controller.resumeRemote({ method: 'password', password: 'new-secret' }, 'new-sudo');
  assert.deepEqual(recovered.calls.find(([name]) => name === 'reconnect')[1], request);
});

// 验证远程更新已成功时重连耗尽不重新查询已清除的任务，且可单独重试连接。
test('远程连接恢复失败不丢失已确认成功结果', async () => {
  let attempts = 0;
  let ready = false;
  const f = fixture({ reconnectRuntime: async () => { attempts += 1; if (!ready) throw Error('隧道未恢复'); return true; } });
  await f.controller.start(input());
  assert.equal(attempts, 6);
  assert.equal(f.saved(), null);
  assert.equal(f.controller.getSnapshot().task.stage, 'succeeded');
  assert.match(f.controller.getSnapshot().task.runtimeRefreshError, /隧道未恢复/);
  assert.equal(f.calls.filter(([name]) => name === 'query').length, 1);
  ready = true;
  await f.controller.retry('reconnect');
  assert.equal(f.controller.getSnapshot().task.runtimeRefreshError, null);
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1);
});

// 验证提交回执丢失后只查询原任务，且目标固定、持久记录没有凭据。
test('远程回执丢失后恢复原任务并固定目标', async () => {
  const f = fixture({ submitTask: async request => {
    f.calls.push(['submit', request]);
    throw Error('连接断开 ssh-secret');
  } });
  const data = input();
  const pending = f.controller.start(data);
  data.connection.remote_target.device_id = 'device-b';
  await pending;
  assert.equal(f.controller.getSnapshot().task.stage, 'succeeded');
  const submits = f.calls.filter(call => call[0] === 'submit');
  assert.equal(submits.length, 1);
  assert.equal(submits[0][1].remote_target.device_id, 'device-a');
  assert.equal(f.calls.find(call => call[0] === 'query')[1].operation_id, submits[0][1].operation_id);
  assert.ok(f.calls.findIndex(call => call[0] === 'persist') < f.calls.findIndex(call => call[0] === 'submit'));
  const text = JSON.stringify(f.calls.filter(call => call[0] === 'persist'));
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('auth'));
});

// 验证掉线超时是结果未知，阻止重装，新实例能重新输入认证恢复。
test('未知结果持久恢复不允许重新安装', async () => {
  const f = fixture({ queryTask: async () => { throw Error('离线'); } });
  await f.controller.start(input());
  assert.equal(f.controller.getSnapshot().task.stage, 'remote_unknown');
  const record = f.saved();
  assert.ok(record);
  await assert.rejects(f.controller.start(input()), /原任务/);
  await assert.rejects(f.controller.retry('reinstall'), /原任务|重新安装/);
  const recovered = fixture({ loadPending: () => record });
  assert.equal(recovered.controller.getSnapshot().task.stage, 'remote_unknown');
  await recovered.controller.resumeRemote({ method: 'password', password: 'new-password' }, 'new-sudo');
  assert.equal(recovered.controller.getSnapshot().task.stage, 'succeeded');
  assert.equal(recovered.calls.find(call => call[0] === 'query')[1].operation_id, record.operation_id);
});

// 验证回退终态各自展示且不当成成功，不调用旧清理流程。
test('自动回退成功和失败单独呈现', async () => {
  for (const phase of ['rolled_back', 'rollback_failed', 'failed']) {
    const f = fixture({ queryTask: async request => ({ ...status(request, phase), log_tail: 'sudo-secret' }) });
    await f.controller.start(input());
    assert.equal(f.controller.getSnapshot().task.stage, phase === 'failed' ? 'install_failed' : phase);
    if (phase === 'rollback_failed') {
      assert.ok(f.saved());
      await assert.rejects(f.controller.start(input()), /原任务/);
      const originalId = f.saved().operation_id;
      await f.controller.resumeRemote({ method: 'password', password: 'again-secret' }, 'sudo-secret');
      assert.equal(f.saved().operation_id, originalId);
      const reopened = fixture({ loadPending: () => f.saved() });
      assert.equal(reopened.controller.getSnapshot().task.operationId, originalId);
      await assert.rejects(reopened.controller.start(input()), /原任务/);
    } else assert.equal(f.saved(), null);
    assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes('secret'));
  }
});

// 验证受理窗口尚未交接 systemd 时，同编号同摘要调和，不生成第二个任务。
test('明确任务不存在才幂等重发原编号并等待accepted', async () => {
  let queries = 0;
  const f = fixture({ queryTask: async request => {
    f.calls.push(['query', request]);
    queries += 1;
    if (queries === 1) throw Error('LOWER_UPDATE_TASK_NOT_FOUND：任务不存在');
    return status(request, queries === 2 ? 'accepted' : 'succeeded');
  } });
  await f.controller.start(input());
  assert.equal(f.controller.getSnapshot().task.stage, 'succeeded');
  const submits = f.calls.filter(call => call[0] === 'submit').map(call => call[1]);
  assert.equal(submits.length, 2);
  assert.equal(submits[0].operation_id, submits[1].operation_id);
  assert.equal(submits[0].package_sha256, submits[1].package_sha256);
});

// 验证成功状态必须同时有匹配的实际镜像，错误响应保留待查询身份。
test('成功状态实际镜像不一致时结果待确认', async () => {
  const f = fixture({ queryTask: async request => ({ ...status(request), actual_image_id: `sha256:${'b'.repeat(64)}` }) });
  await f.controller.start(input());
  assert.equal(f.controller.getSnapshot().task.stage, 'remote_unknown');
  assert.ok(f.saved());
});

// 验证本地记录只按白名单重建，非法或包含临时隧道身份的记录不能启动更新。
test('持久恢复记录校验与字段白名单', async () => {
  const f = fixture({ queryTask: async () => { throw Error('离线'); } });
  await f.controller.start(input());
  const valid = f.saved();
  const safe = readLowerUpdatePendingTask({ ...valid, auth: { password: 'secret' }, token: 'secret' });
  assert.ok(safe);
  assert.ok(!JSON.stringify(safe).includes('secret'));
  for (const invalid of [
    false, 0, '',
    { ...valid, operation_id: 'not-a-uuid' },
    { ...valid, package_sha256: 'x' },
    { ...valid, expected_image_id: 'unknown' },
    { ...valid, upload_account: 'user@127.0.0.1:38000' },
    { ...valid, remote_target: { ...valid.remote_target, endpoint: 'https://user:secret@platform' } },
    { ...valid, remote_target: { ...valid.remote_target, device_id: '../other' } },
  ]) {
    assert.equal(readLowerUpdatePendingTask(invalid), null);
    const recovered = fixture({ loadPending: () => invalid });
    assert.equal(recovered.controller.getSnapshot().task, null);
    await assert.rejects(recovered.controller.start(input()), /恢复记录无效/);
  }
});

// 验证提交前持久化失败时停止，不产生不可追踪的宿主机任务。
test('持久化原任务失败时不提交安装', async () => {
  let submissions = 0;
  const f = fixture({
    savePending: async () => { throw Error('磁盘写入失败'); },
    submitTask: async request => { submissions += 1; return status(request); },
  });
  await f.controller.start(input());
  assert.equal(submissions, 0);
  assert.equal(f.controller.getSnapshot().task.stage, 'check_failed');
});

// 验证远程证书认证在预检前拒绝，避免误走现场地址或证书路径。
test('远程模式只允许密码认证', async () => {
  const f = fixture();
  const data = input();
  data.connection.auth = { method: 'certificate' };
  await f.controller.start(data);
  assert.equal(f.controller.getSnapshot().task.stage, 'check_failed');
  assert.equal(f.calls.length, 0);
});

// 验证明确定未受理且被其他宿主机任务阻止时清除新编号，不陷入永久未知。
test('其他宿主机任务明确拒绝新任务时释放未受理编号', async () => {
  for (const rejectAt of ['initial', 'reconcile']) {
    let submissions = 0;
    const f = fixture({
      queryTask: async () => { throw Error('LOWER_UPDATE_TASK_NOT_FOUND: 未找到原任务'); },
      submitTask: async () => {
        submissions += 1;
        if (rejectAt === 'initial' || submissions > 1) throw Error('LOWER_UPDATE_TASK_REJECTED: 原任务 existing-id 尚未处理');
        throw Error('提交回执丢失');
      },
    });
    await f.controller.start(input());
    assert.equal(f.controller.getSnapshot().task.stage, 'install_failed');
    assert.equal(f.controller.getSnapshot().task.status, '更新任务未受理');
    assert.equal(f.saved(), null);
    assert.equal(submissions, rejectAt === 'initial' ? 1 : 2);
  }
});
