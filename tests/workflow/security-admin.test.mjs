import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const filename = fileURLToPath(new URL('../../src/pages/SecurityAccess/SecurityAdmin.tsx', import.meta.url));

// 在内存中运行真实事件处理器；只替换渲染器和设备边界，不使用真实装置。
function fixture(overrides = {}, options = {}) {
  const slots = [];
  const effects = new Set();
  let cursor = 0;
  let props = { sessionId: 'session-a', disabled: false, ...options.props };
  let initialSetup = Boolean(options.initialSetup);
  const calls = [];
  const api = {
    runVerticalSecurityAdmin: async request => { calls.push(request); return { message: '装置操作成功', status: 'initialized', certificates: [{ name: 'master.cer', certificate_type: 5 }], tunnels: [], data: [65, 66] }; },
    getVerticalSecuritySimIp: async () => '192.0.2.10',
    chooseVerticalSecurityCertificateFile: async () => ({ name: 'chosen.cer', data: [65] }),
    saveVerticalSecurityFile: async value => { calls.push({ save: value }); return value.name; },
    ...overrides,
  };
  const implementation = api.runVerticalSecurityAdmin;
  api.runVerticalSecurityAdmin = request => {
    if (initialSetup && request.action === 'list_certificates') {
      calls.push(request);
      return Promise.resolve({ certificates: [{ name: 'initial.cer', certificate_type: 5 }], tunnels: [], data: null, message: '初刷成功' });
    }
    return implementation(request);
  };
  const react = {
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], value => { slots[id] = typeof value === 'function' ? value(slots[id]) : value; }]; },
    useRef(initial) { const id = cursor++; return slots[id] ??= { current: initial }; },
    useEffectEvent(callback) { const id = cursor++; if (!slots[id]) slots[id] = { callback, event: (...args) => slots[id].callback(...args) }; slots[id].callback = callback; return slots[id].event; },
    useEffect(effect, deps) { const id = cursor++; if (!slots[id] || deps.some((v, i) => v !== slots[id].deps[i])) { slots[id]?.cleanup?.(); slots[id] = { deps, effect, cleanup: effect() }; effects.add(id); } },
  };
  const element = (type, p) => ({ type, props: p ?? {} });
  const widgets = Object.fromEntries(['Alert', 'Button', 'Card', 'Select', 'Space', 'Table', 'Tag', 'Popconfirm', 'Tabs', 'Modal', 'Segmented', 'Empty'].map(name => [name, name]));
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
  const settle = async () => { await new Promise(setImmediate); render(); };
  return { api, calls, render, nodes, button, settle, finishSetup: () => { initialSetup = false; }, strictReplay: () => { effects.forEach(id => slots[id]?.cleanup?.()); effects.forEach(id => { slots[id].cleanup = slots[id].effect(); }); render(); }, unmount: () => effects.forEach(id => slots[id]?.cleanup?.()) };
}

// 每个原有业务用例先明确验证并完成新的初刷，再清空计数，保留各操作的精确断言。
async function settledFixture(overrides = {}) {
  const f = fixture(overrides, { initialSetup: true });
  await f.settle();
  assert.deepEqual(f.calls, [{ session_id: 'session-a', action: 'list_certificates' }]);
  assert.equal(f.nodes().find(node => node.type === 'Table').props.dataSource[0].name, 'initial.cer');
  f.finishSetup(); f.calls.length = 0;
  return f;
}

test('进入工作台仅自动读取一次证书，普通重渲染不重复且无查询或单独生成入口', async () => {
  const f = fixture();
  await f.settle();
  assert.deepEqual(f.calls, [{ session_id: 'session-a', action: 'list_certificates' }]);
  f.render(); await f.settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.button('查询初始化状态'), undefined);
  assert.equal(f.button('生成 SM2 密钥'), undefined);
  assert.ok(f.button('导出 SM2 CSR'));
});

test('StrictMode首轮取消微任务，重放只初刷一次', async () => {
  const f = fixture();
  f.strictReplay(); await f.settle();
  assert.deepEqual(f.calls, [{ session_id: 'session-a', action: 'list_certificates' }]);
});

test('初始禁用等待解禁，之后disabled及回调变化不重复初刷', async () => {
  const f = fixture({}, { props: { disabled: true, onBusyChange: () => {} } });
  await f.settle(); assert.equal(f.calls.length, 0);
  f.render({ disabled: false }); await f.settle();
  assert.deepEqual(f.calls, [{ session_id: 'session-a', action: 'list_certificates' }]);
  f.render({ disabled: true, onBusyChange: () => {} }); await f.settle();
  f.render({ disabled: false }); await f.settle();
  assert.equal(f.calls.length, 1);
});

test('初刷失败展示原因且不自动重试，手动刷新恢复', async () => {
  let fail = true;
  const f = fixture({ runVerticalSecurityAdmin: async request => { f.calls.push(request); if (fail) throw '证书读取失败'; return { certificates: [{ name: 'recovered.cer', certificate_type: 5 }] }; } });
  await f.settle();
  assert.ok(f.nodes().some(node => node.props.title === '证书读取失败'));
  f.render(); await f.settle(); assert.equal(f.calls.length, 1);
  fail = false; await f.button('刷新证书列表').props.onClick(); f.render();
  assert.equal(f.calls.length, 2);
  assert.equal(f.nodes().find(node => node.type === 'Table').props.dataSource[0].name, 'recovered.cer');
});

test('初刷忙时禁止其他操作，会话改变与卸载丢弃旧列表', async () => {
  const pending = [];
  const f = fixture({ runVerticalSecurityAdmin: request => { f.calls.push(request); return new Promise(resolve => pending.push(resolve)); } });
  await f.settle();
  assert.equal(f.button('导出 SM2 CSR').props.disabled, true);
  await f.button('导出 SM2 CSR').props.onClick();
  assert.equal(f.calls.length, 1);
  f.render({ sessionId: 'session-b' }); await f.settle();
  assert.deepEqual(f.calls, [{ session_id: 'session-a', action: 'list_certificates' }, { session_id: 'session-b', action: 'list_certificates' }]);
  pending[0]({ certificates: [{ name: 'old.cer', certificate_type: 5 }] }); await f.settle();
  assert.equal(f.nodes().find(node => node.type === 'Table').props.dataSource.length, 0);
  f.unmount(); pending[1]({ certificates: [{ name: 'late.cer', certificate_type: 5 }] }); await f.settle();
  assert.equal(f.nodes().find(node => node.type === 'Table').props.dataSource.length, 0);
  assert.equal(f.calls.length, 2);
});

test('导出 CSR 通过单个后端操作完成密钥准备并采用 SIM IP 命名与无IP回退', async () => {
  for (const ip of ['192.0.2.10', null, '0.0.0.0', '127.0.0.1', '169.254.1.1']) {
    const f = await settledFixture({ getVerticalSecuritySimIp: async () => ip });
    await f.button('导出 SM2 CSR').props.onClick();
    assert.deepEqual(f.calls[0], { session_id: 'session-a', action: 'export_csr' });
    assert.deepEqual(f.calls[1], { save: { name: ip === '192.0.2.10' ? '192.0.2.10_SM2.csr' : 'SM2.csr', data: [65, 66] } });
    assert.ok(!f.calls.some(call => call.action === 'generate_sm2'));
    if (ip !== '192.0.2.10') { f.render(); assert.ok(f.nodes().some(node => String(node.props.title).includes('SIM IP'))); }
  }
});

test('主站导入默认加密网关类别，取消选文件不发送设备请求', async () => {
  const f = await settledFixture();
  f.button('导入证书').props.onClick(); f.render();
  await f.nodes().find(node => node.type === 'Modal').props.onOk();
  assert.deepEqual(f.calls[0], { session_id: 'session-a', action: 'import_certificate', certificate_type: 5, name: 'chosen.cer', data: [65] });
  const cancelled = await settledFixture({ chooseVerticalSecurityCertificateFile: async () => null });
  cancelled.button('导入证书').props.onClick(); cancelled.render();
  await cancelled.nodes().find(node => node.type === 'Modal').props.onOk();
  assert.equal(cancelled.calls.length, 0);
});

test('忙时拒绝重复操作，卸载后不保存迟到 CSR', async () => {
  let resolve;
  const f = await settledFixture({ runVerticalSecurityAdmin: request => { f.calls.push(request); return new Promise(done => { resolve = done; }); } });
  const first = f.button('导出 SM2 CSR').props.onClick();
  await f.button('导出 SM2 CSR').props.onClick();
  assert.equal(f.calls.length, 1);
  f.unmount();
  resolve({ message: '迟到', status: null, certificates: [], data: [1] });
  await first;
  assert.equal(f.calls.length, 1);
});

test('退出中禁用操作，设备失败保持为错误', async () => {
  const f = await settledFixture({ runVerticalSecurityAdmin: async () => { throw new Error('装置拒绝该操作'); } });
  f.render({ disabled: true });
  await f.button('导出 SM2 CSR').props.onClick();
  assert.equal(f.calls.length, 0);
  f.render({ disabled: false });
  await f.button('导出 SM2 CSR').props.onClick();
  f.render();
  assert.ok(f.nodes().some(node => node.type === 'Alert' && node.props.type === 'error' && node.props.title === '装置拒绝该操作'));
});

test('证书请求保留装置名称，导出保存仅用basename，删除须确认', async () => {
  const f = await settledFixture();
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

test('取消保存不报已导出，切换会话后不保存旧 CSR', async () => {
  const cancelled = await settledFixture({ saveVerticalSecurityFile: async () => null });
  await cancelled.button('导出 SM2 CSR').props.onClick();
  cancelled.render();
  assert.ok(cancelled.nodes().some(node => node.props.title === '已取消保存 CSR。'));
  let resolve;
  const f = await settledFixture({ runVerticalSecurityAdmin: () => new Promise(done => { resolve = done; }) });
  const task = f.button('导出 SM2 CSR').props.onClick();
  f.render({ sessionId: 'session-b' });
  resolve({ message: '旧会话', status: null, certificates: [], data: [7] });
  await task;
  f.render();
  assert.equal(f.calls.some(call => call.save), false);
  assert.ok(!f.nodes().some(node => node.props.title === 'CSR 已保存。' || node.props.title === '旧会话'));
});

test('Tauri字符串拒绝保留装置详细原因', async () => {
  const detail = '请插入系统密钥卡后重试。';
  const f = await settledFixture({ runVerticalSecurityAdmin: async () => { throw detail; } });
  await f.button('导出 SM2 CSR').props.onClick();
  f.render();
  assert.ok(f.nodes().some(node => node.type === 'Alert' && node.props.type === 'error' && node.props.title === detail));
});


const tunnel = { id: 7, state: 3, hot_state: 1, local_ip: '192.0.2.1', peer_ip: '192.0.2.2', encrypt_count: '9007199254740993', decrypt_count: '2', encrypt_errors: '0', decrypt_errors: '0', error_info: null, algorithm: 'SM4' };
function switchPage(f, page) { f.nodes().find(node => node.type === 'Tabs').props.onChange(page); f.render(); }

test('管理员分页隔离功能，进入隧道页不自动查询，刷新与图示共享同一数据', async () => {
  const f = await settledFixture({ runVerticalSecurityAdmin: async request => { f.calls.push(request); return { message: '已读取', certificates: [], tunnels: [tunnel] }; } });
  switchPage(f, 'tunnels');
  assert.equal(f.button('导出 SM2 CSR'), undefined);
  assert.equal(f.calls.length, 0);
  await f.button('刷新隧道').props.onClick(); f.render();
  assert.deepEqual(f.calls, [{ session_id: 'session-a', action: 'list_tunnels' }]);
  const table = f.nodes().find(node => node.type === 'Table');
  assert.equal(table.props.dataSource[0].encrypt_count, '9007199254740993');
  f.nodes().find(node => node.type === 'Segmented').props.onChange('diagram'); f.render();
  assert.ok(f.nodes().some(node => node.props['aria-label'] === '隧道 7 图示'));
  assert.equal(f.calls.length, 1);
});

test('单隧道重置须选择与确认，仅声明受理，不自动重试或刷新', async () => {
  const f = await settledFixture({ runVerticalSecurityAdmin: async request => { f.calls.push(request); return { message: '命令已受理，请刷新核对隧道状态。', certificates: [], tunnels: [tunnel] }; } });
  switchPage(f, 'tunnels');
  assert.equal(f.button('重置选中隧道').props.disabled, true);
  await f.button('刷新隧道').props.onClick(); f.render();
  f.nodes().find(node => node.type === 'Table').props.rowSelection.onChange([7]); f.render();
  assert.equal(f.calls.length, 1);
  await f.nodes().find(node => node.type === 'Popconfirm').props.onConfirm(); f.render();
  assert.deepEqual(f.calls[1], { session_id: 'session-a', action: 'reset_tunnel', tunnel_id: 7 });
  assert.equal(f.calls.length, 2);
  assert.ok(f.nodes().some(node => String(node.props.title).includes('命令已受理')));
});

test('隧道空列表、失败及旧快照清楚区分，切换会话丢弃迟到结果', async () => {
  let reject = false;
  const f = await settledFixture({ runVerticalSecurityAdmin: async () => { if (reject) throw new Error('读取失败'); return { tunnels: [], certificates: [] }; } });
  switchPage(f, 'tunnels');
  await f.button('刷新隧道').props.onClick(); f.render();
  assert.equal(f.nodes().find(node => node.type === 'Table').props.locale.emptyText, '装置当前没有隧道');
  reject = true; await f.button('刷新隧道').props.onClick(); f.render();
  assert.ok(f.nodes().some(node => node.props.title === '读取失败'));
  assert.equal(f.nodes().find(node => node.type === 'Table').props.locale.emptyText, '隧道读取失败，请重新刷新');
  let resolve;
  const late = await settledFixture({ runVerticalSecurityAdmin: () => new Promise(done => { resolve = done; }) });
  switchPage(late, 'tunnels'); const task = late.button('刷新隧道').props.onClick();
  late.render({ sessionId: 'session-b' }); resolve({ tunnels: [tunnel], certificates: [] }); await task;
  switchPage(late, 'tunnels');
  assert.equal(late.nodes().find(node => node.type === 'Table').props.dataSource.length, 0);
});

test('切换分页保持共享忙状态并拒绝并发设备操作', async () => {
  let resolve;
  const f = await settledFixture({ runVerticalSecurityAdmin: request => { f.calls.push(request); return new Promise(done => { resolve = done; }); } });
  switchPage(f, 'tunnels'); const task = f.button('刷新隧道').props.onClick();
  switchPage(f, 'certificates'); await f.button('导出 SM2 CSR').props.onClick();
  assert.equal(f.calls.length, 1);
  resolve({ tunnels: [tunnel], certificates: [] }); await task;
  switchPage(f, 'tunnels'); assert.equal(f.nodes().find(node => node.type === 'Table').props.dataSource.length, 1);
});


test('未知隧道状态保留原码，缺失算法与错误信息明确显示未提供', async () => {
  const f = await settledFixture({ runVerticalSecurityAdmin: async () => ({ tunnels: [{ ...tunnel, state: 88, hot_state: 9, algorithm: null }], certificates: [] }) });
  switchPage(f, 'tunnels'); await f.button('刷新隧道').props.onClick(); f.render();
  const table = f.nodes().find(node => node.type === 'Table');
  const column = key => table.props.columns.find(item => item.dataIndex === key);
  assert.equal(column('state').render(88).props.children, '未知状态（88）');
  assert.equal(column('hot_state').render(9), '未知（9）');
  assert.equal(column('algorithm').render(null), '未提供');
  assert.equal(column('error_info').render(null), '未提供');
});

test('重置失败不显示已受理且不自动重试；卸载后的迟到应答不更新页面', async () => {
  for (const fail of [true, false]) {
    let resolve;
    const f = await settledFixture({ runVerticalSecurityAdmin: async request => {
      f.calls.push(request);
      if (request.action === 'list_tunnels') return { tunnels: [tunnel] };
      if (fail) throw new Error('重置应答超时，结果未确认');
      return new Promise(done => { resolve = done; });
    } });
    switchPage(f, 'tunnels'); await f.button('刷新隧道').props.onClick(); f.render();
    f.nodes().find(node => node.type === 'Table').props.rowSelection.onChange([7]); f.render();
    const task = f.nodes().find(node => node.type === 'Popconfirm').props.onConfirm();
    if (!fail) { f.unmount(); resolve({ message: '命令已受理' }); }
    await task; f.render();
    assert.equal(f.calls.length, 2);
    assert.ok(!f.nodes().some(node => String(node.props.title).includes('重置命令已受理')));
    if (fail) assert.ok(f.nodes().some(node => node.props.title === '重置应答超时，结果未确认'));
  }
});
