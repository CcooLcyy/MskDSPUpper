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
    queryArchitecture: async request => { calls.push(['architecture', request]); return { os: 'Linux', architecture: 'x86_64', platform: 'linux-x64' }; },
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
    preflightTask: async request => { calls.push(['preflight', request]); },
    archivePending: async record => { calls.push(['archive', structuredClone(record)]); },
    closeTask: async request => { calls.push(['close', request]); },
    savePending: async record => { saved = structuredClone(record); calls.push(['persist', record]); },
    loadPending: () => null,
    submitTask: async request => { calls.push(['submit', request]); return status(request, 'installing'); },
    queryTask: async request => { calls.push(['query', request]); return status(request); },
    ...overrides,
  };
  return { controller: createLowerUpdateDeploymentController(operations), calls, saved: () => saved };
}

for (const mode of ['resumeRemote', 'closeMissingRemote']) {
  test(`${mode} 更换认证时作废先前架构检测，不以新密码复用旧结果`, async () => {
    const f = fixture({ queryTask: async () => {
      throw Error(mode === 'resumeRemote' ? '设备离线' : 'LOWER_UPDATE_TASK_NOT_FOUND: 原任务不存在');
    } });
    await f.controller.start(input());
    const changed = input();
    changed.connection.auth.password = 'recovered-secret';
    changed.connection.sudo_password = 'recovered-sudo';
    assert.equal(f.controller.matchesArchitectureContext(input()), true);
    assert.equal(f.controller.matchesArchitectureContext(changed), false);
    await f.controller[mode](changed.connection.auth, changed.connection.sudo_password);
    assert.equal(f.controller.matchesArchitectureContext(changed), false, mode);
    assert.equal(f.controller.getSnapshot().task.devicePlatform, undefined, mode);
    assert.equal(f.controller.getSnapshot().task.deviceArchitecture, undefined, mode);
    assert.equal(f.calls.filter(([name]) => name === 'architecture').length, 1);
  });
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

// 任务不存在仅显示待核验状态，查询不得重新提交旧版本。
test('明确任务不存在保留原记录且不重新提交', async () => {
  const f = fixture({ queryTask: async () => { throw Error('LOWER_UPDATE_TASK_NOT_FOUND: 任务不存在'); } });
  await f.controller.start(input());
  assert.equal(f.controller.getSnapshot().task.stage, 'task_missing');
  assert.equal(f.calls.filter(call => call[0] === 'submit').length, 1);
  assert.ok(f.saved());
  const recovered = fixture({ loadPending: () => f.saved(), queryTask: async () => { throw Error('LOWER_UPDATE_TASK_NOT_FOUND: 任务不存在'); } });
  await recovered.controller.resumeRemote({ method: 'password', password: 'new-secret' }, 'new-sudo');
  assert.equal(recovered.controller.getSnapshot().task.stage, 'task_missing');
  assert.equal(recovered.calls.some(([name]) => ['submit', 'upload', 'preflight'].includes(name)), false);
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
test('只消费首次提交的明确未受理，查询拒绝保留原记录', async () => {
  for (const rejectAt of ['initial', 'query']) {
    let submissions = 0;
    const f = fixture({
      queryTask: async () => { throw Error('LOWER_UPDATE_TASK_REJECTED: 助手目录组可写'); },
      submitTask: async () => {
        submissions += 1;
        if (rejectAt === 'initial') throw Error('LOWER_UPDATE_TASK_REJECTED: 助手目录组可写');
        throw Error('提交回执丢失');
      },
    });
    await f.controller.start(input());
    assert.equal(f.controller.getSnapshot().task.stage, rejectAt === 'initial' ? 'install_failed' : 'remote_unknown');
    if (rejectAt === 'initial') {
      assert.equal(f.controller.getSnapshot().task.status, '更新任务未受理');
      assert.equal(f.saved(), null);
      assert.match(f.controller.getSnapshot().task.verificationMessage, /助手目录组可写/);
    } else {
      assert.ok(f.saved());
      await assert.rejects(f.controller.start(input()), /原任务/);
    }
    assert.equal(submissions, 1);
  }
});

test('远程环境预检在上传前执行，拒绝及缺少接口时不上传不保存任务', async () => {
  const ok = fixture();
  await ok.controller.start(input());
  assert.deepEqual(ok.calls.slice(0, 4).map(([name]) => name), ['architecture', 'runtime', 'preflight', 'upload']);
  assert.deepEqual(ok.calls[0][1].remote_target, input().connection.remote_target);
  assert.deepEqual(ok.calls[2][1].remote_target, input().connection.remote_target);
  for (const preflightTask of [undefined, async () => { throw Error('/usr/local 组可写 sudo-secret'); }]) {
    const f = fixture({ preflightTask });
    await f.controller.start(input());
    assert.equal(f.controller.getSnapshot().task.stage, 'check_failed');
    assert.equal(f.calls.some(([name]) => ['upload', 'submit', 'persist'].includes(name)), false);
    assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes('sudo-secret'));
  }
});

test('平台固定设备先核对架构，不匹配和探测失败均不上传或提交安装', async () => {
  for (const queryArchitecture of [
    async request => {
      assert.deepEqual(request.remote_target, input().connection.remote_target);
      return { os: 'Linux', architecture: 'aarch64', platform: 'linux-arm64' };
    },
    async () => { throw Error('隧道不可用'); },
  ]) {
    const f = fixture({ queryArchitecture });
    await f.controller.start(input());
    assert.equal(f.controller.getSnapshot().task.stage, 'check_failed');
    assert.equal(f.calls.some(([name]) => ['runtime', 'preflight', 'upload', 'submit', 'persist'].includes(name)), false);
    assert.equal(f.saved(), null);
  }
});

async function missingFixture(overrides = {}) {
  const original = fixture({ queryTask: async () => { throw Error('离线'); } });
  await original.controller.start(input());
  const f = fixture({
    loadPending: () => original.saved(),
    queryTask: async request => { f.calls.push(['query', request]); throw Error('LOWER_UPDATE_TASK_NOT_FOUND: 原任务不存在'); },
    queryRuntime: async request => { f.calls.push(['runtime', request]); return { exists: true, running: true, image_id: image }; },
    ...overrides,
  });
  await f.controller.resumeRemote({ method: 'password', password: 'new-secret' }, 'new-sudo');
  return f;
}

test('不存在任务经二次核验固定目标、健康镜像和归档后才能结束本地记录', async () => {
  const f = await missingFixture();
  await f.controller.closeMissingRemote({ method: 'password', password: 'close-secret' }, 'close-sudo');
  assert.equal(f.controller.getSnapshot().task.stage, 'task_closed');
  assert.equal(f.controller.getSnapshot().task.status, '本地记录已结束');
  assert.equal(f.saved(), null);
  assert.deepEqual(f.calls.map(([name]) => name), ['query', 'query', 'runtime', 'archive', 'close', 'persist']);
  assert.equal(f.calls.find(([name]) => name === 'close')[1].operation_id, f.calls[1][1].operation_id);
  assert.equal(f.calls.find(([name]) => name === 'close')[1].package_sha256, input().packageResult.sha256);
  assert.equal(f.calls.find(([name]) => name === 'close')[1].expected_image_id, image);
  const query = f.calls[1][1];
  const runtime = f.calls[2][1];
  assert.deepEqual(runtime.remote_target, query.remote_target);
  assert.equal(runtime.upload_account, query.upload_account);
  const archive = f.calls.find(([name]) => name === 'archive')[1];
  assert.equal(archive.task.operation_id, query.operation_id);
  assert.equal(archive.actual_image_id, image);
  assert.equal(archive.reason, 'task_not_found');
  assert.ok(!JSON.stringify(archive).includes('secret'));
  assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes('close-secret'));
});

test('结束记录的二次查询发现任务已受理或回退失败时保留记录', async () => {
  for (const phase of ['accepted', 'succeeded', 'rollback_failed']) {
    let queries = 0;
    const f = await missingFixture({ queryTask: async request => {
      if (++queries === 1) throw Error('LOWER_UPDATE_TASK_NOT_FOUND: 原任务不存在');
      return status(request, phase);
    } });
    await f.controller.closeMissingRemote({ method: 'password', password: 'new-secret' }, 'new-sudo');
    assert.equal(f.calls.some(([name]) => ['archive', 'persist', 'runtime', 'submit'].includes(name)), false);
    assert.notEqual(f.controller.getSnapshot().task.stage, 'task_closed');
    await assert.rejects(f.controller.start(input()), /原任务/);
  }
});

test('镜像异常、查询失败、归档失败及清除失败均保留记录且允许重试', async () => {
  for (const failure of ['not_exists', 'not_running', 'bad_image', 'query', 'archive', 'close', 'persist', 'missing_archive', 'missing_close']) {
    let bad = true;
    let queries = 0;
    const f = await missingFixture({
      queryTask: async () => {
        if (++queries > 1 && bad && failure === 'query') throw Error('无权核验安装进程');
        throw Error('LOWER_UPDATE_TASK_NOT_FOUND: 原任务不存在');
      },
      queryRuntime: async () => ({ exists: !(bad && failure === 'not_exists'), running: !(bad && failure === 'not_running'), image_id: bad && failure === 'bad_image' ? 'unknown' : image }),
      archivePending: failure === 'missing_archive' ? undefined : async () => { if (bad && failure === 'archive') throw Error('备份存储已满'); },
      closeTask: failure === 'missing_close' ? undefined : async () => { if (bad && failure === 'close') throw Error('设备拒绝关闭原任务'); },
      savePending: async () => { if (bad && failure === 'persist') throw Error('清除失败'); },
    });
    await f.controller.closeMissingRemote({ method: 'password', password: 'new-secret' }, 'new-sudo');
    assert.equal(f.controller.getSnapshot().task.stage, 'task_missing', failure);
    await assert.rejects(f.controller.start(input()), /原任务/);
    if (!['missing_archive', 'missing_close'].includes(failure)) {
      bad = false;
      await f.controller.closeMissingRemote({ method: 'password', password: 'new-secret' }, 'new-sudo');
      assert.equal(f.controller.getSnapshot().task.stage, 'task_closed', failure);
    }
  }
});

test('核验结束记录期间阻止并发查询与新任务，结束后允许明确新建', async () => {
  let release;
  const runtime = new Promise(resolve => { release = resolve; });
  const f = await missingFixture({ queryRuntime: () => runtime });
  const closing = f.controller.closeMissingRemote({ method: 'password', password: 'new-secret' }, 'new-sudo');
  await assert.rejects(f.controller.start(input()), /正在执行/);
  await assert.rejects(f.controller.resumeRemote({ method: 'password', password: 'new-secret' }, 'new-sudo'), /正在查询/);
  await assert.rejects(f.controller.closeMissingRemote({ method: 'password', password: 'new-secret' }, 'new-sudo'), /核验中/);
  release({ exists: true, running: true, image_id: image });
  await closing;
  assert.equal(f.controller.getSnapshot().task.stage, 'task_closed');
  await f.controller.start(input());
  assert.equal(f.controller.getSnapshot().task.stage, 'succeeded');
});

function pendingRecord() {
  const data = input();
  return {
    operation_id: '00000000-0000-4000-8000-000000000001', remote_target: data.connection.remote_target,
    upload_account: data.connection.upload_account, install_dir: data.connection.install_dir,
    package_name: data.packageResult.package_name, package_sha256: data.packageResult.sha256,
    expected_image_id: image, version: data.manifest.version,
  };
}
function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    scheduleTimeout: (callback, ms) => {
      const timer = { at: now + ms, callback };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance: ms => {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timers.has(timer) && timer.at <= now) { timers.delete(timer); timer.callback(); }
      }
    },
    pending: () => timers.size,
  };
}
async function flush() { for (let index = 0; index < 25; index++) await Promise.resolve(); }
const recoveryAuth = { method: 'password', password: 'recovery-secret' };

test('手工恢复仅查询一次，首个认证或通信错误立即去密显示并保留原记录', async () => {
  for (const detail of ['SSH认证失败 recovery-secret', '平台授权被拒绝', '指纹不匹配', '会话通道超时', '任务响应格式错误']) {
    let queries = 0;
    let sleeps = 0;
    const logs = [];
    const f = fixture({ loadPending: pendingRecord, queryTask: async () => { queries++; throw Error(detail); }, sleep: async () => { sleeps++; }, log: message => logs.push(message) });
    await f.controller.resumeRemote(recoveryAuth, 'sudo-recovery');
    assert.equal(queries, 1);
    assert.equal(sleeps, 0);
    const snapshot = f.controller.getSnapshot();
    assert.equal(snapshot.isRunning, false);
    assert.equal(snapshot.task.stage, 'remote_unknown');
    assert.equal(snapshot.task.error, detail.replace('recovery-secret', '[已隐藏]'));
    assert.equal(JSON.stringify([snapshot, logs]).includes('recovery-secret'), false);
    assert.equal(f.calls.some(([name]) => name === 'persist'), false);
    await assert.rejects(f.controller.start(input()), /原任务/);
  }
});

test('手工恢复执行中任务显示已知宿主阶段并结束本轮本地等待', async () => {
  for (const phase of ['accepted', 'preparing', 'installing', 'verifying', 'rolling_back']) {
    let queries = 0;
    const f = fixture({ loadPending: pendingRecord, queryTask: async request => { queries++; return { ...status(request, phase), message: '宿主进度 recovery-secret' }; } });
    await f.controller.resumeRemote(recoveryAuth, 'sudo-recovery');
    assert.equal(queries, 1);
    assert.equal(f.controller.getSnapshot().isRunning, false);
    assert.equal(f.controller.getSnapshot().canStopWaiting, false);
    assert.equal(f.controller.getSnapshot().task.stage, 'remote_unknown');
    assert.match(f.controller.getSnapshot().task.status, /宿主机/);
    assert.match(f.controller.getSnapshot().task.verificationMessage, new RegExp(phase));
    assert.equal(f.calls.some(([name]) => name === 'persist'), false);
    assert.equal(JSON.stringify(f.controller.getSnapshot()).includes('recovery-secret'), false);
  }
});

test('无回执的只读IPC在35秒结束本地等待，迟到终态不得清除原记录', async () => {
  const clock = fakeClock();
  let resolveQuery;
  const query = new Promise(resolve => { resolveQuery = resolve; });
  const f = fixture({ ...clock, loadPending: pendingRecord, queryTask: () => query });
  const observing = f.controller.resumeRemote(recoveryAuth, 'sudo-recovery');
  await flush();
  assert.equal(f.controller.getSnapshot().canStopWaiting, true);
  clock.advance(34_999);
  await flush();
  assert.equal(f.controller.getSnapshot().isRunning, true);
  clock.advance(1);
  await observing;
  assert.match(f.controller.getSnapshot().task.error, /35.*秒/);
  assert.equal(f.controller.getSnapshot().isRunning, false);
  assert.equal(f.controller.getSnapshot().canStopWaiting, false);
  const snapshot = f.controller.getSnapshot();
  resolveQuery(status(pendingRecord()));
  await flush();
  assert.deepEqual(f.controller.getSnapshot(), snapshot);
  assert.equal(f.calls.some(([name]) => name === 'persist'), false);
  assert.equal(clock.pending(), 0);
});

test('自动观测只有正常执行中才继续，首个错误立即结束', async () => {
  let queries = 0;
  let sleeps = 0;
  const f = fixture({ queryTask: async request => {
    if (++queries === 1) return status(request, 'installing');
    throw Error('平台隧道无法连接 ssh-secret');
  }, sleep: async () => { sleeps++; } });
  await f.controller.start(input());
  assert.equal(queries, 2);
  assert.equal(sleeps, 1);
  assert.equal(f.controller.getSnapshot().task.error, '平台隧道无法连接 [已隐藏]');
  assert.equal(f.controller.getSnapshot().isRunning, false);
  assert.ok(f.saved());
});

test('自动观测180秒总预算包含查询和轮询等待', async () => {
  const clock = fakeClock();
  let queries = 0;
  const f = fixture({ ...clock,
    queryTask: async request => { queries++; clock.advance(10_000); return status(request, 'installing'); },
    sleep: async ms => { clock.advance(ms); },
  });
  await f.controller.start(input());
  assert.ok(clock.now() >= 180_000 && clock.now() <= 185_000);
  assert.ok(queries < 20);
  assert.equal(f.controller.getSnapshot().isRunning, false);
  assert.match(f.controller.getSnapshot().task.verificationMessage, /180.*秒/);
  assert.ok(f.saved());
  assert.equal(clock.pending(), 0);
});

test('自动观测末轮无响应受剩余总预算限制', async () => {
  const clock = fakeClock();
  let queries = 0;
  const f = fixture({ ...clock,
    queryTask: async request => {
      if (++queries === 14) return new Promise(() => {});
      clock.advance(10_000);
      return status(request, 'installing');
    }, sleep: async ms => { clock.advance(ms); },
  });
  const deployment = f.controller.start(input());
  for (let index = 0; index < 20 && queries < 14; index++) await flush();
  assert.equal(queries, 14);
  assert.equal(clock.now(), 169_000);
  clock.advance(10_999);
  await flush();
  assert.equal(f.controller.getSnapshot().isRunning, true);
  clock.advance(1);
  await deployment;
  assert.equal(clock.now(), 180_000);
  assert.match(f.controller.getSnapshot().task.error, /180.*秒/);
  assert.equal(clock.pending(), 0);
});

test('自动轮询间隔也可立即停止等待，不提交或删除原任务', async () => {
  const clock = fakeClock();
  let sleeping = false;
  const f = fixture({ ...clock, queryTask: async request => status(request, 'installing'),
    sleep: async () => { sleeping = true; return new Promise(() => {}); },
  });
  const deployment = f.controller.start(input());
  await flush();
  assert.equal(sleeping, true);
  assert.equal(f.controller.getSnapshot().canStopWaiting, true);
  f.controller.stopObservingRemote();
  await deployment;
  assert.equal(f.controller.getSnapshot().isRunning, false);
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'persist').length, 1);
  assert.ok(f.saved());
  assert.equal(clock.pending(), 0);
});

test('结束记录的只读复核也有35秒兜底，超时不能进入写入阶段', async () => {
  const clock = fakeClock();
  let queries = 0;
  let rejectLate;
  const late = new Promise((_, reject) => { rejectLate = reject; });
  const f = await missingFixture({ ...clock, queryTask: async () => {
    if (++queries === 1) throw Error('LOWER_UPDATE_TASK_NOT_FOUND: 原任务不存在');
    return late;
  } });
  const closing = f.controller.closeMissingRemote(recoveryAuth, 'sudo-recovery');
  await flush();
  assert.equal(f.controller.getSnapshot().canStopWaiting, false);
  clock.advance(35_000);
  await closing;
  assert.equal(f.controller.getSnapshot().task.stage, 'task_missing');
  assert.match(f.controller.getSnapshot().task.error, /35.*秒/);
  const snapshot = f.controller.getSnapshot();
  rejectLate(Error('LOWER_UPDATE_TASK_NOT_FOUND: 原任务不存在'));
  await flush();
  assert.deepEqual(f.controller.getSnapshot(), snapshot);
  assert.equal(f.calls.some(([name]) => ['archive', 'close', 'persist'].includes(name)), false);
  assert.equal(clock.pending(), 0);
});

test('结束记录的运行状态核验35秒无回执时保留记录，迟到成功不触发写入', async () => {
  const clock = fakeClock();
  let resolveRuntime;
  const runtime = new Promise(resolve => { resolveRuntime = resolve; });
  const f = await missingFixture({ ...clock, queryRuntime: () => runtime });
  const closing = f.controller.closeMissingRemote(recoveryAuth, 'sudo-recovery');
  let ended = false;
  void closing.then(() => { ended = true; });
  await flush();
  assert.equal(f.controller.getSnapshot().canStopWaiting, false);
  clock.advance(35_000);
  await flush();
  assert.equal(ended, true);
  await closing;
  assert.equal(f.controller.getSnapshot().task.stage, 'task_missing');
  assert.match(f.controller.getSnapshot().task.error, /运行状态.*35.*秒/);
  const snapshot = f.controller.getSnapshot();
  resolveRuntime({ exists: true, running: true, image_id: image });
  await flush();
  assert.deepEqual(f.controller.getSnapshot(), snapshot);
  assert.equal(f.calls.some(([name]) => ['archive', 'close', 'persist'].includes(name)), false);
  await assert.rejects(f.controller.start(input()), /原任务/);
  assert.equal(clock.pending(), 0);
});

test('停止等待立即释放本轮查询，迟到成功或失败不能影响下一轮', async () => {
  for (const lateFailure of [false, true]) {
    const clock = fakeClock();
    let resolveFirst;
    let rejectFirst;
    const first = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    let resolveSecond;
    const second = new Promise(resolve => { resolveSecond = resolve; });
    let queries = 0;
    const f = fixture({ ...clock, loadPending: pendingRecord, queryTask: () => ++queries === 1 ? first : second });
    const waiting = f.controller.resumeRemote(recoveryAuth, 'sudo-recovery');
    await flush();
    assert.equal(f.controller.getSnapshot().canStopWaiting, true);
    f.controller.stopObservingRemote();
    await waiting;
    assert.equal(f.controller.getSnapshot().isRunning, false);
    assert.match(f.controller.getSnapshot().task.verificationMessage, /未取消|不取消/);
    await assert.rejects(f.controller.start(input()), /原任务/);
    const again = f.controller.resumeRemote({ method: 'password', password: 'second-secret' }, 'second-sudo');
    await flush();
    const snapshot = f.controller.getSnapshot();
    if (lateFailure) rejectFirst(Error('迟到错误 recovery-secret'));
    else resolveFirst(status(pendingRecord()));
    await flush();
    assert.deepEqual(f.controller.getSnapshot(), snapshot);
    assert.equal(f.calls.some(([name]) => name === 'persist'), false);
    resolveSecond(status(pendingRecord(), 'verifying'));
    await again;
    assert.equal(f.controller.getSnapshot().isRunning, false);
    assert.match(f.controller.getSnapshot().task.verificationMessage, /verifying/);
    assert.equal(clock.pending(), 0);
  }
});

test('立即停止尚未派发的查询，不发送请求或借用下一轮凭据', async () => {
  const clock = fakeClock();
  const requests = [];
  const f = fixture({ ...clock, loadPending: pendingRecord, queryTask: async request => { requests.push(request); return status(request, 'verifying'); } });
  const first = f.controller.resumeRemote(recoveryAuth, 'sudo-recovery');
  f.controller.stopObservingRemote();
  const second = f.controller.resumeRemote({ method: 'password', password: 'second-secret' }, 'second-sudo');
  await Promise.all([first, second]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].auth.password, 'second-secret');
  assert.match(f.controller.getSnapshot().task.verificationMessage, /verifying/);
  assert.equal(clock.pending(), 0);
});

test('终态开始消费持久记录后不能停止，提交与显式关闭阶段也不能停止', async () => {
  let clearPending;
  const clearing = new Promise(resolve => { clearPending = resolve; });
  const f = fixture({ loadPending: pendingRecord, savePending: async record => { f.calls.push(['persist', record]); await clearing; } });
  const waiting = f.controller.resumeRemote(recoveryAuth, 'sudo-recovery');
  await flush();
  assert.equal(f.calls.filter(([name]) => name === 'persist').length, 1);
  assert.equal(f.controller.getSnapshot().canStopWaiting, false);
  f.controller.stopObservingRemote();
  assert.equal(f.controller.getSnapshot().isRunning, true);
  clearPending();
  await waiting;
  assert.equal(f.controller.getSnapshot().task.stage, 'succeeded');

  let finishSubmit;
  const submitted = new Promise(resolve => { finishSubmit = resolve; });
  const submitting = fixture({ submitTask: () => submitted, queryTask: async () => { throw Error('通信失败'); } });
  const deployment = submitting.controller.start(input());
  await flush();
  assert.equal(submitting.controller.getSnapshot().task.stage, 'installing');
  assert.equal(submitting.controller.getSnapshot().canStopWaiting, false);
  submitting.controller.stopObservingRemote();
  assert.equal(submitting.controller.getSnapshot().isRunning, true);
  finishSubmit();
  await deployment;

  let finishClose;
  const closed = new Promise(resolve => { finishClose = resolve; });
  const closing = await missingFixture({ closeTask: () => closed });
  const closure = closing.controller.closeMissingRemote(recoveryAuth, 'sudo-recovery');
  await flush();
  assert.equal(closing.controller.getSnapshot().canStopWaiting, false);
  closing.controller.stopObservingRemote();
  assert.equal(closing.controller.getSnapshot().isRunning, true);
  finishClose();
  await closure;
  assert.equal(closing.controller.getSnapshot().task.stage, 'task_closed');
});

test('待处理记录标志包含持久恢复与损坏记录，停止超时不释放，清除成功后才释放', async () => {
  assert.equal(fixture().controller.getSnapshot().hasPendingRemote, false);
  for (const value of [pendingRecord(), { invalid: true }]) {
    const f = fixture({ loadPending: () => value });
    assert.equal(f.controller.getSnapshot().hasPendingRemote, true);
    await assert.rejects(f.controller.start(input()), /原任务|恢复记录/);
  }
  const f = fixture({ loadPending: pendingRecord });
  await f.controller.resumeRemote(recoveryAuth, 'sudo-recovery');
  assert.equal(f.controller.getSnapshot().hasPendingRemote, false);
});

test('直连恢复附加连接地址但不改写原任务平台、设备、账号、包或任务身份', async () => {
  const requests = [];
  const f = fixture({ loadPending: pendingRecord, queryTask: async request => {
    requests.push(request); throw Error('LOWER_UPDATE_TASK_NOT_FOUND: 任务不存在');
  } });
  const original = structuredClone(pendingRecord());
  await f.controller.resumeRemote(recoveryAuth, 'sudo-recovery', { recovery_direct_account: ' user@192.168.1.219:010022 ' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].recovery_direct_account, 'user@192.168.1.219:10022');
  for (const key of ['operation_id', 'upload_account', 'package_sha256', 'expected_image_id', 'package_name', 'remote_target']) {
    assert.deepEqual(requests[0][key], original[key]);
  }
  assert.equal(f.controller.getSnapshot().hasPendingRemote, true);
  assert.equal(f.controller.getSnapshot().task.stage, 'task_missing');
  assert.equal(f.calls.some(([name]) => ['persist', 'submit', 'upload'].includes(name)), false);
  assert.deepEqual(pendingRecord(), original);
  await f.controller.resumeRemote(recoveryAuth, 'sudo-recovery');
  assert.equal(requests[1].recovery_direct_account, undefined);
});

test('直连用户不一致或地址无效在任何查询前拒绝且保留原记录', async () => {
  for (const address of ['other@192.168.1.219:10022', 'user@remote:22', 'user@host:0', 'user@host:65536', 'user@host/path:22', '']) {
    const f = fixture({ loadPending: pendingRecord });
    await assert.rejects(f.controller.resumeRemote(recoveryAuth, 'sudo-recovery', { recovery_direct_account: address }), /直连|原任务/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.controller.getSnapshot().hasPendingRemote, true);
  }
});

test('切换恢复路径后结束必须重新核验同一路径，原记录归档且直连地址不持久化', async () => {
  const f = await missingFixture();
  assert.equal(f.controller.getSnapshot().hasPendingRemote, true);
  await f.controller.closeMissingRemote(recoveryAuth, 'sudo-recovery', { recovery_direct_account: 'user@192.168.1.219:10022' });
  assert.deepEqual(f.calls.map(([name]) => name), ['query', 'query', 'runtime', 'archive', 'close', 'persist']);
  assert.equal(f.calls[0][1].recovery_direct_account, undefined);
  for (const name of ['query', 'runtime', 'close']) {
    const request = f.calls.filter(([call]) => call === name).at(-1)[1];
    assert.equal(request.recovery_direct_account, 'user@192.168.1.219:10022');
    assert.deepEqual(request.remote_target, pendingRecord().remote_target);
    assert.equal(request.upload_account, pendingRecord().upload_account);
  }
  const archived = f.calls.find(([name]) => name === 'archive')[1];
  assert.equal(JSON.stringify(archived).includes('192.168.1.219'), false);
  assert.equal(JSON.stringify(archived).includes('secret'), false);
  assert.equal(f.controller.getSnapshot().hasPendingRemote, false);
  assert.equal(f.controller.getSnapshot().task.stage, 'task_closed');
});

test('直连指纹或连接错误原样去密展示，地址选择不改变待确认记录', async () => {
  const f = fixture({ loadPending: pendingRecord, queryTask: async request => {
    assert.equal(request.recovery_direct_account, 'user@192.168.1.219:10022');
    throw Error('原设备已信任主机指纹不匹配 recovery-secret');
  } });
  await f.controller.resumeRemote(recoveryAuth, 'sudo-recovery', { recovery_direct_account: 'user@192.168.1.219:10022' });
  assert.equal(f.controller.getSnapshot().hasPendingRemote, true);
  assert.equal(f.controller.getSnapshot().task.error, '原设备已信任主机指纹不匹配 [已隐藏]');
  assert.equal(f.calls.some(([name]) => ['persist', 'submit', 'close'].includes(name)), false);
});

test('直连确认原任务成功后释放记录，不依赖平台或重连当前其他设备', async () => {
  const f = fixture({ loadPending: pendingRecord });
  await f.controller.resumeRemote(recoveryAuth, 'sudo-recovery', { recovery_direct_account: 'user@192.168.1.219:10022' });
  assert.equal(f.controller.getSnapshot().task.stage, 'succeeded');
  assert.equal(f.controller.getSnapshot().hasPendingRemote, false);
  assert.match(f.controller.getSnapshot().task.runtimeRefreshMessage, /直连.*平台.*刷新/);
  assert.equal(f.calls.some(([name]) => name === 'reconnect'), false);
});

test('直连停止或35秒超时后旧结果不能影响新平台路径查询或清除记录', async () => {
  for (const stop of [true, false]) {
    const clock = fakeClock();
    let resolveDirect;
    const direct = new Promise(resolve => { resolveDirect = resolve; });
    const requests = [];
    let resolvePlatform;
    const platform = new Promise(resolve => { resolvePlatform = resolve; });
    const f = fixture({ ...clock, loadPending: pendingRecord, queryTask: request => {
      requests.push(request); return request.recovery_direct_account ? direct : platform;
    } });
    const first = f.controller.resumeRemote(recoveryAuth, 'sudo-recovery', { recovery_direct_account: 'user@192.168.1.219:10022' });
    await flush();
    if (stop) f.controller.stopObservingRemote(); else clock.advance(35_000);
    await first;
    assert.equal(f.controller.getSnapshot().hasPendingRemote, true);
    const second = f.controller.resumeRemote(recoveryAuth, 'sudo-recovery');
    await flush();
    const snapshot = f.controller.getSnapshot();
    resolveDirect(status(pendingRecord()));
    await flush();
    assert.deepEqual(f.controller.getSnapshot(), snapshot);
    assert.equal(requests[1].recovery_direct_account, undefined);
    assert.equal(f.calls.some(([name]) => name === 'persist'), false);
    resolvePlatform(status(pendingRecord(), 'installing'));
    await second;
    assert.equal(f.controller.getSnapshot().hasPendingRemote, true);
  }
});

test('结束原记录也拒绝不同用户直连，切换路径发现任务已受理则停止结束', async () => {
  const f = await missingFixture();
  await assert.rejects(f.controller.closeMissingRemote(recoveryAuth, 'sudo-recovery', { recovery_direct_account: 'other@192.168.1.219:10022' }), /原任务/);
  assert.deepEqual(f.calls.map(([name]) => name), ['query']);
  assert.equal(f.controller.getSnapshot().hasPendingRemote, true);
  let queries = 0;
  const accepted = await missingFixture({ queryTask: async request => {
    if (++queries === 1) throw Error('LOWER_UPDATE_TASK_NOT_FOUND: 原任务不存在');
    assert.equal(request.recovery_direct_account, 'user@192.168.1.219:10022');
    return status(request, 'accepted');
  } });
  await accepted.controller.closeMissingRemote(recoveryAuth, 'sudo-recovery', { recovery_direct_account: 'user@192.168.1.219:10022' });
  assert.equal(accepted.controller.getSnapshot().hasPendingRemote, true);
  assert.equal(accepted.controller.getSnapshot().task.stage, 'remote_unknown');
  assert.equal(accepted.calls.some(([name]) => ['archive', 'close', 'persist', 'runtime'].includes(name)), false);
});

test('直连关闭旧记录后新设备更新不继承恢复地址或旧身份', async () => {
  let newDeployment = false;
  const f = await missingFixture({ queryRuntime: async () => ({ exists: true, running: true, image_id: newDeployment ? 'old' : image }) });
  await f.controller.closeMissingRemote(recoveryAuth, 'sudo-recovery', { recovery_direct_account: 'user@192.168.1.219:10022' });
  assert.equal(f.controller.getSnapshot().hasPendingRemote, false);
  f.calls.length = 0;
  newDeployment = true;
  const next = input();
  next.connection.upload_account = 'daniel@remote:22';
  next.connection.remote_target.device_id = 'different-x64';
  next.connection.install_dir = '/home/daniel/devTest';
  await f.controller.start(next);
  const request = f.calls.find(([name]) => name === 'submit')[1];
  assert.equal(request.remote_target.device_id, 'different-x64');
  assert.equal(request.upload_account, 'daniel@remote:22');
  assert.equal(request.recovery_direct_account, undefined);
  assert.equal(f.calls.find(([name]) => name === 'upload')[1].recovery_direct_account, undefined);
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1);
});

test('直连确认成功但本地清除失败时继续保留阻拦记录', async () => {
  const f = fixture({ loadPending: pendingRecord, savePending: async () => { throw Error('本地存储写入失败'); } });
  await f.controller.resumeRemote(recoveryAuth, 'sudo-recovery', { recovery_direct_account: 'user@192.168.1.219:10022' });
  assert.equal(f.controller.getSnapshot().hasPendingRemote, true);
  assert.equal(f.controller.getSnapshot().task.stage, 'remote_unknown');
  assert.match(f.controller.getSnapshot().task.error, /本地存储写入失败/);
  assert.equal(f.calls.some(([name]) => name === 'reconnect'), false);
});
