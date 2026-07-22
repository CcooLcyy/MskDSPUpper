export const MODBUS_FUNCTION = Object.freeze({
  READ_COILS: 1,
  READ_HOLDING_REGISTERS: 2,
  READ_INPUT_REGISTERS: 3,
  WRITE_SINGLE_REGISTER: 4,
  WRITE_MULTIPLE_REGISTERS: 5,
} as const);

export const MODBUS_DATA_TYPE = Object.freeze({
  BOOL: 1,
  UINT16: 2,
  UINT32: 3,
  INT16: 4,
  INT32: 5,
} as const);

export const MODBUS_ADDRESS_BASE = Object.freeze({
  ZERO: 1,
  ONE: 2,
} as const);

export type ModbusFunctionCode = typeof MODBUS_FUNCTION[keyof typeof MODBUS_FUNCTION];
export type ModbusDataType = typeof MODBUS_DATA_TYPE[keyof typeof MODBUS_DATA_TYPE];
export type ModbusAddressBase = typeof MODBUS_ADDRESS_BASE[keyof typeof MODBUS_ADDRESS_BASE];

const EMPTY_NUMBERS: readonly number[] = Object.freeze([]);
const BOOL_TYPES: readonly ModbusDataType[] = Object.freeze([
  MODBUS_DATA_TYPE.BOOL,
]);
const REGISTER_READ_TYPES: readonly ModbusDataType[] = Object.freeze([
  MODBUS_DATA_TYPE.BOOL,
  MODBUS_DATA_TYPE.UINT16,
  MODBUS_DATA_TYPE.UINT32,
  MODBUS_DATA_TYPE.INT16,
  MODBUS_DATA_TYPE.INT32,
]);
const REGISTER_TYPES: readonly ModbusDataType[] = Object.freeze([
  MODBUS_DATA_TYPE.UINT16,
  MODBUS_DATA_TYPE.UINT32,
  MODBUS_DATA_TYPE.INT16,
  MODBUS_DATA_TYPE.INT32,
]);
const SINGLE_REGISTER_TYPES: readonly ModbusDataType[] = Object.freeze([
  MODBUS_DATA_TYPE.UINT16,
  MODBUS_DATA_TYPE.INT16,
]);

const DATA_TYPES_BY_FUNCTION: Readonly<Record<ModbusFunctionCode, readonly ModbusDataType[]>> = Object.freeze({
  [MODBUS_FUNCTION.READ_COILS]: BOOL_TYPES,
  [MODBUS_FUNCTION.READ_HOLDING_REGISTERS]: REGISTER_READ_TYPES,
  [MODBUS_FUNCTION.READ_INPUT_REGISTERS]: REGISTER_READ_TYPES,
  [MODBUS_FUNCTION.WRITE_SINGLE_REGISTER]: SINGLE_REGISTER_TYPES,
  [MODBUS_FUNCTION.WRITE_MULTIPLE_REGISTERS]: REGISTER_TYPES,
});

export function getAllowedDataTypes(functionCode: number): readonly ModbusDataType[] {
  return DATA_TYPES_BY_FUNCTION[functionCode as ModbusFunctionCode] ?? EMPTY_NUMBERS;
}

const ONE_REGISTER: readonly number[] = Object.freeze([1]);
const TWO_REGISTERS: readonly number[] = Object.freeze([2]);
const ONE_OR_TWO_REGISTERS: readonly number[] = Object.freeze([1, 2]);

export function getDefaultRegCount(dataType: number): number | null {
  if (dataType === MODBUS_DATA_TYPE.UINT32 || dataType === MODBUS_DATA_TYPE.INT32) {
    return 2;
  }
  if (
    dataType === MODBUS_DATA_TYPE.BOOL
    || dataType === MODBUS_DATA_TYPE.UINT16
    || dataType === MODBUS_DATA_TYPE.INT16
  ) {
    return 1;
  }
  return null;
}

export function getAllowedRegCounts(dataType: number): readonly number[] {
  if (dataType === MODBUS_DATA_TYPE.BOOL) {
    return ONE_OR_TWO_REGISTERS;
  }
  if (dataType === MODBUS_DATA_TYPE.UINT16 || dataType === MODBUS_DATA_TYPE.INT16) {
    return ONE_REGISTER;
  }
  if (dataType === MODBUS_DATA_TYPE.UINT32 || dataType === MODBUS_DATA_TYPE.INT32) {
    return TWO_REGISTERS;
  }
  return EMPTY_NUMBERS;
}

export function isValidRegCount(dataType: number, regCount: number): boolean {
  return getAllowedRegCounts(dataType).includes(regCount);
}

export function getMinimumAddress(addressBase?: number): 0 | 1 {
  return addressBase === MODBUS_ADDRESS_BASE.ONE ? 1 : 0;
}

export const EXPLICIT_READ_FUNCTIONS: readonly ModbusFunctionCode[] = Object.freeze([
  MODBUS_FUNCTION.READ_HOLDING_REGISTERS,
  MODBUS_FUNCTION.READ_INPUT_REGISTERS,
]);

export function isExplicitReadFunction(functionCode: number): boolean {
  return (EXPLICIT_READ_FUNCTIONS as readonly number[]).includes(functionCode);
}

export function isValidExplicitQuantity(quantity: unknown): quantity is number {
  return typeof quantity === 'number'
    && Number.isInteger(quantity)
    && quantity >= 1
    && quantity <= 125;
}

export interface ModbusPointFormValues {
  tag: string;
  function: ModbusFunctionCode;
  address: number;
  reg_count: number;
  data_type: ModbusDataType;
  scale: number;
  offset: number;
  deadband: number;
  word_order: number;
  byte_order: number;
  bit_index: number | null;
}

export function createDefaultModbusPoint(addressBase?: number): ModbusPointFormValues {
  return {
    tag: '',
    function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS,
    address: getMinimumAddress(addressBase),
    reg_count: getDefaultRegCount(MODBUS_DATA_TYPE.UINT16) ?? 1,
    data_type: MODBUS_DATA_TYPE.UINT16,
    scale: 1,
    offset: 0,
    deadband: 0,
    word_order: 0,
    byte_order: 0,
    bit_index: null,
  };
}

/** 为复制点位生成不重复的 Tag，保持与连接复制的命名习惯一致。 */
export function buildDuplicatePointTag(sourceTag: string, existingTags: Iterable<string>): string {
  const baseTag = sourceTag.trim();
  const copyPrefix = `${baseTag}_copy`;
  const usedTags = new Set(existingTags);
  if (!usedTags.has(copyPrefix)) {
    return copyPrefix;
  }

  let suffix = 2;
  while (usedTags.has(`${copyPrefix}_${suffix}`)) {
    suffix += 1;
  }
  return `${copyPrefix}_${suffix}`;
}

export function getDuplicatePointAddress(address: number, regCount: number): number {
  return address + Math.max(regCount || 1, 1);
}

export interface DuplicatePointLike {
  function: number;
  address: number;
  reg_count: number;
}

/** 从复制起始地址开始，跳过当前功能码下已占用的地址区间。 */
export function getNextDuplicatePointAddress(
  source: DuplicatePointLike,
  existingPoints: readonly DuplicatePointLike[],
): number {
  const regCount = Math.max(source.reg_count || 1, 1);
  const maxStart = regCount > 1 ? 65534 : 65535;
  let candidate = getDuplicatePointAddress(source.address, regCount);

  while (candidate <= maxStart) {
    const candidateEnd = candidate + regCount - 1;
    const occupied = existingPoints.some((point) => {
      if (point.function !== source.function) {
        return false;
      }
      const pointRegCount = Math.max(point.reg_count || 1, 1);
      const pointEnd = point.address + pointRegCount - 1;
      return candidate <= pointEnd && point.address <= candidateEnd;
    });
    if (!occupied) {
      return candidate;
    }
    candidate += regCount;
  }

  return candidate;
}

export interface ReadPlanPointLike {
  tag: string;
  function: number;
  address: number;
  reg_count: number;
}

export interface ReadPlanBlockLike {
  function: number;
  start: number;
  quantity: number;
}

/** 根据已有寄存器点位生成不超过 Modbus 单次读取上限的候选区间。 */
export function buildReadPlanBlocks(points: readonly ReadPlanPointLike[]): ReadPlanBlockLike[] {
  const registerPoints = points
    .filter((point) => isExplicitReadFunction(point.function))
    .slice()
    .sort((left, right) => left.function - right.function || left.address - right.address);
  const blocks: ReadPlanBlockLike[] = [];

  for (const point of registerPoints) {
    const pointEnd = point.address + Math.max(point.reg_count || 1, 1) - 1;
    const previous = blocks.at(-1);
    if (
      previous
      && previous.function === point.function
      && point.address <= previous.start + previous.quantity
      && pointEnd - previous.start + 1 <= 125
    ) {
      previous.quantity = Math.max(previous.quantity, pointEnd - previous.start + 1);
      continue;
    }

    blocks.push({
      function: point.function,
      start: point.address,
      quantity: Math.min(pointEnd - point.address + 1, 125),
    });
  }

  return blocks;
}

export function getCoveredReadPlanTags(
  points: readonly ReadPlanPointLike[],
  blocks: readonly ReadPlanBlockLike[],
): string[] {
  return points
    .filter((point) => {
      const pointEnd = point.address + Math.max(point.reg_count || 1, 1) - 1;
      return blocks.some((block) => (
        block.function === point.function
        && point.address >= block.start
        && pointEnd <= block.start + block.quantity - 1
      ));
    })
    .map((point) => point.tag);
}
