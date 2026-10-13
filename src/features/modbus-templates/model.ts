import type { ModbusPoint } from '../../adapters/types.ts';
import { getAllowedRegCountsForFunction, MODBUS_DATA_TYPE } from '../../pages/ModbusRTU/modbus-form-rules.ts';
import { createModbusEngineeringFields, resolveModbusPointDecimalText } from '../../pages/ModbusRTU/modbus-decimal.ts';
import { getDecimalTextError } from '../../utils/decimal-input.ts';

export const MAX_TEMPLATE_POINTS = 10000;
export const MAX_TEMPLATE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PERSONAL_TEMPLATES = 100;
export const MAX_PERSONAL_TEMPLATE_BYTES = 50 * 1024 * 1024;
export type TemplateDataType = keyof typeof MODBUS_DATA_TYPE;
export type TemplateFunctionCode = 1 | 3 | 4 | 5 | 6 | 16;
export interface ModbusTemplatePoint {
  id: string; tag: string; group: string; unit: string; function_code: TemplateFunctionCode;
  address: number; data_type: TemplateDataType; reg_count: number;
  scale: string; offset: string; deadband: string; word_order: 'HL' | 'LH'; byte_order: 'AB' | 'BA';
  bit_index: number | null; source_page: number; description: string;
  default_selected?: boolean; condition?: string; enum_value?: number | null;
}
export interface ModbusTemplate {
  schema_version: 1; id: string; name: string; manufacturer: string; models: string[];
  protocol_version: string; address_base: 0 | 1; notes: string[];
  sources: { file: string; sha256: string }[]; points: ModbusTemplatePoint[];
}
export interface TemplateApplicationRow {
  id: string; source: ModbusTemplatePoint; point: ModbusPoint; finalTag: string;
  conflict: string | null; selected: boolean;
}
export interface TemplateApplicationOptions {
  existingPoints: readonly ModbusPoint[]; addressBase: number; prefix?: string; selectedIds?: readonly string[];
}
const FUNCTION_TO_NATIVE: Record<TemplateFunctionCode, number> = { 1: 1, 3: 2, 4: 3, 6: 4, 16: 5, 5: 6 };
const TEMPLATE_FIELDS = ['schema_version', 'id', 'name', 'manufacturer', 'models', 'protocol_version', 'address_base', 'notes', 'sources', 'points'];
const POINT_FIELDS = ['id', 'tag', 'group', 'unit', 'function_code', 'address', 'data_type', 'reg_count', 'scale', 'offset', 'deadband', 'word_order', 'byte_order', 'bit_index', 'source_page', 'description'];

function object(value: unknown, fields: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!fields.includes(key) && !optional.includes(key)) throw new Error(`${label}包含未允许的字段：${key}`);
  for (const key of fields) if (!Object.hasOwn(result, key)) throw new Error(`${label}缺少字段：${key}`);
  return result;
}
function text(value: unknown, label: string, empty = false, max = 256): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) throw new Error(`${label}必须是有效文本（最多 ${max} 字符）`);
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label}必须是 ${min} 到 ${max} 的整数`);
  return value;
}
function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}必须是数组且最多 ${max} 项`);
  return value;
}
function decimal(value: unknown, label: string): string {
  const error = getDecimalTextError(value, label);
  if (error) throw new Error(error);
  if (!Number.isFinite(Number(value))) throw new Error(`${label}必须为有限数值`);
  return value as string;
}
export function validateModbusTemplate(input: unknown): ModbusTemplate {
  if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_TEMPLATE_FILE_BYTES) throw new Error('模板文件不能超过 10 MiB');
  const data = object(input, TEMPLATE_FIELDS, '模板');
  if (data.schema_version !== 1) throw new Error('不支持的模板版本');
  const id = text(data.id, '模板 ID', false, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new Error('模板 ID 仅支持字母、数字、下划线、点和连字符');
  const addressBase = integer(data.address_base, 0, 1, '地址基准') as 0 | 1;
  const ids = new Set<string>();
  const tags = new Set<string>();
  const points = array(data.points, '模板点位', MAX_TEMPLATE_POINTS).map((raw, index): ModbusTemplatePoint => {
    const item = object(raw, POINT_FIELDS, `第 ${index + 1} 个点位`, ['default_selected', 'condition', 'enum_value']);
    const pointId = text(item.id, '点位 ID', false, 128);
    const tag = text(item.tag, '点位标签');
    if (tag !== tag.trim()) throw new Error('点位标签首尾不能包含空白');
    if (ids.has(pointId) || tags.has(tag)) throw new Error('模板存在重复点位 ID 或标签');
    ids.add(pointId); tags.add(tag);
    const fc = integer(item.function_code, 1, 16, '功能码') as TemplateFunctionCode;
    if (!Object.hasOwn(FUNCTION_TO_NATIVE, fc)) throw new Error('模板包含不支持的功能码');
    if (typeof item.data_type !== 'string' || !Object.hasOwn(MODBUS_DATA_TYPE, item.data_type)) throw new Error('模板包含不支持的数据类型');
    const type = item.data_type as TemplateDataType;
    const regCount = integer(item.reg_count, 1, 2, '寄存器数量');
    if (!getAllowedRegCountsForFunction(FUNCTION_TO_NATIVE[fc], MODBUS_DATA_TYPE[type]).includes(regCount)) throw new Error('功能码、数据类型和寄存器数量不匹配');
    const address = integer(item.address, addressBase, 65535 + addressBase - regCount + 1, '点位地址');
    let bitIndex: number | null = null;
    if (item.bit_index !== null) bitIndex = integer(item.bit_index, 0, regCount * 16 - 1, '位索引');
    if (type !== 'BOOL' && bitIndex !== null) throw new Error('仅 BOOL 点位允许位索引');
    if ((fc === 1 || fc === 5) && bitIndex !== null) throw new Error('线圈点位不使用寄存器位索引');
    const enumValue = item.enum_value == null ? null : integer(item.enum_value, 0, regCount === 1 ? 65535 : 4294967295, '枚举相等值');
    if (enumValue !== null && (type !== 'BOOL' || (fc !== 3 && fc !== 4) || bitIndex !== null)) throw new Error('枚举相等值仅支持只读寄存器 BOOL，且不能同时配置位索引');
    if ((item.word_order !== 'HL' && item.word_order !== 'LH') || (item.byte_order !== 'AB' && item.byte_order !== 'BA')) throw new Error('字序或字节序不合法');
    if (Object.hasOwn(item, 'default_selected') && typeof item.default_selected !== 'boolean') throw new Error('默认选择标记必须为布尔值');
    const condition = Object.hasOwn(item, 'condition') ? text(item.condition, '适用条件', true, 4096) : undefined;
    return { id: pointId, tag, group: text(item.group, '分组', true), unit: text(item.unit, '单位', true, 64), function_code: fc,
      address, data_type: type, reg_count: regCount, scale: decimal(item.scale, '倍率'), offset: decimal(item.offset, '偏移'), deadband: decimal(item.deadband, '死区'),
      word_order: item.word_order, byte_order: item.byte_order, bit_index: bitIndex,
      source_page: integer(item.source_page, 0, 100000, '来源页码'), description: text(item.description, '点位说明', true, 4096),
      ...(Object.hasOwn(item, 'enum_value') ? { enum_value: enumValue } : {}),
      ...(typeof item.default_selected === 'boolean' ? { default_selected: item.default_selected } : {}), ...(condition !== undefined ? { condition } : {}) };
  });
  if (!points.length) throw new Error('模板至少需要一个点位');
  return { schema_version: 1, id, name: text(data.name, '模板名称'), manufacturer: text(data.manufacturer, '厂家', true),
    models: array(data.models, '型号', 100).map(value => text(value, '型号')),
    protocol_version: text(data.protocol_version, '协议版本', true), address_base: addressBase,
    notes: array(data.notes, '说明', 100).map(value => text(value, '说明', false, 4096)),
    sources: array(data.sources, '来源', 20).map(raw => {
      const source = object(raw, ['file', 'sha256'], '来源');
      const sha256 = text(source.sha256, '来源 SHA256', false, 64);
      if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error('来源 SHA256 格式不合法');
      return { file: text(source.file, '来源文件名', false, 512), sha256 };
    }), points };
}
export function parseModbusTemplateJson(value: string): ModbusTemplate {
  if (new TextEncoder().encode(value).length > MAX_TEMPLATE_FILE_BYTES) throw new Error('模板文件不能超过 10 MiB');
  let parsed: unknown;
  try { parsed = JSON.parse(value.replace(/^\uFEFF/, '')); } catch { throw new Error('模板文件不是合法 JSON'); }
  return validateModbusTemplate(parsed);
}
export function isTemplateWritePoint(point: ModbusTemplatePoint): boolean {
  return point.function_code === 5 || point.function_code === 6 || point.function_code === 16;
}
function overlaps(a: ModbusPoint, b: ModbusPoint): boolean {
  if (a.function !== b.function || a.address > b.address + b.reg_count - 1 || b.address > a.address + a.reg_count - 1) return false;
  if (a.data_type === MODBUS_DATA_TYPE.BOOL && b.data_type === MODBUS_DATA_TYPE.BOOL
    && a.bit_index !== null && b.bit_index !== null && a.address === b.address && a.reg_count === b.reg_count && a.bit_index !== b.bit_index) return false;
  if (a.data_type === MODBUS_DATA_TYPE.BOOL && b.data_type === MODBUS_DATA_TYPE.BOOL
    && a.enum_value != null && b.enum_value != null && a.address === b.address && a.reg_count === b.reg_count
    && (a.word_order === 2) === (b.word_order === 2) && (a.byte_order === 2) === (b.byte_order === 2)
    && a.enum_value !== b.enum_value) return false;
  return true;
}
export function planTemplateApplication(template: ModbusTemplate, options: TemplateApplicationOptions): { rows: TemplateApplicationRow[]; points: ModbusPoint[] } {
  const data = validateModbusTemplate(template);
  if (options.addressBase !== 1 && options.addressBase !== 2) throw new Error('连接地址基准不合法');
  const prefix = options.prefix ?? '';
  // 用户输入不向渲染层抛异常；作为可修正的行冲突阻止保存。
  let prefixError: string | null = null;
  try { text(prefix, '标签前缀', true); }
  catch (error) { prefixError = error instanceof Error ? error.message : '标签前缀不合法'; }
  const selected = options.selectedIds ? new Set(options.selectedIds) : null;
  const rows: TemplateApplicationRow[] = data.points.map(source => {
    const finalTag = prefix + source.tag;
    const point: ModbusPoint = { tag: finalTag, function: FUNCTION_TO_NATIVE[source.function_code],
      address: source.address - data.address_base + (options.addressBase === 2 ? 1 : 0), data_type: MODBUS_DATA_TYPE[source.data_type],
      reg_count: source.reg_count, ...createModbusEngineeringFields(source), word_order: source.word_order === 'HL' ? 1 : 2,
      byte_order: source.byte_order === 'AB' ? 1 : 2, bit_index: source.bit_index,
      ...(source.enum_value != null ? { enum_value: source.enum_value } : {}) };
    let conflict: string | null = null;
    if (prefixError) conflict = prefixError;
    else if (finalTag.length > 256 || finalTag !== finalTag.trim()) conflict = '最终标签过长或首尾包含空白';
    else if (options.existingPoints.some(old => old.tag === finalTag)) conflict = '标签与已有点位重复';
    else if (point.address + point.reg_count - 1 > 65535) conflict = '转换后的地址范围超出上位机支持的 65535 上限';
    else if (options.existingPoints.some(old => overlaps(point, old))) conflict = '地址范围与已有点位重叠';
    return { id: source.id, source, point, finalTag, conflict, selected: selected ? selected.has(source.id) : !isTemplateWritePoint(source) && source.default_selected !== false };
  });
  const chosen = rows.filter(row => row.selected && !row.conflict);
  for (const row of rows) {
    if (row.conflict) continue;
    const other = chosen.find(candidate => candidate.id !== row.id && (candidate.finalTag === row.finalTag || overlaps(row.point, candidate.point)));
    if (other) row.conflict = other.finalTag === row.finalTag ? '标签与已选点位重复' : '地址范围与已选点位重叠';
  }
  return { rows, points: rows.filter(row => row.selected && !row.conflict).map(row => row.point) };
}
export function createTemplateFromPoints(input: { id: string; name: string; manufacturer?: string; models?: string[]; protocolVersion?: string; addressBase: number; points: readonly ModbusPoint[] }): ModbusTemplate {
  if (input.addressBase !== 1 && input.addressBase !== 2) throw new Error('连接地址基准不合法');
  return validateModbusTemplate({ schema_version: 1, id: input.id, name: input.name, manufacturer: input.manufacturer ?? '', models: input.models ?? [],
    protocol_version: input.protocolVersion ?? '', address_base: input.addressBase === 2 ? 1 : 0, notes: ['从当前连接点表保存；单位、分组和来源页未记录。'], sources: [],
    points: input.points.map((point, index) => ({ id: `point-${index + 1}`, tag: point.tag, group: '', unit: '',
      function_code: Number(Object.entries(FUNCTION_TO_NATIVE).find(([, value]) => value === point.function)?.[0] ?? 0), address: point.address,
      data_type: Object.entries(MODBUS_DATA_TYPE).find(([, value]) => value === point.data_type)?.[0] ?? '', reg_count: point.reg_count,
      scale: resolveModbusPointDecimalText(point, 'scale'), offset: resolveModbusPointDecimalText(point, 'offset'), deadband: resolveModbusPointDecimalText(point, 'deadband'),
      word_order: point.word_order === 0 || point.word_order === 1 ? 'HL' : point.word_order === 2 ? 'LH' : '', byte_order: point.byte_order === 0 || point.byte_order === 1 ? 'AB' : point.byte_order === 2 ? 'BA' : '',
      bit_index: point.bit_index, ...(point.enum_value != null ? { enum_value: point.enum_value } : {}), source_page: 0, description: '' })) });
}
