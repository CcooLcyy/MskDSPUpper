import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformAccessController, platformAccessRequest } from '../../src/utils/lower-platform-access.ts';

const status = (patch = {}) => ({ enabled: true, platform_target: '60.208.15.90:50000', device_id: 'field-1', token_configured: true,
  ssh_enabled: true, ssh_port: 22, revision: '9007199254740993', online: false, last_error: '',
  connection_generation: '4', manager_address: '192.0.2.1:17000', ...patch });
const form = (patch = {}) => ({ enabled: true, device_id: 'field-1', device_token: '', clear_device_token: false,
  ssh_enabled: true, ssh_port: 22, ...patch });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('factory settings preserve existing token and exact revision without an editable platform address', () => {
  const request = platformAccessRequest(status(), form());
  assert.equal(request.device_token, '');
  assert.equal(request.expected_revision, '9007199254740993');
  assert.equal(request.connection_generation, '4');
  assert.equal(request.manager_address, '192.0.2.1:17000');
  assert.equal('platform_target' in request, false);
  assert.equal(platformAccessRequest(status(), form({ ssh_port: 0 })).ssh_port, 22);
});
test('identity change and token clearing obey lower device rules', () => {
  assert.throws(() => platformAccessRequest(status(), form({ device_id: 'other' })), /新令牌|清除/);
  assert.throws(() => platformAccessRequest(status(), form({ clear_device_token: true })), /关闭/);
  assert.throws(() => platformAccessRequest(status(), form({ device_token: 'secret', clear_device_token: true })), /同时/);
  assert.throws(() => platformAccessRequest(status(), form({ device_token: 'bad\nsecret' })), /ASCII/);
  assert.throws(() => platformAccessRequest(status(), form({ ssh_port: 65536 })), /端口/);
  assert.throws(() => platformAccessRequest(status(), form({ ssh_port: Number.NaN })), /端口/);
  assert.throws(() => platformAccessRequest(status({ token_configured: false }), form()), /令牌/);
  assert.throws(() => platformAccessRequest(status(), form({ device_id: '' })), /设备 ID/);
  assert.equal(platformAccessRequest(status(), form({ enabled: false, device_id: 'other', clear_device_token: true })).clear_device_token, true);
});
test('save clears the new credential and exposes persistence separately from online status', async () => {
  let captured;
  const controller = createPlatformAccessController({ read: async () => status(), save: async request => { captured = request; return status({ revision: '9007199254740994' }); } });
  await controller.read(); controller.update({ device_token: 'new-secret' }); await controller.save();
  assert.equal(captured.device_token, 'new-secret');
  assert.equal(controller.getSnapshot().form.device_token, '');
  assert.equal(controller.getSnapshot().saved, true);
  assert.equal(controller.getSnapshot().status.online, false);
});
test('device switch ignores pending read and save responses and discards credentials', async () => {
  const pendingRead = deferred(); const pendingSave = deferred();
  let read = () => pendingRead.promise;
  const controller = createPlatformAccessController({ read: () => read(), save: () => pendingSave.promise });
  const oldRead = controller.read(); controller.reset();
  pendingRead.resolve(status()); await oldRead;
  assert.equal(controller.getSnapshot().status, null);
  read = async () => status(); await controller.read(); controller.update({ device_token: 'old-secret' });
  const oldSave = controller.save(); controller.reset(); pendingSave.resolve(status()); await oldSave;
  assert.equal(controller.getSnapshot().status, null); assert.equal(controller.getSnapshot().form.device_token, '');
});
test('revision conflict requires explicit reread and never retries an overwrite', async () => {
  let saves = 0;
  const controller = createPlatformAccessController({ read: async () => status(), save: async () => { saves += 1; throw { kind: 'revision_conflict', message: '配置已变化，请重新读取' }; } });
  await controller.read(); await controller.save(); await controller.save();
  assert.equal(saves, 1); assert.equal(controller.getSnapshot().needsReload, true);
  assert.match(controller.getSnapshot().error, /重新读取/);
});
test('runtime refresh never overwrites an edited credential or applies a stale request after reset', async () => {
  let current = status(); const controller = createPlatformAccessController({ read: async () => current, save: async () => status() });
  await controller.read(); controller.update({ device_token: 'draft-secret', ssh_port: 10022 });
  current = status({ online: true }); await controller.refreshRuntime();
  assert.equal(controller.getSnapshot().status.online, true); assert.equal(controller.getSnapshot().form.device_token, 'draft-secret');
  assert.equal(controller.getSnapshot().form.ssh_port, 10022);
  current = status({ revision: '9007199254740994' }); await controller.refreshRuntime();
  assert.equal(controller.getSnapshot().needsReload, true);
});
