import assert from 'node:assert/strict';
import test from 'node:test';
import { autoConfigOrder, buildAutoConfig, clearSecurityDspConnection, getSecurityDspTarget, rememberSecurityDspConnection, resolveSecurityDspConnection, uploadAutoConfig } from '../../src/utils/vertical-security-auto-config.ts';

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

function connectionStorage() {
  const values = new Map();
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  clearSecurityDspConnection();
  return { values, restore: () => { clearSecurityDspConnection(); if (original === undefined) delete globalThis.localStorage; else globalThis.localStorage = original; } };
}
const targetA = 'fixture@192.0.2.1:10022';
const targetB = 'fixture@192.0.2.2:10022';
test('连接只持久化目标和认证方式，密码仅在当前进程内存且优先于系统凭据', async () => {
  const storage = connectionStorage();
  try {
    rememberSecurityDspConnection({ upload_account: targetA, auth: { method: 'password', password: 'manual-secret' } });
    assert.deepEqual(getSecurityDspTarget(), { upload_account: targetA, auth_method: 'password' });
    assert.doesNotMatch([...storage.values.values()].join(), /manual-secret|localRtuAddress|ssh_password/);
    const request = await resolveSecurityDspConnection(async () => { throw new Error('不应读取系统凭据'); });
    assert.deepEqual(request, { upload_account: targetA, auth: { method: 'password', password: 'manual-secret' } });
  } finally { storage.restore(); }
});

test('切换DSP或认证方式清除旧密码，仅取精确目标的系统凭据', async () => {
  const storage = connectionStorage();
  try {
    rememberSecurityDspConnection({ upload_account: targetA, auth: { method: 'password', password: 'secret-A' } });
    rememberSecurityDspConnection({ upload_account: targetB, auth: { method: 'password', password: '' } });
    const queried = [];
    const request = await resolveSecurityDspConnection(async account => { queried.push(account); return { ssh_password: 'saved-B', sudo_password: null }; });
    assert.deepEqual(queried, [targetB]);
    assert.equal(request.auth.password, 'saved-B');
    rememberSecurityDspConnection({ upload_account: targetB, auth: { method: 'certificate' } });
    assert.deepEqual(await resolveSecurityDspConnection(async () => { throw new Error('证书认证不读取密码'); }), { upload_account: targetB, auth: { method: 'certificate' } });
    rememberSecurityDspConnection({ upload_account: targetB, auth: { method: 'password', password: '' } });
    await assert.rejects(resolveSecurityDspConnection(async () => null), /补齐当前目标/);
  } finally { storage.restore(); }
});

test('旧地址缓存、损坏目标、缺少密码均不允许恢复旧设备', async () => {
  const storage = connectionStorage();
  try {
    storage.values.set('mskdsp.vertical-security.applied-network.v1', JSON.stringify({ version: 1, addresses }));
    assert.equal(getSecurityDspTarget(), null);
    await assert.rejects(resolveSecurityDspConnection(async () => ({ ssh_password: 'old', sudo_password: null })), /先在“DSP 网络配置”/);
    rememberSecurityDspConnection({ upload_account: targetA, auth: { method: 'password', password: '' } });
    await assert.rejects(resolveSecurityDspConnection(async () => null), /补齐当前目标/);
    storage.values.set('mskdsp.vertical-security.dsp-target.v1', '{broken');
    assert.equal(getSecurityDspTarget(), null);
    assert.throws(() => buildAutoConfig({ ...addresses, localGatewayAddress: '999.0.0.1' }, 'station.pem'));
    assert.throws(() => buildAutoConfig(addresses, ''));
  } finally { storage.restore(); }
});

test('异步读取系统凭据期间切换DSP时拒绝迟到密码', async () => {
  const storage = connectionStorage();
  try {
    rememberSecurityDspConnection({ upload_account: targetA, auth: { method: 'password', password: '' } });
    let finish;
    const resolving = resolveSecurityDspConnection(() => new Promise(resolve => { finish = resolve; }));
    rememberSecurityDspConnection({ upload_account: targetB, auth: { method: 'password', password: '' } });
    finish({ ssh_password: 'old-A', sudo_password: null });
    await assert.rejects(resolving, /目标已变化/);
  } finally { storage.restore(); }
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


test('SSH端口前导零规范为与后台相同的目标，不误判为其他DSP', async () => {
  const storage = connectionStorage();
  try {
    rememberSecurityDspConnection({ upload_account: 'fixture@192.0.2.1:010022', auth: { method: 'password', password: 'manual-secret' } });
    assert.deepEqual(getSecurityDspTarget(), { upload_account: targetA, auth_method: 'password' });
    assert.deepEqual(await resolveSecurityDspConnection(async () => { throw new Error('规范后应保留当前目标手工认证'); }), { upload_account: targetA, auth: { method: 'password', password: 'manual-secret' } });
    rememberSecurityDspConnection({ upload_account: targetA, auth: { method: 'certificate' } });
    assert.deepEqual(await resolveSecurityDspConnection(async () => null), { upload_account: targetA, auth: { method: 'certificate' } });
  } finally { storage.restore(); }
});
