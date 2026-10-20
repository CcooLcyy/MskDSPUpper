import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const page = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');
const realtime = readFileSync(new URL('../../src/components/protocol/protocol-realtime.tsx', import.meta.url), 'utf8');

// 验证配置、SOE、日志视图不会把连接交给实时轮询，运行视图仍保留原查询方向。
test('IEC104 仅运行视图启用全点实时查询', () => {
  const selection = page.match(/const realtimeConnId = ([\s\S]*?);/);
  assert.ok(selection, '页面必须按可见视图选择实时连接');
  for (const currentView of ['config', 'soe', 'logs']) {
    for (const pointTableView of ['config', 'runtime']) {
      for (const selectedLink of [{ conn_id: 7 }, null]) {
        const connId = vm.runInNewContext(selection[1], { currentView, pointTableView, selectedLink });
        assert.equal(connId, currentView === 'config' && pointTableView === 'runtime' && selectedLink ? 7 : null);
      }
    }
  }
  assert.match(page, /useProtocolRealtime\(\s*realtimeConnId,\s*realtimeTags,\s*realtimeQueryMode/);
});

// 验证关闭实时查询时反复渲染返回相同的空映射，防止无关输入使列缓存失效。
test('未查询实时值时返回稳定空映射且不显示加载', () => {
  const context = {
    exports: {},
    require(name) {
      if (name === 'react') return {
        useMemo: (fn) => fn(), useRef: (value) => ({ current: value }),
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
        useEffect: () => {}, useEffectEvent: (fn) => fn,
      };
      if (name === 'antd') return { Typography: {}, Tag: () => null };
      if (name.includes('use-capability')) return { useCapability: () => true };
      if (name.includes('adapters')) return { api: new Proxy({}, { get() { throw new Error('不应查询实时值'); } }) };
      return {};
    },
  };
  vm.runInNewContext(ts.transpileModule(realtime, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, context);
  const first = context.exports.useProtocolRealtime(null, ['点位1']);
  const second = context.exports.useProtocolRealtime(null, ['点位1']);
  assert.equal(first.realtimeByTag, second.realtimeByTag);
  assert.equal(first.realtimeRevisionByTag, second.realtimeRevisionByTag);
  assert.equal(first.loading, false);
});
