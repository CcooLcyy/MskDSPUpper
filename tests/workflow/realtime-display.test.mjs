import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { formatDecimalDisplay, formatAutoRealtimeNumber } from '../../src/utils/realtime-value.ts';
import { draftFromItem, formula, itemToConfig } from '../../src/pages/Calc/editor-model.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const dataBusSource = read('../../src/pages/DataBus/index.tsx');
const agcSource = read('../../src/pages/AGC/index.tsx');
const avcSource = read('../../src/pages/AVC/index.tsx');
const protocolRealtimeSource = read('../../src/components/protocol/protocol-realtime.tsx');
const iec104Source = read('../../src/pages/IEC104/index.tsx');
const modbusPointTableSource = read('../../src/pages/ModbusRTU/components/PointTable.tsx');
const dlt645PointTableSource = read('../../src/pages/DLT645/components/PointTable.tsx');
const controlValueSource = read('../../src/utils/control-point-value.ts');

// 验证 Decimal 文本在展示层精确四舍五入到两位，不经过 JavaScript number。
test('Decimal 展示使用精确两位小数规则', () => {
  assert.equal(formatDecimalDisplay('1'), '1.00');
  assert.equal(formatDecimalDisplay('1.235'), '1.24');
  assert.equal(formatDecimalDisplay('-1.235'), '-1.24');
  assert.equal(formatDecimalDisplay('0.12345678901234567890'), '0.12');
  assert.equal(formatDecimalDisplay('1e-20'), '0.00');
  assert.equal(formatDecimalDisplay('-0.004'), '0.00');
  assert.equal(formatDecimalDisplay('1.2e2'), '120.00');
});

// 验证非法文本不会在只读展示层被静默转换或丢失。
test('非法 Decimal 展示保留原文', () => {
  assert.equal(formatDecimalDisplay('not-a-decimal'), 'not-a-decimal');
  assert.equal(formatDecimalDisplay(''), '');
});

// 验证旧 Double 实时值展示统一为两位小数，同时处理负零。
test('Double 实时值展示固定两位小数', () => {
  assert.equal(formatAutoRealtimeNumber(1), '1.00');
  assert.equal(formatAutoRealtimeNumber(1.235), '1.24');
  assert.equal(formatAutoRealtimeNumber(-0), '0.00');
});

// 验证工程量实时值入口均调用公共展示规则，且编辑命令仍保留 Decimal 原文。
test('真实业务展示链路使用公共两位小数工具', () => {
  for (const source of [dataBusSource, agcSource, avcSource, protocolRealtimeSource]) {
    assert.match(source, /formatDecimalDisplay/);
    assert.match(source, /formatAutoRealtimeNumber/);
  }
  assert.match(iec104Source, /formatAutoRealtimeNumber\(record\.double_value\)/);
  assert.doesNotMatch(controlValueSource, /formatDecimalDisplay/);
  assert.match(controlValueSource, /return \{ type: 'Decimal', value: text \}/);
});

// 公式表示配置本身，常量原文必须保留，避免把0.001误显示为0.00。
test('数值计算公式与保存配置保留精确常量原文', () => {
  for (const text of ['0.001', '0.12345678901234567890', '-0.00000000000000000001', '1e-20']) {
    const item = {
      item_name: '功率换算', operator_kind: 3,
      left_operand: { source_kind: 1, constant: null },
      right_operand: { source_kind: 2, constant: { decimal_value: text } }, operands: [],
    };
    const routes = [{
      src: { module_name: 'ModbusRTU', conn_name: '逆变器', tag: '有功功率' },
      dst: { module_name: 'Calc', conn_name: '计算组', tag: '功率换算/left_input' },
    }];
    const draft = draftFromItem('计算组', item, routes);
    assert.equal(draft.inputs[1].constantValue, text);
    assert.equal(formula(draft), `逆变器 / 有功功率 × ${text}`);
    assert.equal(itemToConfig(draft).right_operand.constant.decimal_value, text);
  }
});

// 验证协议点表的只读工程量列统一按两位小数展示，同时保留编辑控件的原始文本。
test('协议点表配置列使用公共两位小数工具', () => {
  for (const source of [iec104Source, modbusPointTableSource, dlt645PointTableSource]) {
    assert.match(source, /formatDecimalDisplay/);
    assert.match(source, /formatDecimalDisplay\(resolve[^\n]+DecimalText\(record, 'scale'\)\)/);
    assert.match(source, /formatDecimalDisplay\(resolve[^\n]+DecimalText\(record, 'offset'\)\)/);
    assert.match(source, /formatDecimalDisplay\(resolve[^\n]+DecimalText\(record, 'deadband'\)\)/);
  }
  assert.match(dlt645PointTableSource, /formatDecimalDisplay\(resolveDlt645EngineeringDecimalText\(record, 'scale'\)\)/);
  assert.match(dlt645PointTableSource, /formatDecimalDisplay\(resolveDlt645EngineeringDecimalText\(record, 'offset'\)\)/);
  assert.match(dlt645PointTableSource, /formatDecimalDisplay\(resolveDlt645EngineeringDecimalText\(record, 'deadband'\)\)/);
});
