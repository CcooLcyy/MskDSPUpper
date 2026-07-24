import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  getIoaCategoryFilterByIoa,
  getIoaCategoryRange,
  matchesIoaCategoryFilter,
} from '../../src/pages/IEC104/ioa-category.ts';

const pageSource = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');

test('IEC104 按固定 IOA 地址段归类四遥和参数', () => {
  assert.deepEqual(getIoaCategoryRange('teleindication'), { start: 0x0001, end: 0x4000 });
  assert.deepEqual(getIoaCategoryRange('telemetry'), { start: 0x4001, end: 0x6200 });
  assert.deepEqual(getIoaCategoryRange('remoteAdjust'), { start: 0x6201, end: 0x7FFF });
  assert.deepEqual(getIoaCategoryRange('remoteControl'), { start: 0x8000, end: 0x9FFF });
  assert.deepEqual(getIoaCategoryRange('parameter'), { start: 0xA000, end: 0xBFFF });
});

test('IEC104 IOA 地址段边界和未分类判断正确', () => {
  assert.equal(getIoaCategoryFilterByIoa(0x0001), 'teleindication');
  assert.equal(getIoaCategoryFilterByIoa(0x4000), 'teleindication');
  assert.equal(getIoaCategoryFilterByIoa(0x4001), 'telemetry');
  assert.equal(getIoaCategoryFilterByIoa(0x6200), 'telemetry');
  assert.equal(getIoaCategoryFilterByIoa(0x6201), 'remoteAdjust');
  assert.equal(getIoaCategoryFilterByIoa(0x7FFF), 'remoteAdjust');
  assert.equal(getIoaCategoryFilterByIoa(0x8000), 'remoteControl');
  assert.equal(getIoaCategoryFilterByIoa(0x9FFF), 'remoteControl');
  assert.equal(getIoaCategoryFilterByIoa(0xA000), 'parameter');
  assert.equal(getIoaCategoryFilterByIoa(0xBFFF), 'parameter');
  assert.equal(getIoaCategoryFilterByIoa(0xC000), 'unclassified');
  assert.equal(getIoaCategoryFilterByIoa(0xFFFFFF), 'unclassified');
});

test('IEC104 IOA 筛选仅匹配所选业务类别', () => {
  assert.equal(matchesIoaCategoryFilter(0x4001, 'telemetry'), true);
  assert.equal(matchesIoaCategoryFilter(0x4001, 'remoteAdjust'), false);
  assert.equal(matchesIoaCategoryFilter(0xC000, 'unclassified'), true);
  assert.equal(matchesIoaCategoryFilter(0xC000, 'parameter'), false);
  assert.equal(matchesIoaCategoryFilter(0x8000, undefined), true);
});

test('IEC104 页面使用 IOA 业务类别筛选并显示归类结果', () => {
  assert.match(pageSource, /const \[ioaCategoryFilter, setIoaCategoryFilter\] = useState<IoaCategoryFilterKey>\(\)/);
  assert.match(pageSource, /matchesIoaCategoryFilter\(point\.ioa, ioaCategoryFilter\)/);
  assert.match(pageSource, /placeholder="全部业务类别"[\s\S]*options=\{IOA_CATEGORY_FILTER_OPTIONS\}/);
  assert.match(pageSource, /getIoaCategoryFilterByIoa\(ioa\)[\s\S]*getIoaCategoryLabel\(category\)/);
});
