import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultItem, draftFromItem, itemToConfig, validateDraft, formula, changeOperandSource, removeDraftInput, replaceDraftInputs } from '../../src/pages/Calc/editor-model.ts';
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

// 旧二元逻辑保持左右输入，第三个输入转换为独立列表，列表配置也应原样保存。
test('calc logic preserves binary representation and supports multiple inputs', () => {
  const legacy = { item_name: '状态', operator_kind: 6, left_operand: bus, right_operand: bus, operands: [] };
  const draft = draftFromItem('组', legacy, []);
  assert.deepEqual(itemToConfig(draft).operands, []);
  assert.deepEqual(itemToConfig(draft).left_operand, bus);
  draft.inputs.push({ ...draft.inputs[0] });
  assert.equal(itemToConfig(draft).operands.length, 3);
  assert.equal(itemToConfig(draft).left_operand, null);
  const loaded = draftFromItem('组', { ...legacy, left_operand: null, right_operand: null, operands: [bus, bus] }, []);
  assert.equal(itemToConfig(loaded).operands.length, 2);
});

// 表达式保持原文本、布尔常量和独立输入，数值常量不能混入逻辑表达式。
test('calc expression draft persists expression and validates Boolean inputs', () => {
  const draft = defaultItem('联锁'); draft.operatorKind = 11; draft.expression = ' A OR NOT B ';
  draft.inputs[0].sources = [source('开关')];
  draft.inputs[1] = { sourceKind: 2, constantType: 'bool', constantValue: false, sources: [] };
  assert.equal(validateDraft(draft), null);
  assert.equal(itemToConfig(draft).expression, 'A OR NOT B');
  assert.equal(itemToConfig(draft).operands.length, 2);
  assert.equal(itemToConfig(draft).right_operand, null);
  assert.match(formula(draft), /"开关"\s+或\s+非\s*"常量[^"]*假[^"]*"/);
  draft.inputs[1].constantType = 'decimal';
  assert.match(validateDraft(draft), /布尔/);
});

// 编辑点位名称后沿用输入槽位，保留原有逻辑和点位身份。
test('calc expression follows a renamed or reselected point without moving operands', () => {
  const draft = defaultItem('联锁');
  draft.operatorKind = 11;
  draft.namedExpression = '"并网运行" 与 非 "过压"';
  draft.inputs[0].sources = [source('并网运行')];
  draft.inputs[1].sources = [source('过压')];
  assert.equal(removeDraftInput(draft, 0), null);
  const spare = { ...draft.inputs[0], sources: [source('备用')] };
  const withSpare = { ...draft, inputs: [draft.inputs[0], spare, draft.inputs[1]] };
  const revised = replaceDraftInputs(withSpare, [
    { ...draft.inputs[0], sources: [source('远方运行')] }, spare, draft.inputs[1],
  ]);
  const trimmed = removeDraftInput(revised, 1);
  assert.equal(trimmed.namedExpression, '"远方运行" 与 非 "过压"');
  assert.equal(validateDraft(trimmed), null);
  assert.match(itemToConfig(trimmed).expression, /^A\s*&&\s*!\s*B$/);
});

// 新的输入列表和表达式允许全布尔常量，旧左右二元配置仍保留总线输入要求。
test('calc list logic accepts constants while legacy binary keeps its bus requirement', () => {
  const draft = defaultItem('逻辑'); draft.operatorKind = 6;
  draft.inputs = Array.from({ length: 2 }, () => ({ sourceKind: 2, constantType: 'bool', constantValue: true, sources: [] }));
  assert.match(validateDraft(draft), /总线/);
  draft.useOperandList = true;
  assert.equal(validateDraft(draft), null);
  draft.operatorKind = 11; draft.expression = 'A AND B';
  assert.equal(validateDraft(draft), null);
});

// 逻辑点位转常量时必须提供布尔默认值，不能留下不可选择的十进制类型。
test('calc operand source switching normalizes constants for the operation', () => {
  const input = defaultItem('逻辑').inputs[0];
  for (const kind of [5, 6, 7, 8, 11]) {
    const next = changeOperandSource(input, 2, kind);
    assert.equal(next.constantType, 'bool'); assert.equal(next.constantValue, false); assert.equal(next.sourceKind, 2);
  }
  const numeric = { ...input, constantType: 'decimal', constantValue: '0.001' };
  assert.equal(changeOperandSource(numeric, 2, 1).constantValue, '0.001');
  const logical = { ...input, constantType: 'bool', constantValue: true };
  assert.equal(changeOperandSource(logical, 2, 6).constantValue, true);
  assert.equal(changeOperandSource(logical, 2, 1).constantType, 'decimal');
  assert.equal(changeOperandSource(logical, 2, 1).constantValue, '0');
  const loaded = draftFromItem('组', { item_name: '旧逻辑', operator_kind: 6, left_operand: bus, right_operand: bus, operands: [] }, []);
  assert.equal(loaded.inputs[0].constantType, 'bool');
  assert.equal(loaded.inputs[0].constantValue, false);
});
