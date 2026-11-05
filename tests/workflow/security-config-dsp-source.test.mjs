import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as connection from '../../src/utils/vertical-security-auto-config.ts';
import * as execution from '../../src/utils/vertical-security-execution.ts';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const filename = fileURLToPath(new URL('../../src/pages/SecurityConfig/index.tsx', import.meta.url));
const steps = ['precheck', 'forwarding', 'local_security', 'ppp_policy', 'local_rtu', 'ppp0_wait', 'remote_security_route', 'dnat', 'snat', 'conntrack', 'save_config'];
const addresses = { device: 'MskDSP', localRtuAddress: '30.19.80.177', localSecurityAddress: '30.19.80.189', localGatewayAddress: '30.19.80.190', remoteRtuAddress: '30.19.0.1', remoteSecurityAddress: '30.19.0.250', remoteGatewayAddress: '30.19.0.254' };
const snapshot = changes => ({ service_name: 'fixture.service', active_state: 'active', sub_state: 'running', result: 'success', exit_code: 0, restart_count: 0,
  steps: steps.map(step_id => ({ step_id, name: step_id, state: step_id === 'ppp0_wait' ? 'waiting' : 'success', updated_at: 100, message: '' })), ...changes });
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// 执行真实配置页处理器；设备、Form和定时器为边界替身，不启动前端或远端服务。
async function fixture(t, options = {}) {
  const oldStorage = globalThis.localStorage;
  const data = new Map();
  const writes = [];
  globalThis.localStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { writes.push([key, value]); data.set(key, value); },
    removeItem: key => { data.delete(key); },
  };
  connection.clearSecurityDspConnection();
  if (options.target) connection.rememberSecurityDspConnection(options.target);
  const calls = [];
  const notices = [];
  const timers = new Map();
  let timerId = 0;
  const slots = [];
  const effects = new Map();
  let pendingEffects = [];
  let cursor = 0;
  let tree;
  const fields = {};
  let formInitial;
  const form = {
    getFieldValue: key => fields[key],
    setFieldsValue: values => Object.assign(fields, values),
    resetFields: () => { for (const key of Object.keys(fields)) delete fields[key]; Object.assign(fields, formInitial); },
    validateFields: async () => ({ ...fields }),
  };
  const messages = Object.fromEntries(['info', 'success', 'warning', 'error'].map(kind => [kind, value => notices.push([kind, value])]));
  const api = {
    getLowerUpdateCredentials: async account => { calls.push(['credentials', account]); return options.credentials?.(account) ?? null; },
    getVerticalSecurityStatus: async request => { calls.push(['status', request]); return options.status ? options.status(request) : snapshot(); },
    getVerticalSecurityNetwork: async request => {
      calls.push(['network', request]);
      if (options.installed === false) throw new Error('没有已部署脚本');
      return { upload_account: request.upload_account, fingerprint: 'fixture-digest', addresses };
    },
  };
  const react = {
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], value => { slots[id] = typeof value === 'function' ? value(slots[id]) : value; }]; },
    useRef(initial) { const id = cursor++; return slots[id] ??= { current: initial }; },
    useMemo(callback, deps) { const id = cursor++; if (!slots[id] || deps.some((value, index) => value !== slots[id].deps[index])) slots[id] = { deps, value: callback() }; return slots[id].value; },
    useEffect(effect, deps) { const id = cursor++; if (!effects.has(id) || deps.some((value, index) => value !== effects.get(id).deps[index])) pendingEffects.push({ id, deps, effect }); },
  };
  react.default = react;
  const element = (type, props) => ({ type, props: props ?? {} });
  const Form = Object.assign(function Form() {}, { Item: 'FormItem', useForm: () => [form], useWatch: key => fields[key] });
  const widgets = Object.fromEntries(['Alert', 'Button', 'Card', 'Modal', 'Segmented', 'Select', 'Switch', 'Tag'].map(name => [name, name]));
  Object.assign(widgets, { Form, Input: { Password: 'InputPassword' }, Space: 'Space', message: { useMessage: () => [messages, null] } });
  const loaded = new Module(filename);
  loaded.require = name => {
    if (name === '__test_timers') return { setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) };
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' };
    if (name === 'antd') return widgets;
    if (name === '@ant-design/icons') return Object.fromEntries(['CheckCircleFilled', 'ClockCircleOutlined', 'CloseCircleFilled', 'FileTextOutlined', 'LoadingOutlined', 'MinusCircleOutlined', 'PlayCircleOutlined'].map(key => [key, key]));
    if (name === '../../adapters') return { api };
    if (name === '../../utils/vertical-security-auto-config') return connection;
    if (name === '../../utils/vertical-security-execution') return execution;
    if (name === '../../utils/lower-update-connection') return { lowerUpdateCredentialCoordinator: { revision: () => 0 } };
    if (name === '../../utils/vertical-security-script') return {
      isValidIpv4Address: value => typeof value === 'string' && value.split('.').length === 4,
      buildVerticalSecurityScript: () => '# fixture script',
      deployVerticalSecurityScript: async (...args) => { calls.push(['deploy', ...args]); return typeof options.deploy === 'function' ? options.deploy(...args) : options.deploy ?? { success: true, service_name: 'fixture.service', remote_path: '/usr/local/libexec/mskdsp-vertical-security', exit_code: 0 }; },
    };
    if (name.endsWith('.css')) return {};
    return require(name);
  };
  loaded._compile('const {setTimeout, clearTimeout} = require("__test_timers");\n' + ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' ? [node, ...walk(node.props?.children)] : [];
  const nodes = () => walk(tree);
  const formNode = () => nodes().find(node => node.type === Form);
  const render = () => {
    cursor = 0; pendingEffects = []; tree = loaded.exports.default();
    if (!formInitial) { formInitial = { ...formNode().props.initialValues }; Object.assign(fields, formInitial); }
    for (const effect of pendingEffects) { effects.get(effect.id)?.cleanup?.(); effects.set(effect.id, { ...effect, cleanup: effect.effect() }); }
  };
  const settle = async () => { await tick(); render(); await tick(); render(); };
  t.after(() => { for (const effect of effects.values()) effect.cleanup?.(); connection.clearSecurityDspConnection(); globalThis.localStorage = oldStorage; });
  render(); await settle();
  const change = async values => { Object.assign(fields, values); formNode().props.onValuesChange(values); await settle(); };
  const apply = async values => { await change({ ...addresses, sshPassword: 'fixture-ssh', ...values }); await formNode().props.onFinish({ ...fields }); await settle(); };
  return { api, calls, notices, data, writes, timers, fields, nodes, formNode, render, settle, change, apply,
    unmount: () => { for (const effect of effects.values()) effect.cleanup?.(); effects.clear(); },
    poll: async () => { const entry = timers.entries().next().value; assert.ok(entry, '应保留后续状态查询'); timers.delete(entry[0]); await entry[1](); await settle(); },
  };
}

test('脚本已部署但PPP等待时不标全部完成，读取当前DSP静态配置可独立进行且轮询不写业务缓存', async t => {
  const f = await fixture(t);
  await f.apply();
  assert.ok(f.nodes().some(node => node.props.message === '脚本已部署，等待 PPP 地址'));
  assert.equal(f.nodes().some(node => node.props.message === 'DSP 网络配置全部执行完成'), false);
  const request = await connection.resolveSecurityDspConnection(f.api.getLowerUpdateCredentials);
  const network = await f.api.getVerticalSecurityNetwork(request);
  assert.deepEqual(network.addresses, addresses);
  assert.equal(f.calls.find(call => call[0] === 'network')[1].upload_account, f.fields.uploadAccount);
  const writesBeforePoll = f.writes.length;
  await f.poll();
  assert.equal(f.writes.length, writesBeforePoll);
  for (const [key, value] of f.data) {
    assert.equal(key, 'mskdsp.vertical-security.dsp-target.v1');
    assert.equal(value.includes('fixture-ssh'), false);
    assert.equal(value.includes('localRtuAddress'), false);
  }
  assert.equal(f.notices.some(([kind, text]) => kind === 'success' && text === '纵密配置全部步骤执行完成'), false);
});

test('只有部署成功声明而无运行步骤不能显示全部完成，实际缺失脚本读取仍失败', async t => {
  const f = await fixture(t, { installed: false, status: () => snapshot({ steps: [] }) });
  await f.apply();
  assert.ok(f.nodes().some(node => node.props.message === '脚本已部署，正在配置 DSP 业务网络'));
  assert.equal(f.nodes().some(node => node.props.message === 'DSP 网络配置全部执行完成'), false);
  const request = await connection.resolveSecurityDspConnection(f.api.getLowerUpdateCredentials);
  await assert.rejects(f.api.getVerticalSecurityNetwork(request), /没有已部署脚本/);
});

test('部署失败没有成功状态卡或运行轮询', async t => {
  const f = await fixture(t, { deploy: { success: false, stderr: '安装失败', exit_code: 1 } });
  await f.apply();
  assert.equal(f.calls.some(call => call[0] === 'status'), false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.nodes().some(node => node.props.className === 'security-config-deploy-result'), false);
  assert.ok(f.notices.some(([kind, text]) => kind === 'error' && text.includes('安装失败')));
});

test('恢复SSH目标和认证方式而不恢复旧业务地址，换目标不能继承前一目标内存密码', async t => {
  const target = { upload_account: 'operator@192.0.2.20:10022', auth: { method: 'password', password: 'old-target-secret' } };
  const f = await fixture(t, { target });
  assert.equal(f.formNode().props.initialValues.uploadAccount, target.upload_account);
  assert.equal(f.formNode().props.initialValues.authMethod, 'password');
  assert.equal(f.formNode().props.initialValues.localRtuAddress, undefined);
  await f.change({ sshPassword: 'first-target-password' });
  assert.equal((await connection.resolveSecurityDspConnection(f.api.getLowerUpdateCredentials)).auth.password, 'first-target-password');
  await f.change({ uploadAccount: 'operator@192.0.2.30:10022' });
  assert.equal(f.fields.sshPassword, '');
  await assert.rejects(connection.resolveSecurityDspConnection(f.api.getLowerUpdateCredentials), /补齐当前目标的 SSH 认证/);
  await f.change({ sshPassword: 'second-target-password' });
  const request = await connection.resolveSecurityDspConnection(f.api.getLowerUpdateCredentials);
  assert.equal(request.upload_account, 'operator@192.0.2.30:10022');
  assert.equal(request.auth.password, 'second-target-password');
  assert.ok([...f.data.values()].every(value => !value.includes('target-password') && !value.includes('old-target-secret')));
});

test('新PPP成功与旧保存记录仍显示执行中，所有本轮步骤完成后才显示完成并停止轮询', async t => {
  let savedAt = 100;
  const f = await fixture(t, { status: () => snapshot({ steps: steps.map(step_id => ({ step_id, name: step_id, state: 'success', updated_at: step_id === 'save_config' ? savedAt : 200, message: '' })) }) });
  await f.apply();
  assert.ok(f.nodes().some(node => node.props.message === '脚本已部署，正在配置 DSP 业务网络'));
  assert.equal(f.notices.some(([kind, text]) => kind === 'success' && text === '纵密配置全部步骤执行完成'), false);
  savedAt = 200; await f.poll();
  assert.ok(f.nodes().some(node => node.props.message === 'DSP 网络配置全部执行完成'));
  assert.equal(f.timers.size, 0);
  assert.ok(f.notices.some(([kind, text]) => kind === 'success' && text === '纵密配置全部步骤执行完成'));
});

test('等待PPP后状态查询失败保留未知而非全部完成，继续轮询', async t => {
  let fail = false;
  const f = await fixture(t, { status: () => { if (fail) throw new Error('查询失败'); return snapshot(); } });
  await f.apply(); fail = true; await f.poll();
  assert.ok(f.nodes().some(node => node.props.message === '脚本已部署，当前执行状态未确认'));
  assert.equal(f.nodes().some(node => node.props.message === 'DSP 网络配置全部执行完成'), false);
  assert.equal(f.timers.size, 1);
});

test('切换DSP目标会清除旧部署状态和轮询，不把旧设备进度显示给新目标', async t => {
  const f = await fixture(t);
  await f.apply();
  assert.equal(f.timers.size, 1);
  await f.change({ uploadAccount: 'operator@192.0.2.40:10022' });
  assert.equal(f.timers.size, 0);
  assert.equal(f.nodes().some(node => node.props.className === 'security-config-deploy-result'), false);
  assert.equal(connection.getSecurityDspTarget().upload_account, 'operator@192.0.2.40:10022');
});

test('部署未返回时换目标，旧部署迟到成功不能启动旧目标轮询', async t => {
  const pending = deferred();
  const f = await fixture(t, { deploy: () => pending.promise });
  await f.change({ ...addresses, sshPassword: 'fixture-secret' });
  const operation = f.formNode().props.onFinish({ ...f.fields });
  await tick();
  await f.change({ uploadAccount: 'operator@192.0.2.50:10022' });
  pending.resolve({ success: true, service_name: 'old-target.service', remote_path: '/fixture/old' });
  await operation; await f.settle();
  assert.equal(f.calls.some(call => call[0] === 'status'), false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.nodes().some(node => node.props.className === 'security-config-deploy-result'), false);
  assert.equal(f.notices.some(([kind]) => kind === 'success'), false);
});

test('部署未返回时卸载，旧部署成功不发状态查询或成功通知', async t => {
  const pending = deferred();
  const f = await fixture(t, { deploy: () => pending.promise });
  await f.change({ ...addresses, sshPassword: 'fixture-secret' });
  const operation = f.formNode().props.onFinish({ ...f.fields });
  f.unmount();
  pending.resolve({ success: true, service_name: 'old-target.service', remote_path: '/fixture/old' });
  await operation; await tick();
  assert.equal(f.calls.some(call => call[0] === 'status'), false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.notices.some(([kind]) => kind === 'success'), false);
});

test('旧状态查询在换目标后返回全部成功，也不能恢复旧状态或完成通知', async t => {
  const pending = deferred();
  const f = await fixture(t, { status: () => pending.promise });
  await f.apply();
  await f.change({ uploadAccount: 'operator@192.0.2.60:10022' });
  pending.resolve(snapshot({ steps: steps.map(step_id => ({ step_id, name: step_id, state: 'success', updated_at: 200, message: '' })) }));
  await f.settle();
  assert.equal(f.timers.size, 0);
  assert.equal(f.nodes().some(node => node.props.className === 'security-config-deploy-result'), false);
  assert.equal(f.notices.some(([kind, text]) => kind === 'success' && text === '纵密配置全部步骤执行完成'), false);
});
