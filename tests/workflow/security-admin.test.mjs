import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const filename = fileURLToPath(new URL('../../src/pages/SecurityAccess/SecurityAdmin.tsx', import.meta.url));

// 在内存中运行真实事件处理器；只替换渲染器和设备边界，不使用真实装置。
function fixture(overrides = {}) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let props = { sessionId: 'session-a', disabled: false };
  const calls = [];
  const api = {
    runVerticalSecurityAdmin: async request => { calls.push(request); return { message: '装置操作成功', status: 'initialized', certificates: [{ name: 'master.cer', certificate_type: 5 }], data: [65, 66] }; },
    getVerticalSecuritySimIp: async () => '192.0.2.10',
    chooseVerticalSecurityCertificateFile: async () => ({ name: 'chosen.cer', data: [65] }),
    saveVerticalSecurityFile: async value => { calls.push({ save: value }); return value.name; },
    ...overrides,
  };
  const react = {
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], value => { slots[id] = typeof value === 'function' ? value(slots[id]) : value; }]; },
    useRef(initial) { const id = cursor++; return slots[id] ??= { current: initial }; },
    useEffect(effect, deps) { const id = cursor++; if (!slots[id] || deps.some((v, i) => v !== slots[id].deps[i])) { slots[id]?.cleanup?.(); slots[id] = { deps, cleanup: effect() }; effects.push(id); } },
  };
  const element = (type, p) => ({ type, props: p ?? {} });
  const widgets = Object.fromEntries(['Alert', 'Button', 'Card', 'Select', 'Space', 'Table', 'Tag', 'Popconfirm'].map(name => [name, name]));
  widgets.Input = { TextArea: 'TextArea' };
  const loaded = new Module(filename);
  loaded.require = name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx: element, jsxs: element, Fragment: 'Fragment' } : name === 'antd' ? widgets : name === '../../adapters' ? { api } : name.endsWith('.css') ? {} : require(name);
  loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  let tree;
  const render = next => { props = { ...props, ...next }; cursor = 0; tree = loaded.exports.default(props); return tree; };
  const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' ? [node, ...walk(node.props?.children), ...walk(node.props?.extra)] : [];
  const nodes = (node = tree) => walk(node);
  const button = label => nodes().find(node => node.type === 'Button' && node.props.children === label);
  render();
  return { api, calls, render, nodes, button, unmount: () => effects.forEach(id => slots[id]?.cleanup?.()) };
}

test('管理员工作台进入时不自动初始化装置，状态仅来自装置应答', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  await f.button('查询初始化状态').props.onClick();
  f.render();
  assert.deepEqual(f.calls[0], { session_id: 'session-a', action: 'status' });
  assert.ok(f.nodes().some(node => node.props.children === '已初始化'));
});

test('导出 CSR 不生成密钥，采用 SIM IP 文件名，无法读取时提示并使用 SM2.csr', async () => {
  for (const ip of ['192.0.2.10', null, '0.0.0.0', '127.0.0.1', '169.254.1.1']) {
    const f = fixture({ getVerticalSecuritySimIp: async () => ip });
    await f.button('导出 SM2 CSR').props.onClick();
    assert.deepEqual(f.calls[0], { session_id: 'session-a', action: 'export_csr' });
    assert.deepEqual(f.calls[1], { save: { name: ip === '192.0.2.10' ? '192.0.2.10_SM2.csr' : 'SM2.csr', data: [65, 66] } });
    assert.ok(!f.calls.some(call => call.action === 'generate_sm2'));
    if (ip !== '192.0.2.10') { f.render(); assert.ok(f.nodes().some(node => String(node.props.title).includes('SIM IP'))); }
  }
});

test('主站导入默认加密网关类别，取消选文件不发送设备请求', async () => {
  const f = fixture();
  await f.button('导入主站证书').props.onClick();
  assert.deepEqual(f.calls[0], { session_id: 'session-a', action: 'import_certificate', certificate_type: 5, name: 'chosen.cer', data: [65] });
  const cancelled = fixture({ chooseVerticalSecurityCertificateFile: async () => null });
  await cancelled.button('导入主站证书').props.onClick();
  assert.equal(cancelled.calls.length, 0);
});

test('忙时拒绝重复操作，卸载后不保存迟到 CSR', async () => {
  let resolve;
  const f = fixture({ runVerticalSecurityAdmin: request => { f.calls.push(request); return new Promise(done => { resolve = done; }); } });
  const first = f.button('导出 SM2 CSR').props.onClick();
  await f.button('导出 SM2 CSR').props.onClick();
  assert.equal(f.calls.length, 1);
  f.unmount();
  resolve({ message: '迟到', status: null, certificates: [], data: [1] });
  await first;
  assert.equal(f.calls.length, 1);
});

test('退出中禁用操作，设备失败保持为错误', async () => {
  const f = fixture({ runVerticalSecurityAdmin: async () => { throw new Error('装置拒绝该操作'); } });
  f.render({ disabled: true });
  await f.button('查询初始化状态').props.onClick();
  assert.equal(f.calls.length, 0);
  f.render({ disabled: false });
  await f.button('查询初始化状态').props.onClick();
  f.render();
  assert.ok(f.nodes().some(node => node.type === 'Alert' && node.props.type === 'error' && node.props.title === '装置拒绝该操作'));
});

test('证书请求保留装置名称，导出保存仅用basename，删除须确认', async () => {
  const f = fixture();
  const certificate = { name: 'cert_files/设备 sm2.cer', certificate_type: 5 };
  const table = f.nodes().find(node => node.type === 'Table');
  const rowActions = f.nodes(table.props.columns[2].render(null, certificate));
  await rowActions.find(node => node.type === 'Button' && node.props.children === '导出').props.onClick();
  assert.deepEqual(f.calls[0], { session_id: 'session-a', action: 'read_certificate', ...certificate });
  assert.deepEqual(f.calls[1], { save: { name: '设备 sm2.cer', data: [65, 66] } });
  assert.ok(!f.calls.some(call => call.action === 'delete_certificate'));
  await rowActions.find(node => node.type === 'Popconfirm').props.onConfirm();
  assert.deepEqual(f.calls[2], { session_id: 'session-a', action: 'delete_certificate', ...certificate });
});

test('取消保存不报已导出，切换会话后不接收旧状态', async () => {
  const cancelled = fixture({ saveVerticalSecurityFile: async () => null });
  await cancelled.button('导出 SM2 CSR').props.onClick();
  cancelled.render();
  assert.ok(cancelled.nodes().some(node => node.props.title === '已取消保存 CSR。'));
  let resolve;
  const f = fixture({ runVerticalSecurityAdmin: () => new Promise(done => { resolve = done; }) });
  const task = f.button('查询初始化状态').props.onClick();
  f.render({ sessionId: 'session-b' });
  resolve({ message: '旧会话', status: '已初始化', certificates: [], data: null });
  await task;
  f.render();
  assert.ok(!f.nodes().some(node => node.props.children === '已初始化' || node.props.title === '旧会话'));
});

test('Tauri字符串拒绝保留装置详细原因', async () => {
  const detail = '请插入系统密钥卡后重试。';
  const f = fixture({ runVerticalSecurityAdmin: async () => { throw detail; } });
  await f.button('查询初始化状态').props.onClick();
  f.render();
  assert.ok(f.nodes().some(node => node.type === 'Alert' && node.props.type === 'error' && node.props.title === detail));
});
