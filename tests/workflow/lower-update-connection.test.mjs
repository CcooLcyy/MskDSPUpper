import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readLowerUpdateConnectionSettings,
  snapshotLowerUpdateConnection,
  createLowerUpdateCredentialReadGuard,
  createLowerUpdateCredentialCoordinator,
  lowerUpdateCredentialAccountKey,
  persistSuccessfulLowerUpdateConnection,
} from '../../src/utils/lower-update-connection.ts';

const settings = {
  upload_account: 'megsky@192.168.1.219:10022',
  install_dir: '/home/megsky',
  auth_method: 'password',
  reuse_ssh_password_for_sudo: true,
  remember_password: true,
};

// 恢复普通配置时丢弃敏感字段，并拒绝无效字段值。
test('connection settings restore only valid, non-sensitive whitelisted fields', () => {
  assert.deepEqual(readLowerUpdateConnectionSettings({ ...settings, password: 'secret', auth: { password: 'secret' } }), settings);
  for (const invalid of [null, {}, { ...settings, auth_method: 'unknown' }, { ...settings, upload_account: 'host' }, { ...settings, install_dir: 'relative' }, { ...settings, remember_password: 'true' }]) {
    assert.equal(readLowerUpdateConnectionSettings(invalid), null);
  }
});

// 请求发出后编辑表单，不能改变成功回调所保存的实际请求。
test('success persistence captures the actual request and does not expose secrets in metadata', async () => {
  const request = { upload_account: ' megsky@192.168.1.219:10022 ', install_dir: ' /home/megsky ', auth: { method: 'password', password: 'ssh-secret' }, sudo_password: 'sudo-secret' };
  const snapshot = snapshotLowerUpdateConnection(request, false, true);
  request.auth.password = 'later-secret';
  request.upload_account = 'other@host:22';
  let saved;
  let cached;
  assert.equal(await persistSuccessfulLowerUpdateConnection(snapshot, {
    save: async (...args) => { saved = args; },
    cache: (value) => { cached = value; },
    warn: () => assert.fail('unexpected warning'),
  }), true);
  assert.deepEqual(saved, [{ ...settings, reuse_ssh_password_for_sudo: false }, { method: 'password', password: 'ssh-secret' }, 'sudo-secret']);
  assert.equal(JSON.stringify(cached).includes('secret'), false);
});

// 保存错误只产生独立提醒，提示不能泄露后端错误中的秘密。
test('save failure warns without changing a successful deployment into a failure', async () => {
  let warning;
  const snapshot = snapshotLowerUpdateConnection({ ...settings, auth: { method: 'certificate' }, sudo_password: 'secret' }, false, true);
  assert.equal(await persistSuccessfulLowerUpdateConnection(snapshot, {
    save: async () => { throw new Error('sensitive error'); },
    cache: () => assert.fail('must not cache failed save'),
    warn: (value) => { warning = value; },
  }), false);
  assert.match(warning, /下发成功.*保存失败/);
  assert.equal(warning.includes('sensitive'), false);
});

// 旧设备的异步读取和用户输入后的回调均不能覆盖对应密码框。
test('credential guard rejects old targets and preserves edited password fields', () => {
  const guard = createLowerUpdateCredentialReadGuard();
  const first = guard.begin();
  guard.markEdited('ssh');
  assert.equal(guard.canApply(first, 'ssh'), false);
  assert.equal(guard.canApply(first, 'sudo'), true);
  guard.invalidate();
  assert.equal(guard.canApply(first, 'sudo'), false);
  const second = guard.begin();
  assert.equal(guard.canApply(second, 'ssh'), true);
  guard.markEdited('sudo');
  assert.equal(guard.canApply(second, 'sudo'), false);
});

// 关闭再开启记住开关仍然撤销旧任务，不能写回配置或清除新任务的密码。
test('turning off remember while deployment is running prevents its old callback saving credentials', async () => {
  const coordinator = createLowerUpdateCredentialCoordinator();
  const revision = coordinator.revision(settings.upload_account);
  coordinator.revoke(settings.upload_account);
  coordinator.revoke(settings.upload_account);
  const snapshot = snapshotLowerUpdateConnection({ ...settings, auth: { method: 'password', password: 'secret' }, sudo_password: 'secret' }, true, true);
  assert.equal(await persistSuccessfulLowerUpdateConnection(snapshot, {
    save: async () => assert.fail('revoked task must not save'),
    cache: () => assert.fail('revoked task must not replace metadata'), warn: () => {},
    canRemember: () => revision === coordinator.revision(settings.upload_account),
  }), false);
});

// 证书登录始终使用独立 sudo 密码；关闭记住密码仅影响持久化选项。
test('certificate and remember options preserve the correct request secrets without metadata leakage', () => {
  const snapshot = snapshotLowerUpdateConnection({ ...settings, auth: { method: 'certificate' }, sudo_password: 'sudo-secret' }, true, false);
  assert.equal(snapshot.settings.reuse_ssh_password_for_sudo, false);
  assert.equal(snapshot.settings.remember_password, false);
  assert.equal(snapshot.sudoPassword, 'sudo-secret');
  assert.equal(JSON.stringify(snapshot.settings).includes('sudo-secret'), false);
  assert.deepEqual(readLowerUpdateConnectionSettings({ ...settings, upload_account: ' megsky@host:00022 ', install_dir: ' /home/megsky/// ' }), { ...settings, upload_account: 'megsky@host:22' });
});

// 即使旧页面的 save 已进入后端，新页面清除也必须等它结束再删除；不同设备互不阻塞。
test('credential coordinator serializes same-target writes and clear across page instances', async () => {
  const coordinator = createLowerUpdateCredentialCoordinator();
  let finishSave;
  const events = [];
  const saving = coordinator.run('MegSky@HOST:00022', async () => {
    events.push('save-start');
    await new Promise((resolve) => { finishSave = resolve; });
    events.push('save-end');
  });
  await Promise.resolve();
  await Promise.resolve();
  coordinator.revoke('megsky@host:22');
  assert.equal(coordinator.revision('MEGSKY@Host:00022'), 1);
  const clearing = coordinator.run('megsky@host:22', async () => { events.push('clear'); });
  await coordinator.run('other@host:22', async () => { events.push('other'); });
  assert.deepEqual(events, ['save-start', 'other']);
  finishSave();
  await Promise.all([saving, clearing]);
  assert.deepEqual(events, ['save-start', 'other', 'save-end', 'clear']);
});

// 凭据索引应对齐 Windows 的大小写规则，同时不得改变 Linux 实际登录账号。
test('Windows credential account keys ignore ASCII case without rewriting connection metadata', () => {
  assert.equal(lowerUpdateCredentialAccountKey(' MegSky@DEVICE:00022 '), lowerUpdateCredentialAccountKey('megsky@device:22'));
  const value = readLowerUpdateConnectionSettings({ ...settings, upload_account: 'MegSky@DEVICE:00022' });
  assert.equal(value.upload_account, 'MegSky@DEVICE:22');
});

// 撤销可能发生在排队期间，必须在实际执行保存时再次验证代次；失败队列也应可恢复。
test('queued save rechecks revocation and a failed operation does not block subsequent clear', async () => {
  const coordinator = createLowerUpdateCredentialCoordinator();
  const account = settings.upload_account;
  const revision = coordinator.revision(account);
  let finishBlock;
  const blocking = coordinator.run(account, () => new Promise((resolve) => { finishBlock = resolve; }));
  const snapshot = snapshotLowerUpdateConnection({ ...settings, auth: { method: 'certificate' }, sudo_password: 'secret' }, false, true);
  const pendingSave = coordinator.run(account, () => persistSuccessfulLowerUpdateConnection(snapshot, {
    save: async () => assert.fail('queued stale save must not execute'), cache: () => assert.fail('must not cache'), warn: () => {},
    canRemember: () => revision === coordinator.revision(account),
  }));
  coordinator.revoke(account.toUpperCase());
  await Promise.resolve();
  await Promise.resolve();
  finishBlock();
  await blocking;
  assert.equal(await pendingSave, false);
  await assert.rejects(coordinator.run(account, async () => { throw new Error('failed save'); }));
  assert.equal(await coordinator.run(account, async () => 'cleared'), 'cleared');
});
