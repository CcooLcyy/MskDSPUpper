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
const kinds = ['network', 'routes', 'tunnels', 'policies'];
const initialReads = (sessionId = 'session-a') => kinds.map(kind => ({ session_id: sessionId, action: 'read', kind }));

// 执行真实组件事件，只替换 React 渲染器及设备 IPC 边界；不连接设备。
function fixture(implementation = async request => response(request.kind, request.rows), initialProps = {}) {
  const slots = [], effects = new Set(), calls = [], busyChanges = [];
  let cursor = 0, tree, props = { sessionId: 'session-a', onBusyChange: value => busyChanges.push(value), ...initialProps };
  const react = {
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], value => { slots[id] = typeof value === 'function' ? value(slots[id]) : value; }]; },
    useRef(initial) { const id = cursor++; return slots[id] ??= { current: initial }; },
    useEffectEvent(callback) { const id = cursor++; if (!slots[id]) slots[id] = { callback, event: (...args) => slots[id].callback(...args) }; slots[id].callback = callback; return slots[id].event; },
    useEffect(effect, deps) { const id = cursor++; if (!slots[id] || deps.some((value, index) => value !== slots[id].deps[index])) { slots[id]?.cleanup?.(); slots[id] = { deps, effect, cleanup: effect() }; effects.add(id); } },
  };
  const element = (type, p) => ({ type, props: p ?? {} });
  const widgets = Object.fromEntries(['Alert', 'Button', 'Card', 'Checkbox', 'Input', 'Modal', 'Popconfirm', 'Select', 'Space', 'Table', 'Tabs', 'Tag'].map(name => [name, name]));
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
  const change = (label, value) => { const node = nodes().find(node => node.props['aria-label'] === label); assert.ok(node, `未找到字段：${label}`); node.props.onChange(node.type === 'Select' ? value : { target: { value, checked: value } }); render(); };
  const read = async () => { await button('读取配置').props.onClick(); render(); };
  const edit = index => { rowActions(index).find(node => node.type === 'Button' && node.props.children === '编辑').props.onClick(); render(); };
  const settle = async (turns = 6) => { for (let i = 0; i < turns; i += 1) { await new Promise(setImmediate); render(); } };
  render(); render();
  return { calls, busyChanges, render, nodes, button, table, modal, switchPage, rowActions, change, read, edit, settle, setImplementation: value => { implementation = value; }, strictReplay: () => { effects.forEach(id => slots[id]?.cleanup?.()); effects.forEach(id => { slots[id].cleanup = slots[id].effect(); }); render(); }, unmount: () => effects.forEach(id => slots[id]?.cleanup?.()) };
}

// 每个原有手动操作用例先验证四项初读，再建立独立业务调用基线。
async function settledFixture(implementation) {
  const f = fixture();
  await f.settle();
  assert.deepEqual(f.calls, initialReads());
  assert.equal(f.button('读取配置').props.disabled, false);
  f.calls.length = 0;
  if (implementation) f.setImplementation(implementation);
  return f;
}

test('进入会话依序自动读取四页各一次，切页和重渲染不重复或上传', async () => {
  const f = fixture();
  const tabs = f.nodes().find(node => node.type === 'Tabs');
  assert.deepEqual(tabs.props.items.map(item => item.label), ['网络配置', '路由配置', '隧道配置', '策略配置']);
  await f.settle(); assert.deepEqual(f.calls, initialReads());
  for (const kind of kinds) { f.switchPage(kind); assert.equal(f.button('新增').props.disabled, false); assert.equal(f.button('上传配置').props.disabled, true); }
  f.render(); await f.settle(); assert.deepEqual(f.calls, initialReads());
});

test('初读全过程串行且保持忙状态，阻止编辑、重复读取并通知父级禁止退出', async () => {
  const pending = [];
  const f = fixture(request => new Promise(resolve => pending.push({ request, resolve })));
  await f.settle();
  for (let index = 0; index < kinds.length; index += 1) {
    assert.deepEqual(f.calls, initialReads().slice(0, index + 1));
    assert.equal(f.button('读取配置').props.disabled, true);
    assert.equal(f.button('新增').props.disabled, true);
    assert.equal(f.button('上传配置').props.disabled, true);
    assert.equal(f.busyChanges.at(-1), true);
    await f.button('读取配置').props.onClick(); assert.equal(f.calls.length, index + 1);
    pending[index].resolve(response(kinds[index])); await f.settle();
  }
  assert.deepEqual(f.calls, initialReads());
  assert.equal(f.button('读取配置').props.disabled, false);
  assert.equal(f.busyChanges.at(-1), false);
  assert.ok(f.busyChanges.slice(f.busyChanges.indexOf(true), -1).every(value => value === true));
});

test('StrictMode效果重放在发送前取消旧微任务，四项初读不重复', async () => {
  const f = fixture(); f.strictReplay(); await f.settle();
  assert.deepEqual(f.calls, initialReads());
  f.render(); await f.settle(); assert.deepEqual(f.calls, initialReads());
});

test('初始禁用等待解禁后初读，之后禁用切换不重复读取', async () => {
  const f = fixture(undefined, { disabled: true });
  await f.settle(); assert.deepEqual(f.calls, []);
  assert.equal(f.button('新增').props.disabled, true); await f.read(); assert.deepEqual(f.calls, []);
  f.render({ disabled: false }); await f.settle(); assert.deepEqual(f.calls, initialReads());
  f.render({ disabled: true }); await f.settle(); f.render({ disabled: false }); await f.settle();
  assert.deepEqual(f.calls, initialReads());
});

test('单页初读失败保留该页错误并继续其它页，不自动重试，手动读取成功清除', async () => {
  let failed = true;
  const f = fixture(async request => { if (request.kind === 'routes' && failed) throw new Error('路由初读失败'); return response(request.kind); });
  await f.settle(); assert.deepEqual(f.calls, initialReads());
  f.switchPage('routes'); assert.ok(f.nodes().some(node => node.type === 'Alert' && node.props.title === '路由配置自动读取失败' && node.props.description === '路由初读失败'));
  assert.equal(f.button('新增').props.disabled, true);
  f.switchPage('tunnels'); assert.equal(f.button('新增').props.disabled, false);
  f.switchPage('routes'); await f.settle(); assert.deepEqual(f.calls, initialReads());
  failed = false; await f.read();
  assert.deepEqual(f.calls, [...initialReads(), { session_id: 'session-a', action: 'read', kind: 'routes' }]);
  assert.equal(f.button('新增').props.disabled, false);
  assert.ok(!f.nodes().some(node => node.type === 'Alert' && node.props.title === '路由配置自动读取失败'));
});

test('初读中途禁用暂停后续请求，恢复仅读取未尝试页', async () => {
  let resolveNetwork;
  const f = fixture(request => request.kind === 'network' ? new Promise(resolve => { resolveNetwork = resolve; }) : Promise.resolve(response(request.kind)));
  await f.settle(); assert.deepEqual(f.calls, initialReads().slice(0, 1));
  f.render({ disabled: true }); resolveNetwork(response('network')); await f.settle();
  assert.deepEqual(f.calls, initialReads().slice(0, 1));
  f.render({ disabled: false }); await f.settle(); assert.deepEqual(f.calls, initialReads());
  assert.equal(f.button('新增').props.disabled, false);
});

test('换会话启动新初读，旧会话和卸载后的迟到结果不能覆盖或继续发请求', async () => {
  const pending = [];
  const f = fixture(request => new Promise(resolve => pending.push({ request, resolve })));
  await f.settle(); assert.deepEqual(f.calls, initialReads().slice(0, 1));
  f.render({ sessionId: 'session-b' }); await f.settle();
  assert.deepEqual(f.calls, [...initialReads().slice(0, 1), ...initialReads('session-b').slice(0, 1)]);
  pending[0].resolve(response('network', [{ ...network, ip: '192.0.2.99' }])); await f.settle();
  assert.equal(f.table().props.dataSource.length, 0); assert.equal(f.calls.length, 2);
  pending[1].resolve(response('network', [{ ...network, ip: '192.0.2.2' }])); await f.settle();
  assert.equal(f.table().props.dataSource[0].row.ip, '192.0.2.2');
  assert.deepEqual(f.calls, [...initialReads().slice(0, 1), ...initialReads('session-b').slice(0, 2)]);
  f.unmount(); pending[2].resolve(response('routes')); await f.settle();
  assert.equal(f.calls.length, 3); assert.equal(f.table().props.dataSource[0].row.ip, '192.0.2.2');
});

test('草稿切页保留，编辑不写装置，上传明确确认并携带原revision', async () => {
  const f = await settledFixture(); await f.read(); f.edit(0); f.change('IP 地址', '192.0.2.2');
  f.modal().props.onOk(); f.render();
  assert.equal(f.calls.length, 1); f.switchPage('routes'); f.switchPage('network'); await f.settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.table().props.dataSource[0].row.ip, '192.0.2.2');
  f.button('上传配置').props.onClick(); f.render(); assert.equal(f.calls.length, 1);
  assert.ok(f.nodes().some(node => node.type === 'Alert' && String(node.props.title).includes('中断')));
  await f.modal().props.onOk(); f.render();
  assert.deepEqual(f.calls[1], { session_id: 'session-a', action: 'save', kind: 'network', revision: 'revision-1', rows: [{ ...network, ip: '192.0.2.2' }] });
  assert.equal(f.button('上传配置').props.disabled, true);
  assert.ok(f.nodes().some(node => String(node.props.title).includes('回读核对一致')));
});

test('读取有修改的页面必须确认丢弃，取消保留草稿', async () => {
  const f = await settledFixture(); await f.read(); f.edit(0); f.change('IP 地址', '192.0.2.2'); f.modal().props.onOk(); f.render();
  await f.read(); assert.equal(f.calls.length, 1); assert.match(f.modal().props.title, /放弃/);
  f.modal().props.onCancel(); f.render(); assert.equal(f.table().props.dataSource[0].row.ip, '192.0.2.2');
  await f.read(); await f.modal().props.onOk(); f.render(); assert.equal(f.calls.length, 2); assert.equal(f.table().props.dataSource[0].row.ip, '192.0.2.1');
});

test('上传异常或回读不一致保留草稿，禁止自动及重复上传', async () => {
  for (const reject of [true, false]) {
    const f = await settledFixture(async request => { if (request.action === 'save') { if (reject) throw new Error('写入结果未确认'); return { ...response(request.kind), verified: false, message: '回读不一致' }; } return response(request.kind); });
    await f.read(); f.edit(0); f.change('IP 地址', '192.0.2.2'); f.modal().props.onOk(); f.render();
    f.button('上传配置').props.onClick(); f.render(); await f.modal().props.onOk(); f.render();
    assert.equal(f.table().props.dataSource[0].row.ip, '192.0.2.2');
    assert.equal(f.button('上传配置').props.disabled, true); assert.equal(f.calls.length, 2);
    assert.ok(!f.nodes().some(node => String(node.props.title).includes('回读核对一致')));
  }
});

test('策略上移下移保留ID，隧道ID仅引用已读取选项，rule-fix不提供双向', async () => {
  const f = await settledFixture(async request => ({ ...response(request.kind, [policy('9'), policy('3')]), bidirectional_allowed: false }));
  f.switchPage('policies'); await f.read();
  f.rowActions(1).find(node => node.type === 'Button' && node.props.children === '上移').props.onClick(); f.render();
  assert.deepEqual(f.table().props.dataSource.map(entry => entry.row.id), ['3', '9']);
  assert.equal(f.calls.length, 1); f.edit(0);
  assert.deepEqual(f.nodes().find(node => node.props['aria-label'] === '隧道 ID').props.options, [{ value: '1', label: '1' }]);
  assert.ok(!f.nodes().find(node => node.props['aria-label'] === '方向').props.options.some(option => option.value === '0'));
});

test('未识别枚举保留原值展示并拒绝静默改写，输入逗号不能加入草稿', async () => {
  const f = await settledFixture(async request => response(request.kind, [{ ...network, interface_type: 'UNKNOWN' }]));
  await f.read(); f.edit(0);
  assert.ok(f.nodes().find(node => node.props['aria-label'] === '接口类型').props.options.some(option => option.value === 'UNKNOWN'));
  f.modal().props.onOk(); f.render(); assert.ok(f.modal()); assert.equal(f.calls.length, 1);
  f.change('接口类型', 'CONFIG'); f.change('描述', 'a,b'); f.modal().props.onOk(); f.render(); assert.ok(f.modal());
  assert.equal(f.table().props.dataSource[0].row.description, 'management');
});

test('隧道草稿使用类别5证书并允许未启用备用端的原厂占位', async () => {
  const f = await settledFixture(); f.switchPage('tunnels'); await f.read(); f.button('新增').props.onClick(); f.render();
  assert.deepEqual(f.nodes().find(node => node.props['aria-label'] === '主装置证书').props.options, [{ value: 'peer.pem', label: 'peer.pem' }]);
  assert.equal(f.nodes().find(node => node.props['aria-label'] === '对端备地址').props.value, '0.0.0.0');
  f.change('名称', 't1'); f.change('隧道 ID', '1'); f.change('本端地址', '192.0.2.1'); f.change('对端主地址', '198.51.100.1');
  f.modal().props.onOk(); f.render(); assert.equal(f.modal(), undefined);
  assert.equal(f.table().props.dataSource[0].row.backup_certificate, 'cert2.pem'); assert.equal(f.calls.length, 1);
});

test('初读完成后手动读取同样禁止并发并通知父级，卸载后丢弃迟到结果', async () => {
  let resolve;
  const f = await settledFixture(() => new Promise(done => { resolve = done; }));
  const pending = f.button('读取配置').props.onClick();
  await f.button('读取配置').props.onClick(); f.render();
  assert.equal(f.calls.length, 1); assert.equal(f.button('读取配置').props.disabled, true); assert.equal(f.busyChanges.at(-1), true);
  f.unmount(); resolve(response('network', [{ ...network, ip: '192.0.2.99' }])); await pending; f.render();
  assert.equal(f.table().props.dataSource[0].row.ip, '192.0.2.1'); assert.equal(f.busyChanges.at(-1), false);
  assert.equal(f.calls.length, 1);
});

const route = { name: 'route1', interface: 'eth1', vlan: '0', destination: '198.51.100.0', netmask: '255.255.255.0', gateway: '192.0.2.254', table_id: '', source: '', source_mask: '' };
const tunnel = id => ({ name: `peer${id}`, id, mode: '0', local_ip: '192.0.2.1', primary_ip: '198.51.100.1', primary_certificate: 'peer.pem', backup_ip: '0.0.0.0', backup_certificate: 'cert2.pem', lifetime: '10000', capacity: '5000000' });
const field = (f, label) => f.nodes().find(node => node.props['aria-label'] === label);
const add = f => { f.button('新增').props.onClick(); f.render(); };
const confirmDraft = f => { f.modal().props.onOk(); f.render(); };

// 使用各页独立的装置回读结果，验证编辑事件不会触发设备上传。
async function loadedPage(kind, rows = [], extra = {}) {
  const f = fixture(async request => request.kind === kind ? { ...response(kind, rows), ...extra } : response(request.kind));
  await f.settle(); assert.deepEqual(f.calls, initialReads());
  f.calls.length = 0; f.switchPage(kind);
  return f;
}

test('网络接口恢复原版下拉，兼容已读取的eth0和eth6及CONFIG类型', async () => {
  const f = await loadedPage('network', [network, { ...network, description: 'backup', interface: 'eth6', interface_type: 'BACKUP' }], { interfaces: ['eth0', 'eth6'] });
  add(f);
  assert.equal(field(f, '接口').type, 'Select');
  const values = field(f, '接口').props.options.map(option => option.value);
  for (const value of ['eth1', 'eth2', 'eth3', 'eth4', 'eth5', 'BRIDGE', 'eth0', 'eth6']) assert.ok(values.includes(value), value);
  f.modal().props.onCancel(); f.render(); f.edit(0);
  assert.equal(field(f, '接口').props.value, 'eth0');
  assert.equal(field(f, '接口类型').props.value, 'CONFIG');
  confirmDraft(f); assert.equal(f.modal(), undefined);
  f.edit(1); assert.equal(field(f, '接口').props.value, 'eth6');
  confirmDraft(f); assert.equal(f.modal(), undefined); assert.equal(f.calls.length, 0);
});

test('网络确认草稿前拒绝错误IPv4、不连续掩码和越界VLAN，修正后正常保存', async () => {
  for (const [label, invalid] of [['IP 地址', '192.0.2.256'], ['子网掩码', '255.0.255.0'], ['VLAN', '-1'], ['VLAN', '4095'], ['VLAN', '1.5'], ['VLAN', '01']]) {
    const f = await loadedPage('network', [network]); f.edit(0); f.change(label, invalid);
    confirmDraft(f); assert.ok(f.modal(), `${label}=${invalid}不能确认`);
    assert.deepEqual(f.table().props.dataSource.map(entry => entry.row), [network]);
    assert.equal(f.calls.length, 0);
  }
  const f = await loadedPage('network', [network]); f.edit(0); f.change('VLAN', '4094');
  confirmDraft(f); assert.equal(f.modal(), undefined); assert.equal(f.table().props.dataSource[0].row.vlan, '4094');
});

test('未知网络接口仅展示原值，未核实的接口不能被默认为合法下拉项', async () => {
  const original = { ...network, interface: 'eth9' };
  const f = await loadedPage('network', [original]); f.edit(0);
  assert.equal(field(f, '接口').props.value, 'eth9');
  assert.ok(field(f, '接口').props.options.some(option => option.value === 'eth9'));
  confirmDraft(f); assert.ok(f.modal()); assert.deepEqual(f.table().props.dataSource[0].row, original);
  f.change('接口', 'eth1'); confirmDraft(f); assert.equal(f.modal(), undefined);
  assert.equal(f.table().props.dataSource[0].row.interface, 'eth1'); assert.equal(f.calls.length, 0);
});

test('路由出口使用回读候选，策略路由默认关闭且仅开启后要求三个字段完整', async () => {
  const f = await loadedPage('routes', [route], { interfaces: ['eth1', 'eth2', 'br0', 'eth6'] });
  f.edit(0);
  assert.equal(field(f, '出口接口').type, 'Select');
  assert.deepEqual(field(f, '出口接口').props.options.map(option => option.value), ['eth1', 'eth2', 'br0', 'eth6']);
  assert.equal(field(f, '启用策略路由').props.checked, false);
  assert.equal(field(f, '路由表 ID（策略路由）'), undefined);
  f.change('启用策略路由', true);
  assert.ok(field(f, '路由表 ID（策略路由）'));
  f.change('路由表 ID（策略路由）', '100'); confirmDraft(f); assert.ok(f.modal());
  f.change('源地址（策略路由）', '192.0.2.0');
  f.change('源掩码（策略路由）', '255.255.255.0'); confirmDraft(f);
  assert.equal(f.modal(), undefined); assert.equal(f.table().props.dataSource[0].row.table_id, '100');
  f.switchPage('network'); f.switchPage('routes');
  assert.equal(f.table().props.dataSource[0].row.source, '192.0.2.0'); assert.equal(f.calls.length, 0);
});

test('已有策略路由恢复开关，关闭并再次开启不恢复已清空字段，普通路由不写策略配置', async () => {
  const advanced = { ...route, table_id: '100', source: '192.0.2.0', source_mask: '255.255.255.0' };
  const f = await loadedPage('routes', [advanced], { interfaces: ['eth1'] }); f.edit(0);
  assert.equal(field(f, '启用策略路由').props.checked, true);
  assert.equal(field(f, '源地址（策略路由）').props.value, '192.0.2.0');
  f.change('启用策略路由', false); assert.equal(field(f, '源地址（策略路由）'), undefined);
  f.change('启用策略路由', true);
  for (const label of ['路由表 ID（策略路由）', '源地址（策略路由）', '源掩码（策略路由）']) assert.equal(field(f, label).props.value, '');
  f.change('启用策略路由', false); confirmDraft(f); assert.equal(f.modal(), undefined);
  assert.deepEqual(f.table().props.dataSource[0].row, route); assert.equal(f.calls.length, 0);
});

test('路由名称超过32位或含中文时不能进入草稿，32位英文名称允许保存', async () => {
  for (const invalid of ['a'.repeat(33), '中文路由']) {
    const f = await loadedPage('routes', [route], { interfaces: ['eth1'] }); f.edit(0); f.change('名称', invalid);
    confirmDraft(f); assert.ok(f.modal()); assert.equal(f.table().props.dataSource[0].row.name, route.name); assert.equal(f.calls.length, 0);
  }
  const f = await loadedPage('routes', [route], { interfaces: ['eth1'] }); f.edit(0); f.change('名称', 'a'.repeat(32));
  confirmDraft(f); assert.equal(f.modal(), undefined); assert.equal(f.table().props.dataSource[0].row.name.length, 32);
});

test('新建隧道推荐未占用ID并只选择装置证书，本端及对端地址保持输入', async () => {
  const f = await loadedPage('tunnels', [tunnel('1'), tunnel('3')]); add(f);
  assert.equal(field(f, '隧道 ID').props.value, '2');
  assert.equal(field(f, '主装置证书').props.value, 'peer.pem');
  for (const label of ['本端地址', '对端主地址']) { assert.equal(field(f, label).type, 'Input'); assert.equal(field(f, label).props.value, ''); }
  assert.equal(field(f, '备装置证书').props.disabled, true);
  f.change('对端备地址', '203.0.113.1'); assert.equal(field(f, '备装置证书').props.disabled, false);
  assert.equal(f.calls.length, 0);
});

test('加密隧道没有装置证书时禁止确认，明通不要求证书且保留协议占位', async () => {
  const f = await loadedPage('tunnels', [], { certificates: [] }); add(f);
  assert.ok(!field(f, '主装置证书').props.value);
  f.change('名称', 't1'); f.change('本端地址', '192.0.2.1'); f.change('对端主地址', '198.51.100.1');
  confirmDraft(f); assert.ok(f.modal()); assert.equal(f.table().props.dataSource.length, 0);
  f.change('模式', '2');
  assert.equal(field(f, '主装置证书').props.disabled, true);
  assert.equal(field(f, '备装置证书').props.disabled, true);
  confirmDraft(f); assert.equal(f.modal(), undefined);
  const saved = f.table().props.dataSource[0].row;
  assert.equal(saved.mode, '2'); assert.ok(saved.primary_certificate); assert.equal(saved.backup_certificate, 'cert2.pem'); assert.equal(f.calls.length, 0);
});

test('隧道确认前检查重复ID、周期与容量范围，保留原草稿和装置状态', async () => {
  for (const [label, invalid] of [['隧道 ID', '3'], ['隧道 ID', '0'], ['隧道 ID', '102401'], ['周期（小时）', '0'], ['周期（小时）', '10001'], ['容量', '10239'], ['容量', '2147493648']]) {
    const original = [tunnel('1'), tunnel('3')];
    const f = await loadedPage('tunnels', original); f.edit(0); f.change(label, invalid); confirmDraft(f);
    assert.ok(f.modal(), `${label}=${invalid}不能确认`); assert.deepEqual(f.table().props.dataSource.map(entry => entry.row), original); assert.equal(f.calls.length, 0);
  }
  const f = await loadedPage('tunnels', [tunnel('1')]); f.edit(0);
  f.change('隧道 ID', '102400'); f.change('容量', '2147493647'); confirmDraft(f);
  assert.equal(f.modal(), undefined); assert.equal(f.table().props.dataSource[0].row.id, '102400');
  assert.equal(f.table().props.dataSource[0].row.capacity, '2147493647'); assert.equal(f.calls.length, 0);
});

test('策略新增推荐未占用ID并引用真实隧道，默认全部协议和全端口范围', async () => {
  const f = await loadedPage('policies', [policy('1'), policy('3')], { tunnel_ids: ['7', '9'], bidirectional_allowed: false }); add(f);
  assert.equal(field(f, '策略 ID').props.value, '2');
  assert.equal(field(f, '隧道 ID').props.value, '7');
  for (const label of ['隧道 ID', '模式', '协议', '方向']) assert.equal(field(f, label).type, 'Select');
  assert.equal(field(f, '协议').props.value, '0');
  assert.ok(!field(f, '方向').props.options.some(option => option.value === '0'));
  for (const label of ['内网起始端口', '外网起始端口']) assert.equal(field(f, label).props.value, '0');
  for (const label of ['内网终止端口', '外网终止端口']) assert.equal(field(f, label).props.value, '65535');
  for (const label of ['内网起始地址', '内网终止地址', '外网起始地址', '外网终止地址']) assert.equal(field(f, label).props.value, '');
  assert.equal(f.calls.length, 0);
});

test('策略确认前拒绝重复ID、反向地址区间和非法端口，端口修正后保持排序及ID', async () => {
  for (const [label, invalid] of [['策略 ID', '3'], ['内网起始地址', '192.0.2.2'], ['外网终止地址', '198.51.100.0'], ['内网起始端口', '65536'], ['外网起始端口', '2405'], ['外网终止端口', '-1']]) {
    const original = [policy('1'), { ...policy('3'), mode: '1' }];
    const f = await loadedPage('policies', original); f.edit(0); f.change(label, invalid); confirmDraft(f);
    assert.ok(f.modal(), `${label}=${invalid}不能确认`); assert.deepEqual(f.table().props.dataSource.map(entry => entry.row), original); assert.equal(f.calls.length, 0);
  }
  const f = await loadedPage('policies', [policy('1'), { ...policy('3'), mode: '1' }]); f.edit(0); f.change('外网终止端口', '65535'); confirmDraft(f);
  assert.equal(f.modal(), undefined); assert.deepEqual(f.table().props.dataSource.map(entry => entry.row.id), ['1', '3']);
  assert.equal(f.table().props.dataSource[0].row.destination_port_end, '65535'); assert.equal(f.calls.length, 0);
});

test('策略没有可引用隧道时显示前置条件且不能确认草稿', async () => {
  const f = await loadedPage('policies', [], { tunnel_ids: [] }); add(f);
  assert.ok(!field(f, '隧道 ID').props.value);
  assert.equal(f.modal().props.okButtonProps.disabled, true);
  assert.ok(f.nodes().some(node => node.type === 'Alert' && String(node.props.title).includes('没有可用隧道')));
  confirmDraft(f); assert.ok(f.modal()); assert.equal(f.table().props.dataSource.length, 0); assert.equal(f.calls.length, 0);
});
