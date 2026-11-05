import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as loginState from '../../src/pages/SecurityAccess/login-state.ts';
import * as lockState from '../../src/pages/SecurityAccess/login-lockout.ts';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const filename = fileURLToPath(new URL('../../src/pages/SecurityAccess/SecurityLogin.tsx', import.meta.url));
const auth = (request, changes = {}) => ({
  ...request, state: 'authenticated', code: 'fixture', message: '认证完成',
  target_ip: '11.22.33.44', device_id: request.mode === 'remote' ? request.device_id : null,
  session_id: request.role === 1 ? 'admin-session' : 'secure-session', challenge_id: null,
  username: request.role === 1 ? 'admin' : 'secure', lock_seconds: null, device_version: 'fixture',
  steps: loginState.LOGIN_STAGES.map(stage => ({ ...stage, state: 'success', message: '' })), ...changes,
});
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const environments = new WeakSet();

// 执行真实页面处理器，只替换渲染、共享会话及设备边界；不连接真实设备。
async function fixture(t, options = {}) {
  if (!environments.has(t)) {
    environments.add(t);
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = { setInterval: () => 1, clearInterval() {} };
    globalThis.document = { addEventListener() {}, removeEventListener() {} };
    t.after(() => { globalThis.window = previousWindow; globalThis.document = previousDocument; });
  }
  const fixtureWindow = globalThis.window;
  const fixtureDocument = globalThis.document;
  const slots = [];
  const effects = new Map();
  let cursor = 0;
  let pendingEffects = [];
  let retained = auth({ request_id: 'retained', mode: 'direct', role: options.role ?? 2 });
  const listeners = new Set();
  const calls = [];
  const api = {
    getVerticalSecurityLoginCapabilities: async () => ({ direct_available: true, remote_available: true }),
    getVerticalSecurityCertificateProfile: async () => ({ configured: true, source: 'builtin' }),
    getVerticalSecurityLoginLocks: async () => options.locks ?? [],
    logoutVerticalSecurity: async id => { calls.push(['logout', id]); await options.logout?.(id); },
    loginVerticalSecurityOneClick: async request => { calls.push(['login', request]); return options.login ? options.login(request) : auth(request); },
    cancelVerticalSecurityLogin: async id => { calls.push(['cancel', id]); },
    runVerticalSecurityAdmin: async request => {
      calls.push(['admin', request]);
      return options.reboot ? options.reboot(request) : { message: '重启命令已发送，等待设备恢复后核实。', status: 'reboot_requested' };
    },
  };
  const session = {
    getRetainedLogin: () => retained,
    checkRetainedLogin: async () => retained,
    subscribeRetainedLoginInvalidation: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    clearRetainedLogin: (id, invalidated = false) => {
      if (retained?.session_id !== id) return;
      retained = null;
      for (const listener of listeners) listener(id, invalidated);
    },
    retainLogin: value => { retained = value; },
  };
  const react = {
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], value => { slots[id] = typeof value === 'function' ? value(slots[id]) : value; }]; },
    useRef(initial) { const id = cursor++; return slots[id] ??= { current: initial }; },
    useEffect(effect, deps) {
      const id = cursor++;
      if (!effects.has(id) || deps.some((value, index) => value !== effects.get(id).deps[index])) pendingEffects.push({ id, effect, deps });
    },
  };
  const element = (type, props) => ({ type, props: props ?? {} });
  const widgets = Object.fromEntries(['Alert', 'Badge', 'Button', 'Card', 'Input', 'Select', 'Space', 'Tag'].map(name => [name, name]));
  widgets.Form = Object.assign('Form', { Item: 'FormItem' });
  widgets.Input = Object.assign('Input', { Password: 'InputPassword' });
  widgets.Space = Object.assign('Space', { Compact: 'SpaceCompact' });
  widgets.Typography = { Text: 'TypographyText' };
  const loaded = new Module(filename);
  loaded.require = name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' };
    if (name === 'antd') return widgets;
    if (name === '@ant-design/icons') return { FileOutlined: 'FileIcon', LoginOutlined: 'LoginIcon', LogoutOutlined: 'LogoutIcon' };
    if (name === '../../adapters') return { api };
    if (name === './login-state') return loginState;
    if (name === './login-lockout') return lockState;
    if (name === './login-session') return session;
    if (name === './access-state') return { reportLoginConnectionFailure() {} };
    if (name === './SecurityOperator') return { default: 'SecurityOperator' };
    if (name === './SecurityAdmin') return { default: 'SecurityAdmin' };
    return require(name);
  };
  loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  let tree;
  let props = { mode: 'direct', accessBusy: false, onLockChange() {} };
  const render = changes => {
    props = { ...props, ...changes }; cursor = 0; pendingEffects = [];
    tree = loaded.exports.default(props);
    for (const item of pendingEffects) { effects.get(item.id)?.cleanup?.(); effects.set(item.id, { ...item, cleanup: item.effect() }); }
    return tree;
  };
  const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' ? [node, ...walk(node.props?.children), ...walk(node.props?.extra)] : [];
  const nodes = () => walk(tree);
  const find = type => nodes().find(node => node.type === type);
  const settle = async () => { await new Promise(setImmediate); render(); };
  t.after(() => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = fixtureWindow; globalThis.document = fixtureDocument;
    try { for (const effect of effects.values()) effect.cleanup?.(); }
    finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
  });
  render(); await settle();
  return { calls, render, nodes, find, settle, auth, session, retained: () => retained,
    unmount: () => { for (const effect of effects.values()) effect.cleanup?.(); effects.clear(); },
  };
}

test('四页完成回调前不切号；完成后依次退出操作员、认证管理员、发送一次重启并清理会话', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.calls, []);
  const complete = f.find('SecurityOperator').props.onAutoConfigured;
  await Promise.all([complete(), complete()]);
  f.render();
  assert.deepEqual(f.calls.map(call => call[0]), ['logout', 'login', 'admin', 'logout']);
  assert.equal(f.calls[0][1], 'secure-session');
  assert.equal(f.calls[1][1].role, 1);
  assert.deepEqual(f.calls[2][1], { session_id: 'admin-session', action: 'reboot_device' });
  assert.equal(f.retained(), null);
  assert.equal(f.find('SecurityAdmin'), undefined);
  assert.ok(f.nodes().some(node => node.props.title === '重启命令已发送，等待设备恢复后核实。'));
});

test('退出操作员失败保留原身份，不登录管理员或发送重启', async t => {
  const f = await fixture(t, { logout: () => { throw new Error('退出被拒绝'); } });
  await f.find('SecurityOperator').props.onAutoConfigured(); f.render();
  assert.deepEqual(f.calls, [['logout', 'secure-session']]);
  assert.equal(f.retained().session_id, 'secure-session');
  assert.ok(f.nodes().some(node => node.props.title === '退出被拒绝'));
});

test('管理员已有锁定等待时不尝试认证，不发送重启', async t => {
  const f = await fixture(t, { locks: [{ mode: 'direct', device_id: null, username: 'admin', lock_seconds: 90 }] });
  await f.find('SecurityOperator').props.onAutoConfigured(); f.render();
  assert.deepEqual(f.calls, [['logout', 'secure-session']]);
  assert.ok(f.nodes().some(node => String(node.props.title).includes('管理员账号仍在锁定')));
});

test('管理员身份、目标或初始化不匹配均不重启，拒绝带出错误会话', async t => {
  for (const changes of [{ role: 2, username: 'secure' }, { target_ip: '192.0.2.9' }, { steps: [] }]) {
    const f = await fixture(t, { login: request => auth(request, changes) });
    await f.find('SecurityOperator').props.onAutoConfigured(); f.render();
    assert.equal(f.calls.some(call => call[0] === 'admin'), false);
    assert.equal(f.retained(), null);
    assert.ok(f.calls.some(call => call[0] === 'logout' && call[1] === 'admin-session'));
    f.unmount();
  }
});

test('管理员认证失败、未知应答或锁定应答均不重启且不自动重试', async t => {
  for (const changes of [
    { state: 'failed', code: 'credentials_rejected', session_id: null },
    { state: 'unverified_response', session_id: null },
    { state: 'failed', code: 'account_locked', lock_seconds: 60, session_id: null },
  ]) {
    const f = await fixture(t, { login: request => auth(request, changes) });
    await f.find('SecurityOperator').props.onAutoConfigured(); await f.settle();
    assert.equal(f.calls.filter(call => call[0] === 'login').length, 1);
    assert.equal(f.calls.some(call => call[0] === 'admin'), false);
    f.unmount();
  }
});

test('切号认证中取消登录，迟到管理员认证仅清理不发送重启', async t => {
  const pending = deferred(); let request;
  const f = await fixture(t, { login: value => { request = value; return pending.promise; } });
  const operation = f.find('SecurityOperator').props.onAutoConfigured();
  await f.settle();
  const cancel = f.nodes().find(node => node.type === 'Button' && node.props.children === '取消登录');
  assert.ok(cancel);
  await cancel.props.onClick();
  pending.resolve(auth(request)); await operation; await f.settle();
  assert.equal(f.calls.filter(call => call[0] === 'cancel').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'admin'), false);
  assert.ok(f.calls.some(call => call[0] === 'logout' && call[1] === 'admin-session'));
});

test('管理员认证网络异常停止重启，不自动重试认证', async t => {
  const f = await fixture(t, { login: () => { throw new Error('认证连接异常'); } });
  await f.find('SecurityOperator').props.onAutoConfigured(); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === 'login').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'admin'), false);
  assert.ok(f.nodes().some(node => String(node.props.title).includes('管理员登录失败')));
});

test('管理员认证完成并发送重启后不再提供取消登录，等待期间禁止重复回调', async t => {
  const pending = deferred();
  const f = await fixture(t, { reboot: () => pending.promise });
  const complete = f.find('SecurityOperator').props.onAutoConfigured;
  const operation = complete(); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === 'admin').length, 1);
  assert.equal(f.nodes().some(node => node.type === 'Button' && node.props.children === '取消登录'), false);
  await complete();
  assert.equal(f.calls.filter(call => call[0] === 'admin').length, 1);
  pending.resolve({ message: '命令已发送，恢复后核实。', status: 'reboot_requested' });
  await operation;
});

test('切号等待退出时卸载页面，不启动管理员认证', async t => {
  const pending = deferred();
  const f = await fixture(t, { logout: id => id === 'secure-session' ? pending.promise : undefined });
  const operation = f.find('SecurityOperator').props.onAutoConfigured();
  f.unmount(); pending.resolve(); await operation;
  assert.deepEqual(f.calls, [['logout', 'secure-session']]);
});

test('管理员手动重启处理器防重复，失败后清理会话且不自动重试', async t => {
  const pending = deferred();
  const f = await fixture(t, { role: 1, reboot: () => pending.promise });
  const restart = f.find('SecurityAdmin').props.onRebootDevice;
  const operation = restart(); await restart();
  assert.deepEqual(f.calls, [['admin', { session_id: 'admin-session', action: 'reboot_device' }]]);
  pending.reject(new Error('发送结果未确认')); await operation; await f.settle();
  assert.equal(f.calls.filter(call => call[0] === 'admin').length, 1);
  assert.equal(f.retained(), null);
  assert.ok(f.nodes().some(node => node.props.title === '发送结果未确认'));
});
