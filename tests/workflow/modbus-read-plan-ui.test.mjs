import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pageSource = readFileSync(new URL('../../src/pages/ModbusRTU/index.tsx', import.meta.url), 'utf8');
const pointTableSource = readFileSync(
  new URL('../../src/pages/ModbusRTU/components/PointTable.tsx', import.meta.url),
  'utf8',
);

function getLinkModalSource() {
  const start = pageSource.indexOf('const renderLinkModal');
  const end = pageSource.indexOf('const renderPointModal');
  assert.notEqual(start, -1, '连接弹窗渲染函数必须保留，便于检查连接与点表职责边界');
  assert.notEqual(end, -1, '点位弹窗渲染函数必须保留，便于检查连接与点表职责边界');
  return pageSource.slice(start, end);
}

// 连接弹窗只负责创建连接，读取策略和读取区间应在连接建立后的点表工作区配置。
test('ModbusRTU 连接弹窗不再渲染读取策略或读取区间编辑器', () => {
  const linkModalSource = getLinkModalSource();

  assert.doesNotMatch(linkModalSource, /读取策略/);
  assert.doesNotMatch(linkModalSource, /添加读取区间/);
  assert.doesNotMatch(linkModalSource, /read_plan_mode/);
  assert.doesNotMatch(linkModalSource, /read_plan_blocks/);
});

// 点表工作区应承载逐点/区间策略切换、按点位生成区间以及覆盖情况反馈。
test('ModbusRTU PointTable 暴露读取策略和区间覆盖工作流', () => {
  assert.ok(
    /读取策略|readPlanMode|read_plan_mode|onReadPlanModeChange/.test(pointTableSource),
    'PointTable 应提供读取策略控件或对应受控接口',
  );
  assert.match(pointTableSource, /逐点读取/);
  assert.match(pointTableSource, /区间读取/);
  assert.ok(
    /生成读取区间|根据点位生成|添加读取区间|generate.*block|onGenerate.*Block/i.test(pointTableSource),
    'PointTable 应提供生成或添加读取区间的操作',
  );
  assert.ok(
    /覆盖|未覆盖|coverage|covered/i.test(pointTableSource),
    'PointTable 应显示点位被读取区间覆盖的状态',
  );
});

test('ModbusRTU 读取策略切换与区间应用职责分开', () => {
  assert.match(pointTableSource, /onChange=\{handleReadPlanModeChange\}/);
  assert.match(pointTableSource, /应用区间/);
  assert.match(pointTableSource, /requestReadPlanApply/);
  assert.match(pointTableSource, /Modal\.confirm/);
  assert.match(pointTableSource, /mode: 1, blocks: readPlanBlocks\.map/);
  assert.match(pointTableSource, /mode: 2, blocks: nextBlocks/);
  assert.doesNotMatch(pointTableSource, /setReadPlanBlocks\(\[\]\)/);
  assert.doesNotMatch(pointTableSource, /保存读取策略/);
});

// 无论连接新建还是点表首次进入，默认策略必须保持 POINT（逐点读取，协议值 1）。
test('ModbusRTU 默认读取策略保持 POINT/逐点读取', () => {
  const hasNamedPointDefault = /(?:DEFAULT_)?(?:READ_)?PLAN_MODE[^\n]*POINT/i.test(pageSource)
    || /(?:DEFAULT_)?(?:READ_)?PLAN_MODE[^\n]*POINT/i.test(pointTableSource)
    || /(?:readPlanMode|read_plan_mode)[^\n]*(?:'POINT'|"POINT")/i.test(pageSource)
    || /(?:readPlanMode|read_plan_mode)[^\n]*(?:'POINT'|"POINT")/i.test(pointTableSource);
  const hasNumericPointDefault = /(?:DEFAULT_)?(?:READ_)?PLAN_MODE[^\n]*(?:[:=][^\n]*\b1\b)/i.test(pageSource)
    || /(?:DEFAULT_)?(?:READ_)?PLAN_MODE[^\n]*(?:[:=][^\n]*\b1\b)/i.test(pointTableSource)
    || /mode\s*:\s*1\b/.test(pageSource)
    || /mode\s*:\s*1\b/.test(pointTableSource);

  assert.ok(
    hasNamedPointDefault || hasNumericPointDefault,
    '应明确保留 POINT（逐点读取）作为默认策略，而不是默认区间读取',
  );
  assert.match(`${pageSource}\n${pointTableSource}`, /逐点读取/);
});
