import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileNamedExpression, displayNamedExpression, hasNamedReference, namedInputs, renameNamedReferences } from '../../src/pages/Calc/named-expression.ts';

const point = (tag, conn_name = '逆变器', module_name = 'Modbus') => ({ module_name, conn_name, tag });
const bus = (...sources) => ({ sourceKind: 1, constantValue: false, sources });

test('quoted point names round trip without interpreting their contents as operators', () => {
  const names = ['启停 \\路径"与" (备用)', 'OR', '就绪\n反馈'];
  const display = displayNamedExpression('(a&&b) || NOT C', names);
  assert.equal(display, `(${JSON.stringify(names[0])} 与 "OR") 或 非 ${JSON.stringify(names[2])}`);
  const result = compileNamedExpression(display, names);
  assert.equal(result.error, null);
  assert.equal(displayNamedExpression(result.expression, names), display);
  assert.equal(compileNamedExpression(`${JSON.stringify(names[0])} xor ("OR" || !${JSON.stringify(names[2])})`, names).error, null);
});

test('duplicate point names use connection and module names without taking actual point names', () => {
  const inputs = [bus(point('开关', '一号')), bus(point('开关', '二号')), bus(point('开关', '二号', '其他模块')),
    bus(point('一号 / 开关')), bus(point('开关', '二号', '其他模块')), bus(), bus(point('甲'), point('乙')),
    { sourceKind: 2, constantValue: true, sources: [] }, bus(point('常量（真）'))];
  const names = namedInputs(inputs);
  assert.equal(new Set(names).size, inputs.length);
  assert.equal(names[3], '一号 / 开关');
  assert.equal(names[8], '常量（真）');
  assert.match(names[0], /一号/);
  assert.match(names[1], /Modbus.*二号/);
  assert.match(names[2], /其他模块.*二号/);
  assert.match(names[4], /其他模块.*二号/);
  assert.match(names[5], /未选择点位/);
  assert.match(names[6], /多来源/);
  assert.match(names[7], /常量/);
  assert.deepEqual(namedInputs(inputs), names);
});

test('unquoted aliases, unknown names and unused inputs get point name diagnostics', () => {
  const names = ['就绪', '闭锁'];
  assert.match(compileNamedExpression('A AND B', names).error, /双引号/);
  assert.match(compileNamedExpression('"就绪" 与 "不存在"', names).error, /不存在/);
  assert.match(compileNamedExpression('"就绪"', names).error, /未引用输入 "闭锁"/);
  assert.ok(compileNamedExpression('"就绪" "闭锁"', names).error);
  assert.match(compileNamedExpression('"就绪" 或 "闭锁', names).error, /结束双引号/);
  assert.match(compileNamedExpression(String.raw`"就绪\q"`, names).error, /转义/);
});

test('quoted references are renamed simultaneously without touching prefixes or malformed text', () => {
  const first = '回路 "1"', second = '回路 "1" 延时';
  const text = `${JSON.stringify(first)} 与 ${JSON.stringify(second)} 或 "未更改" 或 "未结束`;
  assert.equal(renameNamedReferences(text, [first, second, '未更改'], [second, first, undefined]),
    `${JSON.stringify(second)} 与 ${JSON.stringify(first)} 或 "未更改" 或 "未结束`);
  assert.equal(hasNamedReference(text, first), true);
  assert.equal(hasNamedReference(text, '回路'), false);
  assert.equal(hasNamedReference(text, '未结束'), false);
  assert.equal(hasNamedReference(String.raw`"\u56de\u8def" 或`, '回路'), true);
});
