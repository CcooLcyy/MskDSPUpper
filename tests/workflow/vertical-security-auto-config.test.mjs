import assert from 'node:assert/strict';
import test from 'node:test';
import { autoConfigOrder, buildAutoConfig, clearAppliedSecurityNetwork, getAppliedSecurityNetwork, rememberAppliedSecurityNetwork, uploadAutoConfig } from '../../src/utils/vertical-security-auto-config.ts';

const addresses = { device: 'MskDSP', localRtuAddress: '30.19.80.177', localSecurityAddress: '30.19.80.189', localGatewayAddress: '30.19.80.190', remoteRtuAddress: '30.19.0.1', remoteSecurityAddress: '30.19.0.250', remoteGatewayAddress: '30.19.0.254' };
const plan = () => buildAutoConfig(addresses, 'station.pem');
const result = (kind, extra = {}) => ({ kind, revision: 'revision', rows: [], interfaces: [], certificates: [], tunnel_ids: [], verified: true, message: '', ...extra });

test('自动配置生成确认的四页：地址来源、记录数、策略端口和隧道引用', () => {
  const rows = plan();
  assert.deepEqual(autoConfigOrder.map(kind => rows[kind].length), [2, 2, 1, 4]);
  assert.deepEqual(rows.network, [
    { description: 'Just', interface: 'eth1', interface_type: 'PRIVATE', ip: '192.168.8.220', netmask: '255.255.255.0', vlan: '0' },
    { description: 'Just', interface: 'eth2', interface_type: 'PUBLIC', ip: addresses.localSecurityAddress, netmask: '255.255.255.0', vlan: '0' },
  ]);
  assert.equal(rows.routes[0].destination, addresses.localRtuAddress);
  assert.equal(rows.routes[0].gateway, '192.168.8.219');
  assert.equal(rows.routes[1].gateway, addresses.localGatewayAddress);
  assert.equal(rows.tunnels[0].local_ip, addresses.localSecurityAddress);
  assert.equal(rows.tunnels[0].primary_ip, addresses.remoteSecurityAddress);
  assert.equal(rows.tunnels[0].primary_certificate, 'station.pem');
  assert.equal(rows.tunnels[0].backup_certificate, 'cert2.pem');
  assert.equal(rows.tunnels[0].lifetime, '10000');
  assert.equal(rows.tunnels[0].capacity, '5000000');
  for (const row of rows.policies) {
    assert.equal(row.source_start, addresses.localRtuAddress);
    assert.equal(row.source_end, addresses.localRtuAddress);
    assert.equal(row.destination_start, addresses.remoteRtuAddress);
    assert.equal(row.destination_end, addresses.remoteRtuAddress);
    assert.equal(row.tunnel_id, '1');
  }
  assert.deepEqual(rows.policies.map(row => [row.protocol, row.direction, row.source_port_start, row.source_port_end, row.destination_port_start, row.destination_port_end]), [
    ['1', '1', '1', '1', '1', '1'], ['1', '2', '1', '1', '1', '1'],
    ['2', '1', '2404', '2404', '1024', '65535'], ['2', '2', '2404', '2404', '1024', '65535'],
  ]);
});

test('前置记录只保存业务地址，损坏记录、缺项和新应用失效均不能继续', () => {
  const values = new Map();
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  try {
    assert.equal(getAppliedSecurityNetwork(), null);
    rememberAppliedSecurityNetwork({ ...addresses, sshPassword: 'must-not-persist', sudoPassword: 'must-not-persist' });
    assert.deepEqual(getAppliedSecurityNetwork(), addresses);
    rememberAppliedSecurityNetwork({ ...addresses, localRtuAddress: ' 30.19.80.177 ' });
    assert.deepEqual(getAppliedSecurityNetwork(), addresses);
    assert.doesNotMatch([...values.values()].join(), /Password|must-not-persist/);
    clearAppliedSecurityNetwork();
    assert.equal(getAppliedSecurityNetwork(), null);
    assert.throws(() => rememberAppliedSecurityNetwork({ ...addresses, localRtuAddress: '' }));
    values.set('mskdsp.vertical-security.applied-network.v1', '{broken');
    assert.equal(getAppliedSecurityNetwork(), null);
  } finally { if (original === undefined) delete globalThis.localStorage; else globalThis.localStorage = original; }
  assert.throws(() => buildAutoConfig({ ...addresses, localGatewayAddress: '999.0.0.1' }, 'station.pem'));
  assert.throws(() => buildAutoConfig(addresses, ''));
});

test('上传严格逐页读取最新版本再上传，完成回读才推进下一页', async () => {
  const calls = [], completed = [];
  await uploadAutoConfig('operator-session', plan(), async request => {
    calls.push(request);
    assert.equal(request.session_id, 'operator-session');
    if (request.action === 'save') assert.equal(request.revision, `${request.kind}-latest`);
    return result(request.kind, { revision: `${request.kind}-latest`, rows: request.rows ?? [] });
  }, () => true, kind => completed.push(kind));
  assert.deepEqual(calls.map(request => `${request.kind}:${request.action}`), autoConfigOrder.flatMap(kind => [`${kind}:read`, `${kind}:save`]));
  assert.deepEqual(completed, autoConfigOrder);
});

test('任意页上传拒绝或未完成回读都停止，不调用后续页面', async () => {
  for (const failing of autoConfigOrder) {
    for (const throws of [false, true]) {
      const calls = [];
      await assert.rejects(uploadAutoConfig('operator-session', plan(), async request => {
        calls.push(`${request.kind}:${request.action}`);
        if (request.kind === failing && request.action === 'save') {
          if (throws) throw new Error('装置拒绝');
          return result(failing, { verified: false });
        }
        return result(request.kind);
      }, () => true, () => {}));
      assert.deepEqual(calls, autoConfigOrder.slice(0, autoConfigOrder.indexOf(failing) + 1).flatMap(kind => [`${kind}:read`, `${kind}:save`]));
    }
  }
});

test('读取途中会话失效时不发送上传，也不报告完成', async () => {
  let active = true;
  const calls = [], completed = [];
  await assert.rejects(uploadAutoConfig('operator-session', plan(), async request => {
    calls.push(request.action); active = false; return result(request.kind);
  }, () => active, kind => completed.push(kind)));
  assert.deepEqual(calls, ['read']);
  assert.deepEqual(completed, []);
});
