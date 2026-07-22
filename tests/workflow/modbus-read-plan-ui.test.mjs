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

// 新交互用显式动作表达读取策略，避免同时暴露“逐点/区间”模式下拉和隐式保存。
test('ModbusRTU PointTable 暴露批量方案工作流', () => {
  assert.match(pointTableSource, /生成批量方案/);
  assert.match(pointTableSource, /启用批量读取/);
  assert.match(pointTableSource, /恢复逐点读取/);
  assert.match(pointTableSource, /候选|预览/);
  assert.match(
    pointTableSource,
    /读取区间[^\n]*(?:过期|失效)|(?:过期|失效)[^\n]*读取区间|readPlan(?:Stale|Outdated)/i,
  );
  assert.match(pointTableSource, /已覆盖/);
  assert.match(pointTableSource, /未覆盖/);
  assert.match(pointTableSource, /重新生成区间/);
});

function getArrowFunctionSource(functionName) {
  const start = pointTableSource.indexOf(`const ${functionName} =`);
  assert.notEqual(start, -1, `PointTable 应提供 ${functionName} 操作处理函数`);
  const end = pointTableSource.indexOf('\n  };', start);
  assert.notEqual(end, -1, `${functionName} 操作处理函数应完整闭合`);
  return pointTableSource.slice(start, end);
}

function getButtonHandlerForLabel(label) {
  const labelIndex = pointTableSource.lastIndexOf(label);
  assert.notEqual(labelIndex, -1, `PointTable 应提供“${label}”按钮`);
  const handlerStart = pointTableSource.lastIndexOf('onClick={', labelIndex);
  assert.notEqual(handlerStart, -1, `“${label}”按钮应绑定明确动作`);
  const handlerMatch = pointTableSource.slice(handlerStart, labelIndex + label.length)
    .match(/onClick=\{([A-Za-z_$][\w$]*)\}/);
  assert.ok(handlerMatch, `“${label}”按钮应绑定命名动作`);
  return handlerMatch[1];
}

test('ModbusRTU 生成批量方案只更新候选预览，不直接保存', () => {
  const buttonIndex = pointTableSource.indexOf('生成批量方案');
  assert.notEqual(buttonIndex, -1);
  const buttonSource = pointTableSource.slice(Math.max(0, buttonIndex - 500), buttonIndex + 80);
  const handlerMatch = buttonSource.match(/onClick=\{([A-Za-z_$][\w$]*)\}/);
  assert.ok(handlerMatch, '生成批量方案按钮应绑定明确的本地预览动作');

  const previewSource = getArrowFunctionSource(handlerMatch[1]);
  assert.match(previewSource, /buildReadPlanBlocks\(points\)/);
  assert.match(previewSource, /set(?:ReadPlanBlocks|ReadPlanMode)\(/);
  assert.doesNotMatch(
    previewSource,
    /requestReadPlanApply|persistReadPlan|onReadPlanSave/,
    '生成批量方案只能更新候选状态，不得直接保存读取策略',
  );
});

test('ModbusRTU 应用批量或恢复逐点读取必须显式保存', () => {
  const batchApplySource = getArrowFunctionSource(getButtonHandlerForLabel('启用批量读取'));
  assert.match(batchApplySource, /requestReadPlanApply|persistReadPlan|onReadPlanSave/);

  const restoreApplySource = getArrowFunctionSource(getButtonHandlerForLabel('恢复逐点读取'));
  assert.match(restoreApplySource, /requestReadPlanApply|persistReadPlan|onReadPlanSave/);
});

test('ModbusRTU 区间应用对未覆盖点位提供确认语义', () => {
  assert.match(pointTableSource, /uncoveredPoints\.length/);
  assert.match(
    pointTableSource,
    /(?:uncoveredPoints\.length|coveredTags\.length)[\s\S]{0,260}(?:disabled|确认|confirm|warning|警告)/i,
    '应用批量方案应根据覆盖情况禁用或明确确认/警告',
  );
  assert.match(pointTableSource, /on(?:Click|Confirm)=\{(?:applyReadPlan|restorePointReadPlan)\}/);
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
