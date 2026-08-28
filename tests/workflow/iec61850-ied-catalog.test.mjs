import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pageSource = readFileSync(new URL('../../src/pages/IEC61850/index.tsx', import.meta.url), 'utf8');
const typeSource = readFileSync(new URL('../../src/adapters/types.ts', import.meta.url), 'utf8');
const browserSource = readFileSync(new URL('../../src/adapters/browser.ts', import.meta.url), 'utf8');

// 验证模型目录传递IED和AccessPoint元数据，支持表单级联选择。
test('IEC61850 模型目录包含 IED 和 AccessPoint 元数据', () => {
  assert.match(typeSource, /export interface Iec61850SclIedSummary/);
  assert.match(typeSource, /access_points: Iec61850SclAccessPointSummary\[\]/);
  assert.match(typeSource, /ieds: Iec61850SclIedSummary\[\]/);
  assert.match(browserSource, /access_points: \[/);
});

// 验证新增IED表单按模型、IED、AccessPoint逐级选择，并处理无Server项。
test('IEC61850 新增IED使用模型到IED到AccessPoint级联下拉', () => {
  assert.match(pageSource, /const selectedModelCatalog/);
  assert.match(pageSource, /const selectedModelIeds/);
  assert.match(pageSource, /const selectedIedAccessPoints/);
  assert.match(pageSource, /name="ied_name"[\s\S]*<Select/);
  assert.match(pageSource, /name="access_point"[\s\S]*<Select/);
  assert.match(pageSource, /has_server/);
  assert.match(pageSource, /setFieldsValue\(\{ model_name: modelName, ied_name: nextIed, access_point: nextAccessPoint \}\)/);
  assert.match(pageSource, /setFieldsValue\(\{ ied_name: iedName, access_point: nextAccessPoint \}\)/);
});
