import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { Table } = require('antd');
const ts = require('typescript');
const componentPath = fileURLToPath(new URL('../../src/pages/IEC104/PointTable.tsx', import.meta.url));

// Node 的类型擦除不支持 TSX，因此在内存中编译组件，不写入构建文件。
function loadComponent() {
  const compiled = ts.transpileModule(readFileSync(componentPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const loaded = new Module(componentPath);
  loaded.paths = require.resolve.paths('react');
  loaded._compile(compiled.outputText, componentPath);
  return loaded.exports.default;
}

const PointTable = loadComponent();
const columns = [{ title: 'Tag', dataIndex: 'tag', key: 'tag', width: 180 }];
const makePoints = (count) => Array.from({ length: count }, (_, index) => ({
  tag: `point-${index}`, ioa: index + 1, point_type: 0, business_type: 0,
}));
const render = (points, overrides = {}) => renderToStaticMarkup(React.createElement(PointTable, {
  columns, points, selectedTags: [], selectionEnabled: true,
  onSelectionChange: () => {}, loading: false, runtime: false, emptyText: 'No points',
  ...overrides,
}));

for (const count of [800, 2000]) {
  test(`IEC104 ${count} 个点位仅挂载视口内的行`, (context) => {
    const points = makePoints(count);
    // 使用同一版本的 AntD 保留旧配置作为对照，确认旧表格会挂载全部行。
    const previousHtml = renderToStaticMarkup(React.createElement(Table, {
      rowKey: 'tag', dataSource: points, columns, pagination: false,
      size: 'small', scroll: { x: 1170 },
    }));
    const previousRows = (previousHtml.match(/data-row-key=/g) ?? []).length;
    assert.equal(previousRows, count);
    const html = render(points);
    const mountedRows = (html.match(/data-row-key=/g) ?? []).length;
    assert.ok(mountedRows > 0, '视口必须显示点位');
    assert.ok(mountedRows < 40, `${count} 个点位挂载了 ${mountedRows} 行，超出视口范围`);
    assert.match(html, /data-row-key="point-0"/);
    assert.doesNotMatch(html, new RegExp(`data-row-key="point-${count - 1}"`));
    context.diagnostic(`旧表格：${previousRows} 行；虚拟视口：${mountedRows} 行`);
  });
}

test('IEC104 筛选和恢复点表后保留标签勾选状态', () => {
  const points = makePoints(800);
  const selectedTags = ['point-1', 'point-799'];
  const first = render(points.slice(0, 3), { selectedTags });
  const last = render(points.slice(-3), { selectedTags });
  const restored = render(points, { selectedTags });
  for (const html of [first, last, restored]) {
    assert.match(html, /ant-checkbox-checked/);
  }
  assert.match(first, /data-row-key="point-1"/);
  assert.match(last, /data-row-key="point-799"/);
  assert.deepEqual(selectedTags, ['point-1', 'point-799']);
});

test('IEC104 点表保留空状态和运行视图的选择模式', () => {
  assert.match(render([]), /No points/);
  assert.doesNotMatch(render(makePoints(10), { runtime: true, selectionEnabled: false }), /ant-checkbox/);
});

test('IEC104 视口监听容器和表头尺寸并清理观察器', () => {
  const source = readFileSync(componentPath, 'utf8');
  assert.match(source, /new ResizeObserver\(measure\)/);
  assert.match(source, /observer\.observe\(container\)/);
  assert.match(source, /observer\.observe\(header\)/);
  assert.match(source, /container\.clientHeight\s*-\s*\(header\?\.offsetHeight/);
  assert.match(source, /observer\.disconnect\(\)/);
  assert.match(source, /preserveSelectedRowKeys:\s*true/);
  assert.match(source, /export default memo\(Iec104PointTable\)/);
});
