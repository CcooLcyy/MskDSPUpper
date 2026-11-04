import test from 'node:test';
import assert from 'node:assert/strict';
import * as access from '../../src/utils/lower-platform-access.ts';
const { createPlatformAccessController, platformAccessRequest } = access;

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

const preset = () => ({ interface_name: 'eth0.102', gateway: '192.168.2.1', dns_servers: [] });
const legacyNetwork = () => ({ interface_name: 'eth0.105', gateway: '192.168.5.1', dns_servers: ['8.8.8.8'] });

test('supported devices always submit the fixed 102 preset with existing DNS regardless of prior config', () => {
  for (const previous of [legacyNetwork(), { interface_name: '', gateway: '', dns_servers: [] }, preset()]) {
    const request = platformAccessRequest(status({ network_config: previous }), form({ enabled: false }));
    assert.deepEqual(request.network_config, preset());
    assert.equal('network_mode' in request, false);
  }
  const mutated = platformAccessRequest(status({ network_config: preset() }), form());
  mutated.network_config.dns_servers.push('9.9.9.9');
  mutated.network_config.gateway = '192.168.2.2';
  assert.deepEqual(platformAccessRequest(status({ network_config: preset() }), form()).network_config, preset());
  assert.equal('network_config' in platformAccessRequest(status(), form()), false);
  assert.equal('network_config' in platformAccessRequest(status({ network_config: null }), form()), false);
});

test('fixed exit is applied only when returned config matches and runtime apply succeeded', () => {
  const applied = status({ network_config: preset(), network_applied: true, network_error: '' });
  assert.equal(access.isOrdinaryNetworkPresetApplied(applied), true);
  for (const patch of [{ network_config: legacyNetwork() }, { network_config: { interface_name: '', gateway: '', dns_servers: [] } },
    { network_config: { ...preset(), dns_servers: ['192.168.2.1'] } }, { network_applied: false }, { network_error: '网络应用失败' }, { network_config: null }]) {
    assert.equal(access.isOrdinaryNetworkPresetApplied({ ...applied, ...patch }), false);
  }
});

test('readback does not create editable network drafts and failed apply preserves platform drafts', async () => {
  let current = status({ network_config: legacyNetwork(), network_applied: true, network_error: '' });
  const controller = createPlatformAccessController({ read: async () => current, save: async () => ({ ...current, network_applied: false, network_error: '网络应用失败', revision: '9007199254740994' }) });
  await controller.read();
  assert.equal('network_config' in controller.getSnapshot().form, false);
  assert.equal('network_mode' in controller.getSnapshot().form, false);
  controller.update({ device_token: 'draft-secret', ssh_port: 10022 });
  current = { ...current, online: true }; await controller.refreshRuntime();
  assert.equal(controller.getSnapshot().form.device_token, 'draft-secret');
  await controller.save();
  assert.equal(controller.getSnapshot().saved, false);
  assert.equal(controller.getSnapshot().form.device_token, 'draft-secret');
  assert.equal(controller.getSnapshot().needsReload, true);
});

test('network RPC failure retains platform draft and requires reread without automatic retry', async () => {
  let writes = 0;
  const controller = createPlatformAccessController({
    read: async () => status({ network_config: preset(), network_applied: true }),
    save: async () => { writes += 1; throw { kind: 'network_apply_failed', message: '网络应用失败，请重新读取' }; },
  });
  await controller.read(); controller.update({ ssh_port: 10022 });
  await controller.save(); await controller.save();
  assert.equal(writes, 1);
  assert.equal(controller.getSnapshot().needsReload, true);
  assert.equal(controller.getSnapshot().saved, false);
  assert.equal(controller.getSnapshot().form.ssh_port, 10022);
});

test('save cannot report success if a supported device returns another config or drops network acknowledgement', async () => {
  for (const returned of [legacyNetwork(), { interface_name: '', gateway: '', dns_servers: [] }, null]) {
    const controller = createPlatformAccessController({ read: async () => status({ network_config: preset(), network_applied: true }),
      save: async () => status({ network_config: returned, network_applied: true, network_error: '' }) });
    await controller.read(); await controller.save();
    assert.equal(controller.getSnapshot().saved, false);
    assert.equal(controller.getSnapshot().needsReload, true);
  }
});

test('runtime mismatch removes earlier success and matching acknowledgement shows successful preset save', async () => {
  let current = status({ network_config: preset(), network_applied: true, network_error: '' });
  const controller = createPlatformAccessController({ read: async () => current, save: async () => current });
  await controller.read(); await controller.save();
  assert.equal(controller.getSnapshot().saved, true);
  current = { ...current, network_config: legacyNetwork() }; await controller.refreshRuntime();
  assert.equal(controller.getSnapshot().saved, false);
});

test('a revised device config shows its pending preset state without overwriting the platform draft', async () => {
  let current = status({ network_config: preset(), network_applied: true, network_error: '' });
  const controller = createPlatformAccessController({ read: async () => current, save: async () => current });
  await controller.read(); await controller.save();
  controller.update({ ssh_port: 10022 });
  current = { ...current, revision: '9007199254740994', network_config: legacyNetwork() };
  await controller.refreshRuntime();
  assert.equal(access.isOrdinaryNetworkPresetApplied(controller.getSnapshot().status), false);
  assert.equal(controller.getSnapshot().needsReload, true);
  assert.equal(controller.getSnapshot().form.ssh_port, 10022);
});
