import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

const controlViewSource = read('src/components/control/control-view.ts');
const switcherSource = read('src/components/control/ControlHeaderViewSwitcher.tsx');
const agcSource = read('src/pages/AGC/index.tsx');
const avcSource = read('src/pages/AVC/index.tsx');

// 验证 AGC 和 AVC 共用的控制导航把默认点放在策略与日志之间，并保持旧默认视图兼容。
test('控制导航包含默认点页签且顺序正确', () => {
  assert.match(controlViewSource, /ControlViewKey = 'strategy' \| 'default-points' \| 'logs'/);
  assert.match(
    controlViewSource,
    /label: '控制策略',[\s\S]*label: '默认点',[\s\S]*label: '控制日志'/,
  );
  assert.match(controlViewSource, /if \(value === 'default-points'\) return 'default-points';/);
  assert.match(controlViewSource, /return value === 'logs' \? 'logs' : DEFAULT_CONTROL_VIEW;/);
  assert.match(switcherSource, /CONTROL_VIEW_OPTIONS\.map/);
});

// 验证两个模块都把默认点表格迁移到独立页签，并继续使用实时值刷新逻辑。
test('AGC 和 AVC 都提供独立默认点视图', () => {
  for (const source of [agcSource, avcSource]) {
    assert.match(source, /currentView === 'default-points'/);
    assert.match(source, /title="默认点"/);
    assert.match(source, /columns=\{defaultPointColumns\}/);
    assert.match(source, /currentView !== 'strategy' && currentView !== 'default-points'/);
  }
});

// 验证策略页不再保留默认点卡片，避免同一内容在两个页签重复渲染。
test('策略页不重复渲染默认点卡片', () => {
  for (const source of [agcSource, avcSource]) {
    const strategyStart = source.indexOf("{currentView === 'strategy' ? (");
    const defaultTabStart = source.indexOf(") : currentView === 'default-points' ? (");
    assert.ok(strategyStart >= 0);
    assert.ok(defaultTabStart > strategyStart);
    const strategySource = source.slice(strategyStart, defaultTabStart);
    assert.doesNotMatch(strategySource, /<Card title="默认点"/);
  }
});
