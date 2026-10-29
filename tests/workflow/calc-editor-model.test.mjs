import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultItem, draftFromItem, itemToConfig, validateDraft, formula } from '../../src/pages/Calc/editor-model.ts';
const source = (tag) => ({ module_name: 'ModbusRTU', conn_name: '逆变器', tag });
const bus = { source_kind: 1, constant: null };
const item = { item_name: '总功率', operator_kind: 9, left_operand: null, right_operand: null, operands: [bus,bus,bus] };
const route = (tag, index) => ({ src: source(tag), dst: { module_name:'Calc',conn_name:'组',tag:`总功率/input_${index}` } });

// 删除中间输入后来源随行移动，序列化配置不泄漏上位机路由草稿字段。
test('calc draft retains source identity after middle input deletion', () => {
  const draft=draftFromItem('组',item,[route('A',1),route('B',2),route('C',3)]);
  draft.inputs.splice(1,1);
  assert.deepEqual(draft.inputs.map(x=>x.sources[0].tag),['A','C']);
  assert.equal(itemToConfig(draft).operands.length,2);
  assert.equal(JSON.stringify(itemToConfig(draft)).includes('sources'),false);
});
// 完整读取已有多源以及一源多目标，避免首次保存缩减已有路由。
test('calc draft loads every existing input and output binding', () => {
  const output={src:{module_name:'Calc',conn_name:'组',tag:'总功率/result'},dst:source('target')};
  const draft=draftFromItem('组',item,[route('A',1),route('B',1),output]);
  assert.equal(draft.inputs[0].sources.length,2);assert.equal(draft.outputs.length,1);
});
// 未选点不能保存；空白常量和零除数须按原有规则拒绝。
test('calc validates required points decimal text and division by zero', () => {
  const draft=defaultItem('换算');assert.match(validateDraft(draft),/输入1/);
  draft.inputs[0].sources=[source('A')];draft.inputs[1]={sourceKind:2,constantType:'decimal',constantValue:'',sources:[]};
  assert.ok(validateDraft(draft));draft.inputs[1].constantValue='0';draft.operatorKind=4;
  assert.match(validateDraft(draft),/除数/);draft.inputs[1].constantValue='0.001';assert.equal(validateDraft(draft),null);
});
// 公式摘要必须保留精确常量文本，不能将0.001格式化为0.00。
test('calc formula preserves decimal constants exactly', () => {
  const draft=defaultItem('换算');draft.operatorKind=3;draft.inputs[0].sources=[source('功率')];
  draft.inputs[1]={sourceKind:2,constantType:'decimal',constantValue:'0.001',sources:[]};
  assert.match(formula(draft),/0\.001$/);assert.equal(itemToConfig(draft).right_operand.constant.decimal_value,'0.001');
});
// NOT只产生一个输入标签，AVERAGE精度只在平均运算时写入。
test('calc config handles unary operations and average precision', () => {
  const draft=defaultItem('状态');draft.operatorKind=5;draft.inputs=draft.inputs.slice(0,1);
  assert.equal(itemToConfig(draft).right_operand,null);
  draft.operatorKind=10;draft.decimalPlaces=2;assert.equal(itemToConfig(draft).decimal_places,2);
  draft.operatorKind=9;assert.equal(itemToConfig(draft).decimal_places,undefined);
});

// 清空整数输入不得被 Number('') 静默解释为零。
test('calc integer constants reject empty text and fractions', () => {
  const draft=defaultItem('换算');draft.inputs[0].sources=[source('A')];
  draft.inputs[1]={sourceKind:2,constantType:'int',constantValue:'',sources:[]};
  assert.match(validateDraft(draft),/整数/);
  draft.inputs[1].constantValue='1.2';assert.match(validateDraft(draft),/整数/);
  draft.inputs[1].constantValue='-12';assert.equal(validateDraft(draft),null);
});
