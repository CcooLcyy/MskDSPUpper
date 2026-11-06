import type { CalcItemConfig, CalcOperandSpec, DcEndpoint, DcRoute } from '../../adapters';
import { calcInputTags } from '../../utils/calc-routing.ts';
import { expressionPreview, validateExpression } from './logic-expression.ts';
import { getDecimalTextError, isDecimalTextZero } from '../../utils/decimal-input.ts';

export const operators = [
  { label: '加法（+）', value: 1 }, { label: '减法（−）', value: 2 },
  { label: '乘法（×）', value: 3 }, { label: '除法（÷）', value: 4 },
  { label: '非（NOT）', value: 5 }, { label: '与（AND）', value: 6 },
  { label: '或（OR）', value: 7 }, { label: '异或（XOR）', value: 8 },
  { label: '逻辑表达式', value: 11 },
  { label: '求和（SUM）', value: 9 }, { label: '求平均（AVERAGE）', value: 10 },
];
export type OperandDraft = {
  sourceKind: number;
  constantType: 'bool' | 'int' | 'decimal';
  constantValue: boolean | number | string;
  sources: DcEndpoint[];
};
export type ItemDraft = {
  itemName: string;
  operatorKind: number;
  inputs: OperandDraft[];
  outputs: DcEndpoint[];
  decimalPlaces?: number;
  expression?: string;
  useOperandList?: boolean;
};
export const isAggregate = (kind: number) => kind === 9 || kind === 10;
export const isLogic = (kind: number) => (kind >= 5 && kind <= 8) || kind === 11;
export const isMultiInput = (kind: number) => isAggregate(kind) || (kind >= 6 && kind <= 8) || kind === 11;
const usesOperandList = (draft: ItemDraft) => isAggregate(draft.operatorKind) || draft.operatorKind === 11 || ((draft.operatorKind >= 6 && draft.operatorKind <= 8) && (draft.inputs.length > 2 || Boolean(draft.useOperandList)));
export const endpointKey = (point: DcEndpoint): string => JSON.stringify([point.module_name, point.conn_name, point.tag]);
export const endpointLabel = (point: DcEndpoint): string => `${point.module_name} / ${point.conn_name} / ${point.tag}`;
export const defaultOperand = (): OperandDraft => ({ sourceKind: 1, constantType: 'decimal', constantValue: '0', sources: [] });
/** 切换到常量来源时按运算类型归一化，避免隐藏的旧类型造成无法保存。 */
export function changeOperandSource(input: OperandDraft, sourceKind: number, operatorKind: number): OperandDraft {
  if (sourceKind !== 2) return { ...input, sourceKind };
  if (isLogic(operatorKind)) return { ...input, sourceKind, constantType: 'bool', constantValue: input.constantType === 'bool' ? Boolean(input.constantValue) : false };
  return input.constantType === 'bool' ? { ...input, sourceKind, constantType: 'decimal', constantValue: '0' } : { ...input, sourceKind };
}
export const defaultItem = (name: string): ItemDraft => ({ itemName: name, operatorKind: 1, inputs: [defaultOperand(), defaultOperand()], outputs: [] });
export const configuredOperands = (item: CalcItemConfig): CalcOperandSpec[] => isAggregate(item.operator_kind) || item.operator_kind === 11 || (item.operator_kind >= 6 && item.operator_kind <= 8 && item.operands.length > 0)
  ? item.operands : [item.left_operand, ...(item.operator_kind === 5 ? [] : [item.right_operand])].filter((operand): operand is CalcOperandSpec => Boolean(operand));

/** 路由绑定跟随输入草稿，删除中间行时不按旧下标重新猜测来源。 */
export function draftFromItem(groupName: string, item: CalcItemConfig, routes: DcRoute[]): ItemDraft {
  const tags = calcInputTags(item);
  const own = (point: DcEndpoint, tag: string) => point.module_name === 'Calc' && point.conn_name === groupName && point.tag === tag;
  return {
    itemName: item.item_name, operatorKind: item.operator_kind, decimalPlaces: item.decimal_places, expression: item.expression, useOperandList: item.operands.length > 0,
    inputs: configuredOperands(item).map((operand, index) => {
      const constant = operand.constant;
      const constantType = constant?.bool_value !== undefined || (operand.source_kind === 1 && isLogic(item.operator_kind)) ? 'bool' : constant?.int_value !== undefined ? 'int' : 'decimal';
      return { sourceKind: operand.source_kind, constantType,
        constantValue: constant?.bool_value ?? constant?.int_value ?? constant?.decimal_value ?? (constantType === 'bool' ? false : String(constant?.double_value ?? '0')),
        sources: routes.filter((route) => own(route.dst, tags[index])).map((route) => route.src) };
    }),
    outputs: routes.filter((route) => own(route.src, `${item.item_name}/result`)).map((route) => route.dst),
  };
}

export function itemToConfig(draft: ItemDraft): CalcItemConfig {
  const operands = draft.inputs.map((input): CalcOperandSpec => input.sourceKind === 1 ? { source_kind: 1, constant: null }
    : { source_kind: 2, constant: input.constantType === 'bool' ? { bool_value: Boolean(input.constantValue) }
      : input.constantType === 'int' ? { int_value: Number(input.constantValue) } : { decimal_value: String(input.constantValue) } });
  const list = usesOperandList(draft);
  return { item_name: draft.itemName.trim(), operator_kind: draft.operatorKind,
    left_operand: list ? null : operands[0],
    right_operand: list || draft.operatorKind === 5 ? null : operands[1],
    operands: list ? operands : [], expression: draft.operatorKind === 11 ? draft.expression?.trim() : undefined, decimal_places: draft.operatorKind === 10 ? draft.decimalPlaces : undefined };
}

export function validateDraft(draft: ItemDraft): string | null {
  if (!draft.itemName.trim()) return '请输入计算项名称';
  if (draft.itemName.includes('/')) return '计算项名称不能包含 /';
  if (isLogic(draft.operatorKind) && draft.inputs.length > 256) return '逻辑运算最多支持 256 个输入';
  if (isMultiInput(draft.operatorKind) && draft.operatorKind !== 11 && draft.inputs.length < 2) return '此运算至少需要两个输入';
  if (draft.operatorKind === 11) { const error = validateExpression(draft.expression ?? '', draft.inputs.length); if (error) return error; }
  if (!usesOperandList(draft) && !draft.inputs.some((input) => input.sourceKind === 1)) return '至少保留一个输入使用数据总线点位';
  for (const [index, input] of draft.inputs.entries()) {
    if (input.sourceKind === 1) {
      if (!input.sources.length) return `请选择输入${index + 1}关联点位`;
    } else {
      if (isLogic(draft.operatorKind) !== (input.constantType === 'bool')) return isLogic(draft.operatorKind) ? '逻辑运算常量必须为布尔值' : '数值运算不能使用布尔常量';
      if (input.constantType === 'decimal') { const error = getDecimalTextError(String(input.constantValue), '精确十进制常量'); if (error) return error; }
      if (input.constantType === 'int' && (!/^[+-]?\d+$/.test(String(input.constantValue).trim()) || !Number.isSafeInteger(Number(input.constantValue)))) return '请填写安全范围内的整数，超出范围请改用精确十进制';
      if (draft.operatorKind === 4 && index === 1 && isDecimalTextZero(String(input.constantValue))) return '除数不能为 0';
    }
  }
  if (draft.operatorKind === 10 && draft.decimalPlaces !== undefined && (!Number.isInteger(draft.decimalPlaces) || draft.decimalPlaces < 0 || draft.decimalPlaces > 20)) return '平均值小数位数必须为 0 到 20 的整数';
  return null;
}

export function formula(draft: ItemDraft): string {
  const inputs = draft.inputs.map((input, index) => input.sourceKind === 1
    ? input.sources.length === 1 ? `${input.sources[0].conn_name} / ${input.sources[0].tag}` : input.sources.length > 1 ? `输入${index + 1}（${input.sources.length} 个来源）` : `输入${index + 1}`
    : input.constantType === 'bool' ? input.constantValue ? '真' : '假' : String(input.constantValue));
  if (draft.operatorKind === 11) return expressionPreview(draft.expression ?? '');
  if (isAggregate(draft.operatorKind)) return `${draft.operatorKind === 9 ? 'SUM' : 'AVERAGE'}(${inputs.join('、')})`;
  if (draft.operatorKind === 5) return `NOT(${inputs[0]})`;
  const symbols: Record<number, string> = { 1: '+', 2: '−', 3: '×', 4: '÷', 6: 'AND', 7: 'OR', 8: 'XOR' };
  return inputs.join(` ${symbols[draft.operatorKind] ?? '?'} `);
}
