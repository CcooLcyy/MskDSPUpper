import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const filename = fileURLToPath(new URL('../../src/pages/SecurityAccess/SecurityOperator.tsx', import.meta.url));
const network = { description: 'management', interface: 'eth0', interface_type: 'CONFIG', ip: '192.0.2.1', netmask: '255.255.255.0', vlan: '0' };
const policy = id => ({ id, tunnel_id: '1', mode: '0', source_start: '192.0.2.1', source_end: '192.0.2.1', destination_start: '198.51.100.1', destination_end: '198.51.100.1', protocol: '2', direction: '1', source_port_start: '0', source_port_end: '65535', destination_port_start: '2404', destination_port_end: '2404', description: '' });
const response = (kind, rows = kind === 'network' ? [network] : []) => ({ kind, revision: 'revision-1', rows, interfaces: ['eth0'], certificates: ['peer.pem'], tunnel_ids: ['1'], bidirectional_allowed: true, message: '已读取', verified: true });

// 执行真实组件事件，只替换 React 渲染器及设备 IPC 边界；不连接设备。
function fixture(implementation = async request => response(request.kind, request.rows), initialProps = {}) {
  const slots = [], effects = new Set(), calls = [], busyChanges = [];
  let cursor = 0, tree, props = { sessionId: 'session-a', onBusyChange: value => busyChanges.push(value), ...initialProps };
  const react = {
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], value => { slots[id] = typeof value === 'function' ? value(slots[id]) : value; }]; },
    useRef(initial) { const id = cursor++; return slots[id] ??= { current: initial }; },
    useEffectEvent(callback) { const id = cursor++; if (!slots[id]) slots[id] = { callback, event: (...args) => slots[id].callback(...args) }; slots[id].callback = callback; return slots[id].event; },
    useEffect(effect, deps) { const id = cursor++; if (!slots[id] || deps.some((value, index) => value !== slots[id].deps[index])) { slots[id]?.cleanup?.(); slots[id] = { deps, cleanup: effect() }; effects.add(id); } },
  };
  const element = (type, p) => ({ type, props: p ?? {} });
  const widgets = Object.fromEntries(['Alert', 'Button', 'Card', 'Input', 'Modal', 'Popconfirm', 'Select', 'Space', 'Table', 'Tabs', 'Tag'].map(name => [name, name]));
  const loaded = new Module(filename);
  loaded.require = name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx: element, jsxs: element, Fragment: 'Fragment' } : name === 'antd' ? widgets : name === '../../adapters' ? { api: { runVerticalSecurityOperator: request => { calls.push(request); return implementation(request); } } } : name.endsWith('.css') ? {} : require(name);
  loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const render = next => { props = { ...props, ...next }; cursor = 0; tree = loaded.exports.default(props); return tree; };
  const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' ? [node, ...walk(node.props?.children)] : [];
  const nodes = (node = tree) => walk(node);
  const button = label => nodes().find(node => node.type === 'Button' && node.props.children === label);
  const table = () => nodes().find(node => node.type === 'Table');
  const modal = () => nodes().find(node => node.type === 'Modal');
  const switchPage = kind => { nodes().find(node => node.type === 'Tabs').props.onChange(kind); render(); };
  const rowActions = index => nodes(table().props.columns.at(-1).render(null, table().props.dataSource[index]));
  const change = (label, value) => { const node = nodes().find(node => node.props['aria-label'] === label); node.props.onChange(node.type === 'Select' ? value : { target: { value } }); render(); };
  const read = async () => { await button('读取配置').props.onClick(); render(); };
  const edit = index => { rowActions(index).find(node => node.type === 'Button' && node.props.children === '编辑').props.onClick(); render(); };
  render(); render();
  return { calls, busyChanges, render, nodes, button, table, modal, switchPage, rowActions, change, read, edit, unmount: () => effects.forEach(id => slots[id]?.cleanup?.()) };
}

test('四页不自动发请求，未读取及禁用时不允许上传或新增', async () => {
  const f = fixture();
  const tabs = f.nodes().find(node => node.type === 'Tabs');
  assert.deepEqual(tabs.props.items.map(item => item.label), ['网络配置', '路由配置', '隧道配置', '策略配置']);
  for (const kind of ['network', 'routes', 'tunnels', 'policies']) { f.switchPage(kind); assert.equal(f.button('新增').props.disabled, true); assert.equal(f.button('上传配置').props.disabled, true); }
  assert.equal(f.calls.length, 0);
  f.render({ disabled: true }); await f.read(); assert.equal(f.calls.length, 0);
});

test('草稿切页保留，编辑不写装置，上传明确确认并携带原revision', async () => {
  const f = fixture(); await f.read(); f.edit(0); f.change('IP 地址', '192.0.2.2');
  f.modal().props.onOk(); f.render();
  assert.equal(f.calls.length, 1); f.switchPage('routes'); f.switchPage('network');
  assert.equal(f.table().props.dataSource[0].row.ip, '192.0.2.2');
  f.button('上传配置').props.onClick(); f.render(); assert.equal(f.calls.length, 1);
  assert.ok(f.nodes().some(node => node.type === 'Alert' && String(node.props.title).includes('中断')));
  await f.modal().props.onOk(); f.render();
  assert.deepEqual(f.calls[1], { session_id: 'session-a', action: 'save', kind: 'network', revision: 'revision-1', rows: [{ ...network, ip: '192.0.2.2' }] });
  assert.equal(f.button('上传配置').props.disabled, true);
  assert.ok(f.nodes().some(node => String(node.props.title).includes('回读核对一致')));
});

test('读取有修改的页面必须确认丢弃，取消保留草稿', async () => {
  const f = fixture(); await f.read(); f.edit(0); f.change('IP 地址', '192.0.2.2'); f.modal().props.onOk(); f.render();
  await f.read(); assert.equal(f.calls.length, 1); assert.match(f.modal().props.title, /放弃/);
  f.modal().props.onCancel(); f.render(); assert.equal(f.table().props.dataSource[0].row.ip, '192.0.2.2');
  await f.read(); await f.modal().props.onOk(); f.render(); assert.equal(f.calls.length, 2); assert.equal(f.table().props.dataSource[0].row.ip, '192.0.2.1');
});

test('上传异常或回读不一致保留草稿，禁止自动及重复上传', async () => {
  for (const reject of [true, false]) {
    const f = fixture(async request => { if (request.action === 'save') { if (reject) throw new Error('写入结果未确认'); return { ...response(request.kind), verified: false, message: '回读不一致' }; } return response(request.kind); });
    await f.read(); f.edit(0); f.change('IP 地址', '192.0.2.2'); f.modal().props.onOk(); f.render();
    f.button('上传配置').props.onClick(); f.render(); await f.modal().props.onOk(); f.render();
    assert.equal(f.table().props.dataSource[0].row.ip, '192.0.2.2');
    assert.equal(f.button('上传配置').props.disabled, true); assert.equal(f.calls.length, 2);
    assert.ok(!f.nodes().some(node => String(node.props.title).includes('回读核对一致')));
  }
});

test('策略上移下移保留ID，隧道ID仅引用已读取选项，rule-fix不提供双向', async () => {
  const f = fixture(async request => ({ ...response(request.kind, [policy('9'), policy('3')]), bidirectional_allowed: false }));
  f.switchPage('policies'); await f.read();
  f.rowActions(1).find(node => node.type === 'Button' && node.props.children === '上移').props.onClick(); f.render();
  assert.deepEqual(f.table().props.dataSource.map(entry => entry.row.id), ['3', '9']);
  assert.equal(f.calls.length, 1); f.edit(0);
  assert.deepEqual(f.nodes().find(node => node.props['aria-label'] === '隧道 ID').props.options, [{ value: '1', label: '1' }]);
  assert.ok(!f.nodes().find(node => node.props['aria-label'] === '方向').props.options.some(option => option.value === '0'));
});

test('未识别枚举保留原值展示并拒绝静默改写，输入逗号不能加入草稿', async () => {
  const f = fixture(async request => response(request.kind, [{ ...network, interface_type: 'UNKNOWN' }]));
  await f.read(); f.edit(0);
  assert.ok(f.nodes().find(node => node.props['aria-label'] === '接口类型').props.options.some(option => option.value === 'UNKNOWN'));
  f.modal().props.onOk(); f.render(); assert.ok(f.modal()); assert.equal(f.calls.length, 1);
  f.change('接口类型', 'CONFIG'); f.change('描述', 'a,b'); f.modal().props.onOk(); f.render(); assert.ok(f.modal());
  assert.equal(f.table().props.dataSource[0].row.description, 'management');
});

test('隧道草稿使用类别5证书并允许未启用备用端的原厂占位', async () => {
  const f = fixture(); f.switchPage('tunnels'); await f.read(); f.button('新增').props.onClick(); f.render();
  assert.deepEqual(f.nodes().find(node => node.props['aria-label'] === '主装置证书').props.options, [{ value: 'peer.pem', label: 'peer.pem' }]);
  assert.equal(f.nodes().find(node => node.props['aria-label'] === '对端备地址').props.value, '0.0.0.0');
  f.change('名称', 't1'); f.change('隧道 ID', '1'); f.change('本端地址', '192.0.2.1'); f.change('对端主地址', '198.51.100.1');
  f.modal().props.onOk(); f.render(); assert.equal(f.modal(), undefined);
  assert.equal(f.table().props.dataSource[0].row.backup_certificate, 'cert2.pem'); assert.equal(f.calls.length, 1);
});

test('忙时只发送一次并通知父级，换会话或卸载丢弃迟到结果', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.button('读取配置').props.onClick();
  await f.button('读取配置').props.onClick(); f.render();
  assert.equal(f.calls.length, 1); assert.equal(f.button('读取配置').props.disabled, true); assert.equal(f.busyChanges.at(-1), true);
  f.render({ sessionId: 'session-b' }); f.render(); resolve(response('network')); await pending; f.render();
  assert.equal(f.table().props.dataSource.length, 0); assert.equal(f.busyChanges.at(-1), false);
  const late = f.button('读取配置').props.onClick(); f.unmount(); resolve(response('network')); await late;
  assert.equal(f.calls.length, 2);
});
