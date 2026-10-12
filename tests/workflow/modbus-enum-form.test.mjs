import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import { createEmptyWorkspace } from '../../src/offline/workspace/types.ts';
import { parseWorkspace, serializeWorkspace } from '../../src/offline/workspace/serialize.ts';
import {
  getModbusBoolMode, createModbusBoolFields, getModbusBoolFieldError, formatModbusBoolSource,
} from '../../src/pages/ModbusRTU/modbus-form-rules.ts';

const registerBool = { function: 2, data_type: 1, reg_count: 1, bit_index: null };

test('旧位点继续使用位解析，枚举零值编辑及复制后仍按整字相等解析', () => {
  assert.equal(getModbusBoolMode({ bit_index: 0 }), 'bit');
  for (const enumValue of [0, 65535]) {
    const source = { ...registerBool, enum_value: enumValue };
    const edited = { ...source, bool_mode: getModbusBoolMode(source) };
    assert.deepEqual(createModbusBoolFields(edited), { bit_index: null, enum_value: enumValue });
    assert.equal(getModbusBoolFieldError(edited), null);
    assert.equal(formatModbusBoolSource(source), `相等值 ${enumValue}`);
  }
  assert.equal(formatModbusBoolSource({ bit_index: 0 }), '位 0');
});

test('切换BOOL解析模式仅保存当前模式字段，离开寄存器BOOL清除解析字段', () => {
  const both = { ...registerBool, bit_index: 3, enum_value: 0 };
  assert.deepEqual(createModbusBoolFields({ ...both, bool_mode: 'bit' }), { bit_index: 3, enum_value: null });
  assert.deepEqual(createModbusBoolFields({ ...both, bool_mode: 'enum' }), { bit_index: null, enum_value: 0 });
  for (const patch of [{ function: 1 }, { function: 4 }, { data_type: 2 }]) {
    assert.deepEqual(createModbusBoolFields({ ...both, ...patch }), { bit_index: null, enum_value: null });
  }
});

test('等值解析和位解析校验整数及16/32位边界，不允许空等值', () => {
  for (const enumValue of [null, -1, 1.5, 65536, Infinity]) {
    assert.match(getModbusBoolFieldError({ ...registerBool, bool_mode: 'enum', enum_value: enumValue }), /相等值/);
  }
  assert.equal(getModbusBoolFieldError({ ...registerBool, reg_count: 2, bool_mode: 'enum', enum_value: 4294967295 }), null);
  assert.match(getModbusBoolFieldError({ ...registerBool, reg_count: 2, bool_mode: 'enum', enum_value: 4294967296 }), /相等值/);
  assert.match(getModbusBoolFieldError({ ...registerBool, bool_mode: 'bit', bit_index: 16 }), /位索引/);
  assert.equal(getModbusBoolFieldError({ ...registerBool, reg_count: 2, bool_mode: 'bit', bit_index: 31 }), null);
});

test('RTU/TCP编辑和复制保留枚举模式且保存经过统一校验和互斥字段转换', () => {
  for (const protocol of ['ModbusRTU', 'ModbusTCP']) {
    const source = readFileSync(new URL(`../../src/pages/${protocol}/index.tsx`, import.meta.url), 'utf8');
    assert.equal((source.match(/enum_value: point\.enum_value \?\? null/g) ?? []).length, 2);
    assert.equal((source.match(/bool_mode: getModbusBoolMode\(point\)/g) ?? []).length, 2);
    assert.match(source, /getModbusBoolFieldError\(values\)/);
    assert.match(source, /\.\.\.createModbusBoolFields\(values\)/);
    assert.match(source, /label="相等值"/);
    assert.match(source, /name="bool_mode"/);
  }
  const table = readFileSync(new URL('../../src/pages/ModbusRTU/components/PointTable.tsx', import.meta.url), 'utf8');
  assert.match(table, /formatModbusBoolSource\(record\)/);
});

test('离线和浏览器适配器规范化以及工作区导出重载保留枚举零值', () => {
  const point = { ...registerBool, tag: '停机', address: 5000, enum_value: 0, scale: 1, offset: 0, deadband: 0 };
  for (const [file, start, end, name] of [
    ['src/offline/adapter/workspace-api.ts', 'function normalizeModbusPoint(', 'function normalizeDlt645Point(', 'normalizeModbusPoint'],
    ['src/adapters/browser.ts', 'const normalizeBrowserModbusPoint =', 'const normalizeBrowserDlt645Point =', 'normalizeBrowserModbusPoint'],
  ]) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    assert.ok(startIndex >= 0 && endIndex > startIndex);
    const normalize = new Function(stripTypeScriptTypes(source.slice(startIndex, endIndex)) + `\nreturn ${name};`)();
    const normalized = normalize(point);
    assert.equal(normalized.enum_value, 0);
    assert.equal(normalized.bit_index, null);
    const workspace = createEmptyWorkspace('阳光枚举回归');
    for (const section of ['modbus_rtu', 'modbus_tcp']) {
      workspace.config[section].links = [{
        link: { config: { conn_name: '逆变器' } },
        point_table: { conn_name: '逆变器', points: [normalized], replace: true },
      }];
    }
    const restored = parseWorkspace(serializeWorkspace(workspace));
    for (const section of ['modbus_rtu', 'modbus_tcp']) {
      assert.deepEqual(restored.config[section].links[0].point_table.points[0], normalized);
    }
  }
});

test('寄存器BOOL表单可编辑字节序，双寄存器可编辑字序，不显示工程量换算', () => {
  for (const protocol of ['ModbusRTU', 'ModbusTCP']) {
    const source = readFileSync(new URL(`../../src/pages/${protocol}/index.tsx`, import.meta.url), 'utf8');
    const boolStart = source.indexOf('{isRegisterBoolPoint ? (');
    const numericStart = source.indexOf('{pointDataType !== MODBUS_DATA_TYPE.BOOL ? (', boolStart);
    assert.ok(boolStart >= 0 && numericStart > boolStart);
    const boolEditor = source.slice(boolStart, numericStart);
    assert.match(boolEditor, /name="byte_order"/);
    assert.match(boolEditor, /pointRegCount === 2 \? \([\s\S]*name="word_order"/);
    assert.doesNotMatch(boolEditor, /name="(?:scale|offset)"/);
  }
});
