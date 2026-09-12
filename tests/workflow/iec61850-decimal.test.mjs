import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createIec61850EngineeringFields,
  getIec61850PointEngineeringError,
  normalizeIec61850PointEngineeringFields,
  resolveIec61850PointDecimalText,
} from '../../src/utils/iec61850-decimal.ts';

const pageSource = readFileSync(new URL('../../src/pages/IEC61850/index.tsx', import.meta.url), 'utf8');
const typeSource = readFileSync(new URL('../../src/adapters/types.ts', import.meta.url), 'utf8');
const browserSource = readFileSync(new URL('../../src/adapters/browser.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../../src-tauri/src/commands/iec61850.rs', import.meta.url), 'utf8');

const legacyPoint = {
  tag: 'active_power',
  data_ref: 'IED1LD0/MMXU1.TotW.mag.f',
  fc: 2,
  source: 1,
  value_type: 3,
  scale: 0.1,
  offset: -2,
  deadband: 0.01,
  scale_decimal: '',
  offset_decimal: '',
  deadband_decimal: '',
};

// 验证 IEC61850 点映射构造保留 20 位小数原文，并只为旧客户端派生兼容 number。
test('IEC61850 点映射保留精确十进制工程量字段', () => {
  const fields = createIec61850EngineeringFields({
    scale: '0.12345678901234567890',
    offset: '-2.00000000000000000001',
    deadband: '1e-20',
  });

  assert.equal(fields.scale_decimal, '0.12345678901234567890');
  assert.equal(fields.offset_decimal, '-2.00000000000000000001');
  assert.equal(fields.deadband_decimal, '1e-20');
  assert.equal(fields.scale, Number('0.12345678901234567890'));
});

// 验证新十进制字段优先于旧 number，旧点表缺少文本时仍可兼容加载。
test('IEC61850 点映射优先读取十进制文本并兼容旧点表', () => {
  assert.equal(resolveIec61850PointDecimalText(legacyPoint, 'scale'), '0.1');

  const normalized = normalizeIec61850PointEngineeringFields({
    ...legacyPoint,
    scale_decimal: '0.10000000000000000001',
    offset_decimal: '-2.00000000000000000001',
  });
  assert.equal(normalized.scale_decimal, '0.10000000000000000001');
  assert.equal(normalized.offset_decimal, '-2.00000000000000000001');
  assert.equal(normalized.deadband_decimal, '0.01');
});

// 验证非法十进制文本不会回退到旧 number，负死区仍属于合法配置。
test('IEC61850 点映射严格校验十进制工程量字段', () => {
  assert.match(
    getIec61850PointEngineeringError({ ...legacyPoint, scale_decimal: '1.0非法尾随' }) ?? '',
    /倍率.*完整十进制数/,
  );
  assert.equal(
    getIec61850PointEngineeringError({
      ...legacyPoint,
      scale_decimal: '1',
      offset_decimal: '0',
      deadband_decimal: '-0.00000000000000000001',
    }),
    undefined,
  );
});

// 验证 DTO 与 Tauri gRPC 桥接双向传递三个十进制字段。
test('IEC61850 上位 DTO 和 Rust 桥接传递十进制工程量字段', () => {
  for (const field of ['scale_decimal', 'offset_decimal', 'deadband_decimal']) {
    assert.match(typeSource, new RegExp(`${field}: string`));
    assert.match(rustSource, new RegExp(`pub ${field}: String`));
    assert.match(rustSource, new RegExp(`${field}: v\\.${field}`));
    assert.match(rustSource, new RegExp(`${field}: self\\.${field}\\.clone\\(\\)`));
  }
});

// 验证页面加载、新增、编辑和保存链路始终携带十进制文本，而不是先经过 number。
test('IEC61850 点映射页面使用字符串输入并保留十进制原文', () => {
  assert.match(pageSource, /table\.points\.map\(normalizeIec61850PointEngineeringFields\)/);
  assert.match(pageSource, /getIec61850PointEngineeringError\(point\)/);
  assert.match(pageSource, /createIec61850EngineeringFields\(DEFAULT_IEC61850_ENGINEERING_DECIMALS\)/);
  assert.equal((pageSource.match(/<InputNumber<string>/g) ?? []).length, 1);
  assert.equal((pageSource.match(/stringMode/g) ?? []).length >= 1, true);
  for (const field of ['scale', 'offset', 'deadband']) {
    assert.match(pageSource, new RegExp(`renderEngineeringInput\\('${field}'`));
  }
  assert.match(browserSource, /normalizeIec61850PointEngineeringFields/);
  assert.match(browserSource, /points\.map\(normalizeIec61850PointEngineeringFields\)/);
});
