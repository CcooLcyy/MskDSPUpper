import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(resolve(root, path), 'utf8');

function tableHarness(path) {
  let view = 'engineering';
  let cursor = 0;
  const slots = [];
  const calls = [];
  const react = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], (next) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
    },
    useMemo: (fn) => fn(),
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  const cache = new Map();
  const jsx = (type, props) => ({ type, props });
  const antd = new Proxy({ Typography: { Text: 'Text' } }, {
    get(target, name) { return target[name] ?? `antd:${String(name)}`; },
  });
  const load = (file) => {
    if (cache.has(file)) return cache.get(file);
    const output = { exports: {} };
    cache.set(file, output.exports);
    const context = {
      exports: output.exports,
      console: { info() {} },
      require(name) {
        if (name === 'react') return { ...react, default: react };
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
        if (name === 'antd') return antd;
        if (name === '@ant-design/icons') return new Proxy({}, { get: (_, key) => `icon:${String(key)}` });
        if (name.endsWith('workbench-context')) return {
          useWorkbench: () => ({ view, runtimeAvailable: true, setView: (next) => { view = next; calls.push(['view', next]); } }),
        };
        if (name.endsWith('protocol-realtime')) return {};
        if (!name.startsWith('.')) throw new Error(`未预期的依赖：${name}`);
        const base = resolve(dirname(file), name);
        const dependency = [base, `${base}.ts`, `${base}.tsx`].find((candidate) => existsSync(candidate));
        assert.ok(dependency, `找不到依赖：${name}`);
        return load(dependency);
      },
    };
    vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, context, { filename: file });
    return output.exports;
  };
  const Component = load(resolve(root, path)).default;
  return {
    calls,
    render(props) { cursor = 0; return Component(props); },
    setGlobalView(next) { view = next; },
  };
}

function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((item) => nodes(item, predicate));
  const found = predicate(tree) ? [tree] : [];
  for (const value of Object.values(tree.props ?? tree)) found.push(...nodes(value, predicate));
  return found;
}

const point = (tag, address) => ({
  tag, address, function: 2, data_type: 2, reg_count: 1,
  di: String(address), access: 1,
  scale_decimal: '1', offset_decimal: '0', deadband_decimal: '0',
});

for (const protocol of ['ModbusRTU', 'DLT645']) {
  // 验证真实点表组件响应全局切换，并且本地筛选、未应用的读取方案不会被切换重置或保存。
  test(`${protocol} 全局切换保留筛选与草稿，局部切换回写工作台且不执行设备操作`, () => {
    const harness = tableHarness(`src/pages/${protocol}/components/PointTable.tsx`);
    const operations = [];
    const operation = () => { operations.push('设备操作'); };
    const props = {
      points: [point('功率A', 1), point('功率B', 2)], blocks: [], selectedConn: '连接一',
      realtimeByTag: {}, realtimeRevisionByTag: {}, realtimeLoading: false, pointsLoading: false,
      actionsDisabled: false, readPlan: { mode: 1, blocks: [] }, addressBase: 1,
      readPlanSaving: false, runtimeRunning: false,
      onReadPlanSave: operation, onAdd: operation, onApplyTemplate: operation,
      onEdit: operation, onCopy: operation, onDelete: operation, onDeleteAll: operation,
      onAddPoint: operation, onEditPoint: operation, onCopyPoint: operation,
      onDeletePoint: operation, onDeleteAllPoints: operation,
      onAddBlock: operation, onEditBlock: operation, onDeleteBlock: operation,
    };
    let tree = harness.render(props);
    const filter = nodes(tree, (node) => node.props?.['aria-controls']?.includes('filters'))[0];
    filter.props.onClick();
    tree = harness.render(props);
    const search = nodes(tree, (node) => node.type === 'antd:Input' && node.props.placeholder?.includes('Tag'))[0];
    search.props.onChange({ target: { value: '功率A' } });
    if (protocol === 'ModbusRTU') {
      const preview = nodes(tree, (node) => node.type === 'antd:Button' && node.props.children === '生成批量方案')[0];
      preview.props.onClick();
    }
    harness.setGlobalView('runtime');
    tree = harness.render(props);
    const segmented = nodes(tree, (node) => node.type === 'antd:Segmented')[0];
    assert.equal(segmented.props.value, 'runtime');
    const runtimeSearch = nodes(tree, (node) => node.type === 'antd:Input' && node.props.placeholder?.includes('Tag'))[0];
    assert.equal(runtimeSearch.props.value, '功率A');
    const table = nodes(tree, (node) => node.type === 'antd:Table' && node.props.dataSource?.some((item) => item.tag))[0];
    assert.equal(table.props.dataSource.length, 1);
    assert.equal(table.props.dataSource[0].tag, '功率A');
    assert.deepEqual(Array.from(table.props.columns, (column) => column.key).slice(0, 4), [
      'tag', 'realtime_value', 'realtime_quality', 'realtime_ts',
    ]);
    assert.ok(!table.props.columns.some((column) => ['action', 'scale', 'offset', 'deadband'].includes(column.key)));
    for (const action of nodes(tree, (node) => node.props?.className?.includes('protocol-engineering-actions'))) {
      assert.equal(action.props.hidden, true);
    }
    segmented.props.onChange('config');
    tree = harness.render(props);
    assert.equal(nodes(tree, (node) => node.type === 'antd:Segmented')[0].props.value, 'config');
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0][1], 'engineering');
    assert.equal(operations.length, 0);
    if (protocol === 'ModbusRTU') {
      const dirtyPlan = nodes(tree, (node) => node.props?.className === 'protocol-read-plan-toolbar')[0];
      assert.equal(dirtyPlan.props.hidden, false);
      assert.ok(JSON.stringify(dirtyPlan).includes('批量读取预览'));
    }
  });
}

// 验证 IEC61850 页签切换只改变展示，工程页签会在往返运行视图后恢复，加载效果不依赖工作台视图。
test('IEC61850 视图切换保留原工程页签并保持配置和映射挂载', () => {
  const source = read('src/pages/IEC61850/index.tsx');
  const file = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let changeTab;
  let activeTab;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'changeTab') changeTab = node.initializer.getText(file);
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'activeTab') activeTab = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(changeTab);
  assert.ok(activeTab);
  const context = {
    workbenchView: 'engineering', engineeringTab: 'mappings', console: { info() {} },
    setWorkbenchView(next) { context.workbenchView = next; },
    setEngineeringTab(next) { context.engineeringTab = next; },
  };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(`globalThis.changeTab = ${changeTab};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  context.changeTab('runtime');
  assert.equal(vm.runInContext(activeTab, context), 'runtime');
  assert.equal(context.engineeringTab, 'mappings');
  context.workbenchView = 'engineering';
  assert.equal(vm.runInContext(activeTab, context), 'mappings');
  context.changeTab('models');
  assert.equal(vm.runInContext(activeTab, context), 'models');
  assert.match(source, /destroyOnHidden=\{false\}/);
  for (const tab of ['config', 'models', 'mappings', 'runtime']) {
    assert.match(source, new RegExp(`key: '${tab}', forceRender: true`));
  }
  assert.match(source, /loadSelected\(selectedConn\); \}, \[loadSelected, selectedConn\]\)/);
});

// 验证 IEC104 继续使用同一个点表实例，选中项与编辑草稿不以工作台视图作为重建边界。
test('IEC104 点表视图派生自工作台，保留选择与原有实时查询保护', () => {
  const source = read('src/pages/IEC104/index.tsx');
  assert.match(source, /const pointTableView = protocolPointTableView\(workbenchView\)/);
  assert.match(source, /setWorkbenchView\(workbenchViewFromPointTable\(nextView\)\)/);
  assert.doesNotMatch(source, /key=\{(?:workbenchView|pointTableView)\}/);
  assert.match(source, /selectedTags=\{selectedPointTags\}/);
  assert.match(source, /currentView === 'config' && pointTableView === 'runtime'/);
});

// 验证运行视图先显示实时值与质量，不能被工程配置列挤出首屏；工程列和原有渲染器保持独立。
test('IEC104 运行列优先值、品质与时间，不展示点位编辑及遥控配置列', () => {
  const source = read('src/pages/IEC104/index.tsx');
  const branch = source.match(/if \(pointTableView === 'runtime'\) \{\s*return (\[[\s\S]*?\]);\s*\}/);
  assert.ok(branch, '必须保留独立的运行列选择');
  const context = Object.fromEntries([
    'tagColumn', 'ioaColumn', 'typeColumn', 'businessTypeColumn', 'remoteControlColumn',
    'fixedValueColumn', 'realtimeValueColumn', 'realtimeTimestampColumn', 'realtimeQualityColumn',
  ].map((key) => [key, { key }]));
  const columns = vm.runInNewContext(branch[1], context);
  assert.deepEqual(Array.from(columns, (column) => column.key), [
    'tagColumn', 'realtimeValueColumn', 'realtimeQualityColumn', 'realtimeTimestampColumn', 'ioaColumn', 'typeColumn',
  ]);
  assert.match(source, /return \[\s*tagColumn,\s*ioaColumn,\s*typeColumn,\s*businessTypeColumn,\s*remoteControlColumn/);
});
