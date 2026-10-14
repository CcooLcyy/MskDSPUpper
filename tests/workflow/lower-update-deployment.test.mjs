import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLowerUpdateDeploymentController } from '../../src/utils/lower-update-deployment.ts';
import { createLowerUpdateCredentialCoordinator, persistSuccessfulLowerUpdateConnection } from '../../src/utils/lower-update-connection.ts';

const expected = `sha256:${'a'.repeat(64)}`;
const previous = `sha256:${'b'.repeat(64)}`;
function input() {
  return {
    manifest: { schema_version: 1, product: 'mskdsp', channel: 'ci', platform: 'linux-x64', version: '0.4.0', package_version: '0.4.0', image_id: expected, published_at: '', source: { repository: '', ref: '', sha: '' }, asset: { name: 'package', url: '', size: 10, sha256: 'c'.repeat(64) }, checksum: { name: '', url: '' } },
    packageResult: { package_name: 'package', package_path: 'C:/package', downloaded_bytes: 10, sha256: 'c'.repeat(64) },
    connection: { upload_account: 'user@host:22', install_dir: '/home/user', auth: { method: 'password', password: 'ssh-secret' }, sudo_password: 'sudo-secret' },
    reuseSshPasswordForSudo: false, rememberPassword: true,
  };
}
function fixture(overrides = {}) {
  const calls = [];
  let queries = 0;
  const ops = {
    queryRuntime: async (request) => { calls.push(['query', request]); return { container_name: 'mskdsp', exists: true, running: true, image_id: queries++ === 0 ? previous : expected }; },
    upload: async (request, progress) => { calls.push(['upload', request]); progress({ percent: 50, uploaded_bytes: 5, total_bytes: 10, remote_path: '/home/user/package', stage: 'uploading', package_name: 'package' }); return { package_name: 'package', remote_path: '/home/user/package', uploaded_bytes: 10 }; },
    install: async (request) => { calls.push(['install', request]); return { success: true, already_current: false, exit_code: 0, stdout: '', stderr: '', command: 'install', remote_path: '/home/user/package', package_name: 'package' }; },
    cleanup: async (request) => { calls.push(['cleanup', request]); return { removed_files: 1, reclaimed_bytes: 123, remote_path: '/home/user/package' }; },
    saveConnection: async (snapshot, revision) => { calls.push(['save', snapshot, revision]); },
    credentialRevision: () => 7,
    sleep: async (duration) => { calls.push(['sleep', duration]); },
    log: (text) => { calls.push(['log', text]); },
    ...overrides,
  };
  return { controller: createLowerUpdateDeploymentController(ops), calls };
}

// 验证页面订阅撤销后流程仍执行，且输入修改不影响固定目标和凭据。
test('后台任务在页面卸载后继续，并复制私有输入', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { controller, calls } = fixture({ queryRuntime: async () => { await gate; return { exists: false, running: false, image_id: null, container_name: 'mskdsp' }; } });
  const original = input();
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications += 1; });
  const pending = controller.start(original);
  assert.equal(controller.getSnapshot().isRunning, true);
  assert.equal(controller.getSnapshot().task.stage, 'checking');
  original.connection.auth.password = 'new-secret';
  original.connection.upload_account = 'other@host:22';
  original.manifest.asset.name = 'other';
  original.packageResult.package_path = 'C:/other';
  unsubscribe();
  const count = notifications;
  controller.closeDetails();
  release();
  await pending;
  assert.equal(notifications, count);
  assert.equal(controller.getSnapshot().task.stage, 'verify_failed');
  const request = calls.find(([name]) => name === 'upload')[1];
  assert.equal(request.upload_account, 'user@host:22');
  assert.equal(request.auth.password, 'ssh-secret');
  assert.equal(request.package_path, 'C:/package');
  assert.equal(controller.getSnapshot().resultOpen, true);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('secret'), false);
});

// 验证上传或安装中收起弹窗并撤销页面订阅，完成后仍显示一次全局结果。
test('上传和安装期间切页仍完成确认及清理', async () => {
  for (const pausedOperation of ['upload', 'install']) {
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const reachedOperation = new Promise((resolve) => { started = resolve; });
    const operations = {
      [pausedOperation]: async (request) => {
        started();
        await gate;
        return pausedOperation === 'upload'
          ? { package_name: request.package_name, remote_path: '/home/user/package', uploaded_bytes: 10 }
          : { package_name: request.package_name, remote_path: '/home/user/package', success: true, already_current: false, exit_code: 0, command: 'install', stdout: '', stderr: '' };
      },
    };
    const { controller, calls } = fixture(operations);
    const unsubscribe = controller.subscribe(() => {});
    const pending = controller.start(input());
    await reachedOperation;
    controller.closeDetails();
    unsubscribe();
    assert.equal(controller.getSnapshot().isRunning, true);
    assert.equal(controller.getSnapshot().detailOpen, false);
    release();
    await pending;
    assert.equal(controller.getSnapshot().task.stage, 'succeeded');
    assert.equal(controller.getSnapshot().resultOpen, true);
    assert.equal(calls.filter(([name]) => name === 'cleanup').length, 1);
  }
});

// 验证异步预检期间同步锁定任务，防止双击启动。
test('预检期间重复启动和重试被拒绝', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { controller } = fixture({ queryRuntime: async () => { await gate; return { exists: true, running: true, image_id: expected, container_name: 'mskdsp' }; } });
  const pending = controller.start(input());
  await assert.rejects(controller.start(input()), /已有下位机更新任务/);
  await assert.rejects(controller.retry('retry'), /已有下位机更新任务/);
  release();
  await pending;
});

// 验证完整流程顺序、一次结果提示和详情窗口互斥。
test('成功后跨页显示一次结果，详情与结果窗口互斥', async () => {
  const { controller, calls } = fixture();
  await controller.start(input());
  assert.equal(controller.getSnapshot().task.stage, 'succeeded');
  assert.deepEqual(calls.filter(([name]) => ['query', 'upload', 'install', 'cleanup'].includes(name)).map(([name]) => name), ['query', 'upload', 'install', 'query', 'cleanup']);
  assert.equal(controller.getSnapshot().detailOpen, false);
  assert.equal(controller.getSnapshot().resultOpen, true);
  controller.dismissResult();
  const unsubscribe = controller.subscribe(() => {});
  unsubscribe();
  assert.equal(controller.getSnapshot().resultOpen, false);
  controller.openDetails();
  assert.equal(controller.getSnapshot().detailOpen, true);
  assert.equal(controller.getSnapshot().resultOpen, false);
  controller.closeDetails();
  assert.equal(controller.getSnapshot().task.stage, 'succeeded');
});

// 验证预检失败或已是最新时不上传、安装或清理。
test('预检失败及目标已是最新停止后续操作', async () => {
  for (const queryRuntime of [async () => { throw new Error('网络失败'); }, async () => ({ exists: true, running: true, image_id: expected, container_name: 'mskdsp' })]) {
    const { controller, calls } = fixture({ queryRuntime });
    await controller.start(input());
    assert.equal(calls.some(([name]) => ['upload', 'install', 'cleanup'].includes(name)), false);
    assert.equal(controller.getSnapshot().resultOpen, true);
  }
});

// 验证上传和安装失败不继续执行危险步骤。
test('上传和安装失败保留阶段并停止后续步骤', async () => {
  const first = fixture({ upload: async () => { throw new Error('上传失败'); } });
  await first.controller.start(input());
  assert.equal(first.controller.getSnapshot().task.stage, 'upload_failed');
  assert.equal(first.calls.some(([name]) => name === 'install'), false);
  const second = fixture({ install: async () => ({ success: false, already_current: false, exit_code: 1, stdout: '', stderr: '失败', command: 'install', remote_path: '/tmp/package', package_name: 'package' }) });
  await second.controller.start(input());
  assert.equal(second.controller.getSnapshot().task.stage, 'install_failed');
  assert.equal(second.calls.some(([name]) => name === 'cleanup'), false);
});

// 验证镜像不一致保留历史包，查询失败按六次与既有等待间隔执行。
test('镜像不一致和六次查询失败均保留历史包', async () => {
  const mismatch = fixture({ queryRuntime: async () => ({ exists: true, running: true, image_id: previous, container_name: 'mskdsp' }) });
  await mismatch.controller.start(input());
  assert.equal(mismatch.controller.getSnapshot().task.stage, 'image_mismatch');
  assert.equal(mismatch.calls.some(([name]) => name === 'cleanup'), false);
  let count = 0;
  const failed = fixture({ queryRuntime: async () => { count += 1; if (count > 1) throw new Error('容器未恢复'); return { exists: true, running: true, image_id: previous, container_name: 'mskdsp' }; } });
  await failed.controller.start(input());
  assert.equal(count, 7);
  assert.equal(failed.controller.getSnapshot().task.stage, 'verify_failed');
  assert.deepEqual(failed.calls.filter(([name]) => name === 'sleep').map(([, duration]) => duration), [5000, 3000, 3000, 3000, 3000, 3000]);
  assert.equal(failed.calls.some(([name]) => name === 'cleanup'), false);
});

// 验证清理失败不改变升级成功，重新确认时只执行验证和清理。
test('清理失败保持升级成功并允许重新确认后重试', async () => {
  let cleanupCount = 0;
  const { controller, calls } = fixture({ cleanup: async () => { cleanupCount += 1; if (cleanupCount === 1) throw new Error('清理失败'); return { removed_files: 2, reclaimed_bytes: 20, remote_path: '/tmp/package' }; } });
  await controller.start(input());
  assert.equal(controller.getSnapshot().task.stage, 'succeeded');
  assert.equal(controller.getSnapshot().task.cleanupError, '清理失败');
  await controller.retry('reverify');
  assert.equal(controller.getSnapshot().task.cleanupError, null);
  assert.equal(calls.filter(([name]) => name === 'upload').length, 1);
  assert.equal(calls.filter(([name]) => name === 'install').length, 1);
  assert.equal(controller.getSnapshot().resultOpen, true);
});

// 验证错误和安装输出不能向公共快照或日志泄露任务密码。
test('公共任务和日志脱敏密码', async () => {
  const { controller, calls } = fixture({ install: async () => { throw new Error('命令 ssh-secret sudo-secret'); } });
  await controller.start(input());
  const publicOutput = JSON.stringify([controller.getSnapshot(), calls.filter(([name]) => name === 'log')]);
  assert.equal(publicOutput.includes('ssh-secret'), false);
  assert.equal(publicOutput.includes('sudo-secret'), false);
});

// 验证包与清单不一致时在预检前阻止任务执行。
test('拒绝清单与包校验信息不匹配', async () => {
  const { controller, calls } = fixture();
  const value = input();
  value.packageResult.sha256 = 'wrong';
  await controller.start(value);
  assert.equal(controller.getSnapshot().task.stage, 'check_failed');
  assert.equal(calls.some(([name]) => name === 'query'), false);
});

// 验证连接信息保存暂时失败后重试成功，不在最终结果中保留过期警告。
test('连接信息后续保存成功清除过期警告', async () => {
  let saves = 0;
  const { controller } = fixture({ saveConnection: async () => {
    saves += 1;
    if (saves === 1) throw new Error('保存暂时失败');
  } });
  await controller.start(input());
  assert.equal(saves, 2);
  assert.equal(controller.getSnapshot().task.stage, 'succeeded');
  assert.equal(controller.getSnapshot().task.connectionWarning, null);
});

// 验证短密码脱敏只影响展示，不参与镜像摘要比较。
test('密码是摘要子串时仍正确比较原始镜像', async () => {
  const { controller } = fixture();
  const value = input();
  value.connection.auth.password = 'a';
  await controller.start(value);
  assert.equal(controller.getSnapshot().task.stage, 'succeeded');
  assert.match(controller.getSnapshot().task.actualImageId, /已隐藏/);
  const already = fixture({ queryRuntime: async () => ({ exists: true, running: true, image_id: expected, container_name: 'mskdsp' }) });
  await already.controller.start(value);
  assert.equal(already.controller.getSnapshot().task.alreadyCurrent, true);
});

// 验证取消记住凭据授权后，后台旧任务及其显式重试不能重新保存凭据。
test('凭据撤销代次跨页及重试仍保护旧任务保存', async () => {
  const coordinator = createLowerUpdateCredentialCoordinator();
  let saves = 0;
  const { controller } = fixture({
    credentialRevision: (account) => coordinator.revision(account),
    upload: async (request) => {
      coordinator.revoke(request.upload_account);
      return { package_name: 'package', remote_path: '/home/user/package', uploaded_bytes: 10 };
    },
    saveConnection: async (snapshot, revision) => coordinator.run(snapshot.settings.upload_account, () => persistSuccessfulLowerUpdateConnection(snapshot, {
      save: async () => { saves += 1; }, cache: () => {}, warn: () => {},
      canRemember: () => revision === coordinator.revision(snapshot.settings.upload_account),
    })),
  });
  await controller.start(input());
  await controller.retry('reupload');
  assert.equal(saves, 0);
});

// 验证重新上传和重新安装遇到已是最新仍保留可重新确认的成功安装上下文。
test('重新上传或安装预检跳过时保留成功记录', async () => {
  for (const mode of ['reupload', 'reinstall']) {
    const { controller, calls } = fixture();
    await controller.start(input());
    await controller.retry(mode);
    assert.equal(controller.getSnapshot().task.stage, 'succeeded');
    assert.equal(controller.getSnapshot().task.alreadyCurrent, true);
    assert.equal(controller.getSnapshot().task.installResult.success, true);
    assert.match(controller.getSnapshot().task.cleanupMessage, /未执行/);
    assert.equal(calls.filter(([name]) => name === 'install').length, 1);
    await controller.retry('reverify');
    assert.equal(calls.filter(([name]) => name === 'cleanup').length, 2);
  }
});

// 验证普通重试在目标镜像已一致时继续补齐失败的历史包清理。
test('普通重试可补齐成功安装后的清理失败', async () => {
  let count = 0;
  const { controller, calls } = fixture({ cleanup: async () => { if (++count === 1) throw new Error('清理失败'); return { removed_files: 1, reclaimed_bytes: 10, remote_path: '/home/user/package' }; } });
  await controller.start(input());
  await controller.retry('retry');
  assert.equal(controller.getSnapshot().task.cleanupError, null);
  assert.equal(count, 2);
  assert.equal(calls.filter(([name]) => name === 'install').length, 1);
});

// 验证非本任务包或路径的进度及上传完成后的迟到事件不会覆盖任务。
test('忽略其他上传进度及已结束上传的迟到事件', async () => {
  let delayedProgress;
  const { controller } = fixture({ upload: async (_request, progress) => {
    delayedProgress = progress;
    progress({ package_name: 'other', remote_path: '/home/user/package', percent: 90, uploaded_bytes: 9, total_bytes: 10, stage: 'uploading' });
    assert.equal(controller.getSnapshot().task.uploadedBytes, 0);
    progress({ package_name: 'package', remote_path: '/other/package', percent: 90, uploaded_bytes: 9, total_bytes: 10, stage: 'uploading' });
    assert.equal(controller.getSnapshot().task.uploadedBytes, 0);
    return { package_name: 'package', remote_path: '/home/user/package', uploaded_bytes: 10 };
  } });
  await controller.start(input());
  delayedProgress({ package_name: 'package', remote_path: '/home/user/package', percent: 10, uploaded_bytes: 1, total_bytes: 10, stage: 'uploading' });
  assert.equal(controller.getSnapshot().task.progress, 100);
  assert.equal(controller.getSnapshot().task.uploadedBytes, 10);
});
