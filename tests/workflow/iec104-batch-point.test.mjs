import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  BATCH_POINT_TYPE_FLOAT,
  BATCH_POINT_TYPE_SINGLE,
  generateBatchPoints,
  parseBatchPointNames,
} from '../../src/pages/IEC104/batch-point.ts';

const pageSource = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');

// 验证批量点名按行解析并忽略空行，同时保留原始行号。
test('IEC104 batch point names ignore blank lines', () => {
  assert.deepEqual(parseBatchPointNames('\n  voltage_a\r\n\r\nvoltage_b  '), [
    { line: 2, tag: 'voltage_a' },
    { line: 4, tag: 'voltage_b' },
  ]);
});

// 验证起始 IOA 和步长会生成连续点位。
test('IEC104 batch points allocate sequential IOAs', () => {
  const result = generateBatchPoints({
    text: 'voltage_a\nvoltage_b\nvoltage_c',
    startIoa: 0x4001,
    step: 1,
    ioaCategory: 'telemetry',
    pointType: BATCH_POINT_TYPE_FLOAT,
    scale: 0.1,
    offset: -2,
    deadband: 0.2,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.drafts.map(({ tag, ioa, business_type: businessType, scale, offset, deadband }) => ({ tag, ioa, businessType, scale, offset, deadband })), [
    { tag: 'voltage_a', ioa: 0x4001, businessType: 2, scale: 0.1, offset: -2, deadband: 0.2 },
    { tag: 'voltage_b', ioa: 0x4002, businessType: 2, scale: 0.1, offset: -2, deadband: 0.2 },
    { tag: 'voltage_c', ioa: 0x4003, businessType: 2, scale: 0.1, offset: -2, deadband: 0.2 },
  ]);
});

// 验证选择业务类别后会限制生成地址，并在连续地址跨出类别范围时报错。
test('IEC104 batch points respect the selected IOA category range', () => {
  const result = generateBatchPoints({
    text: 'voltage_a\nvoltage_b\nvoltage_c',
    startIoa: 0x4001,
    step: 1,
    ioaCategory: 'telemetry',
    pointType: BATCH_POINT_TYPE_FLOAT,
    scale: 1,
    offset: 0,
    deadband: 0,
  });
  const crossingResult = generateBatchPoints({
    text: 'voltage_last\nvoltage_next',
    startIoa: 0x6200,
    step: 1,
    ioaCategory: 'telemetry',
    pointType: BATCH_POINT_TYPE_FLOAT,
    scale: 1,
    offset: 0,
    deadband: 0,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.drafts.map(({ ioa, ioa_category: ioaCategory }) => ({ ioa, ioaCategory })), [
    { ioa: 0x4001, ioaCategory: 'telemetry' },
    { ioa: 0x4002, ioaCategory: 'telemetry' },
    { ioa: 0x4003, ioaCategory: 'telemetry' },
  ]);
  assert.ok(crossingResult.issues.some((issue) =>
    issue.line === 2 && issue.message.includes('不在遥测 IOA 范围')),
  );
});

// 验证全部业务类别都能从各自地址段生成点位，自定义类别保留完整地址范围。
test('IEC104 batch points support every IOA category', () => {
  const categories = [
    { ioaCategory: 'custom', startIoa: 0xC000 },
    { ioaCategory: 'teleindication', startIoa: 0x0001 },
    { ioaCategory: 'telemetry', startIoa: 0x4001 },
    { ioaCategory: 'remoteAdjust', startIoa: 0x6201 },
    { ioaCategory: 'remoteControl', startIoa: 0x8000 },
    { ioaCategory: 'parameter', startIoa: 0xA000 },
  ];

  categories.forEach(({ ioaCategory, startIoa }) => {
    const result = generateBatchPoints({
      text: 'point',
      startIoa,
      step: 1,
      ioaCategory,
      pointType: BATCH_POINT_TYPE_FLOAT,
      scale: 1,
      offset: 0,
      deadband: 0,
    });

    assert.deepEqual(result.issues, []);
    assert.equal(result.drafts[0].ioa_category, ioaCategory);
  });
});

// 验证已有 Tag/IOA 冲突、非法步长和地址越界都会阻止提交。
test('IEC104 batch points report conflicts and invalid ranges', () => {
  const result = generateBatchPoints({
    text: 'existing\nnew\nnew',
    startIoa: 0xFFFFFF,
    step: 1,
    pointType: BATCH_POINT_TYPE_FLOAT,
    scale: 1,
    offset: 0,
    deadband: 0,
    occupiedTags: new Set(['existing']),
    occupiedIoas: new Set([0xFFFFFF]),
  });
  const invalidStepResult = generateBatchPoints({
    text: 'another',
    startIoa: 1,
    step: 0,
    pointType: BATCH_POINT_TYPE_FLOAT,
    scale: 1,
    offset: 0,
    deadband: 0,
  });

  assert.ok(invalidStepResult.issues.some((issue) => issue.message === '步长必须为正整数'));
  assert.ok(result.issues.some((issue) => issue.message === '标签 existing 已存在于当前点表'));
  assert.ok(result.issues.some((issue) => issue.message.includes('IOA 16777215 已存在于当前点表')));
  assert.ok(result.issues.some((issue) => issue.message.includes('超出 1 - 16777215 范围')));
  assert.deepEqual(
    result.issues
      .filter((issue) => issue.message === '标签 new 在批量输入中重复')
      .map((issue) => issue.line),
    [2, 3],
  );
});

// 验证空输入、非法起始 IOA 和 FLOAT 工程量参数错误都会阻止提交。
test('IEC104 batch points report global configuration errors', () => {
  const emptyResult = generateBatchPoints({
    text: ' \n\r\n',
    startIoa: 1,
    step: 1,
    pointType: BATCH_POINT_TYPE_FLOAT,
    scale: 1,
    offset: 0,
    deadband: 0,
  });
  const invalidResult = generateBatchPoints({
    text: 'voltage_a',
    startIoa: 0,
    step: 1,
    pointType: BATCH_POINT_TYPE_FLOAT,
    scale: Number.NaN,
    offset: Number.POSITIVE_INFINITY,
    deadband: -1,
  });

  assert.ok(emptyResult.issues.some((issue) => issue.message === '请至少输入一个点名'));
  assert.ok(invalidResult.issues.some((issue) => issue.message.includes('起始 IOA')));
  assert.ok(invalidResult.issues.some((issue) => issue.message === 'Scale 必须是有效数字'));
  assert.ok(invalidResult.issues.some((issue) => issue.message === 'Offset 必须是有效数字'));
  assert.ok(invalidResult.issues.some((issue) => issue.message === 'Deadband 必须大于等于 0'));
});

// 验证 SINGLE 点会忽略工程量换算参数。
test('IEC104 SINGLE batch points reset engineering parameters', () => {
  const result = generateBatchPoints({
    text: 'breaker_status',
    startIoa: 1,
    step: 1,
    ioaCategory: 'teleindication',
    pointType: BATCH_POINT_TYPE_SINGLE,
    scale: 10,
    offset: 5,
    deadband: 2,
  });

  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.drafts[0], {
    key: 'batch-1-0',
    sourceLine: 1,
    tag: 'breaker_status',
    ioa: 1,
    ioa_category: 'teleindication',
    point_type: BATCH_POINT_TYPE_SINGLE,
    business_type: 1,
    scale: 1,
    offset: 0,
    deadband: 0,
  });
});

// 验证 IEC104 页面接入批量点位入口和生成逻辑。
test('IEC104 page exposes batch point entry', () => {
  assert.match(pageSource, /generateBatchPoints/);
  assert.match(pageSource, /批量添加点位/);
  assert.match(pageSource, /批量点名/);
  assert.match(pageSource, /起始 IOA/);
  assert.match(pageSource, /统一 IOA 业务类别/);
  assert.match(pageSource, /IOA_CATEGORY_FORM_OPTIONS/);
  assert.match(pageSource, /batchPointCategory/);
  assert.doesNotMatch(pageSource, /batchPointBusinessType/);
  assert.doesNotMatch(pageSource, /统一业务类型/);
  assert.match(pageSource, /business_type: draft\.business_type/);
  assert.match(pageSource, /const newPoints = \[\.\.\.points, \.\.\.normalizedPoints\]/);
  assert.match(pageSource, /runSelectedLinkStopped\(\(\) => api\.iec104UpsertPointTable\(selectedConn, newPoints, true\)\)/);
  assert.match(pageSource, /pagination=\{\{[\s\S]*defaultPageSize: 100/);
});
