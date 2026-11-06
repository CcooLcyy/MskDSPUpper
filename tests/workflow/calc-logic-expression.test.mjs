import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputAlias, validateExpression, expressionPreview, removeExpressionInput } from '../../src/pages/Calc/logic-expression.ts';

// 别名跨越 Z 后保持唯一，允许大小写不敏感的混合运算和符号形式。
test('calc logic expression accepts mixed operators and Excel aliases', () => {
  assert.equal(inputAlias(25), 'Z'); assert.equal(inputAlias(26), 'AA'); assert.equal(inputAlias(255), 'IV');
  assert.equal(validateExpression('(a AND B) OR NOT C', 3), null);
  assert.equal(validateExpression('!(A && B) || C ^ A', 3), null);
  assert.equal(expressionPreview('(A AND B) OR NOT C'), '(A 与 B) 或 非 C');
});
// 未引用和越界变量、缺少操作数/运算符、未闭合括号均禁止保存。
test('calc logic expression rejects malformed and ambiguous inputs', () => {
  for (const text of ['', 'A B', 'A AND', 'AND A', '(A', 'A)', 'A & B', 'A ||| B', 'A OR C', 'A OR NOT']) {
    assert.ok(validateExpression(text, 2), text);
  }
  assert.match(validateExpression('A', 2), /B/);
  assert.equal(validateExpression('NOT A', 1), null);
});
// 表达式长度、输入数量和递归深度均有确定边界，避免解析资源失控。
test('calc logic expression enforces resource limits', () => {
  assert.ok(validateExpression('A', 257));
  assert.ok(validateExpression(' '.repeat(4096) + 'A', 1));
  assert.equal(validateExpression('('.repeat(64) + 'A' + ')'.repeat(64), 1), null);
  assert.ok(validateExpression('('.repeat(65) + 'A' + ')'.repeat(65), 1));
  assert.ok(validateExpression('!'.repeat(65) + 'A', 1));
  assert.ok(validateExpression('A\u00a0OR B', 2));
});
// 不能删除被引用输入；删除未引用行后变量跟随原来源重编号。
test('calc expression deletion preserves referenced input identity', () => {
  assert.equal(removeExpressionInput('A OR C', 0), null);
  assert.equal(removeExpressionInput('A OR C', 1), 'A OR B');
  assert.equal(removeExpressionInput('AA AND B', 0), 'Z AND A');
});
