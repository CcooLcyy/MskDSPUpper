import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EXPLICIT_READ_FUNCTIONS,
  MODBUS_ADDRESS_BASE,
  MODBUS_DATA_TYPE,
  MODBUS_FUNCTION,
  createDefaultModbusPoint,
  buildReadPlanBlocks,
  getCoveredReadPlanTags,
  getAllowedDataTypes,
  getAllowedRegCounts,
  getDefaultRegCount,
  getDuplicatePointAddress,
  getNextDuplicatePointAddress,
  getMinimumAddress,
  isExplicitReadFunction,
  isValidExplicitQuantity,
  isValidRegCount,
} from '../../src/pages/ModbusRTU/modbus-form-rules.ts';

test('Modbus 功能码只返回后端支持的数据类型', () => {
  const {
    BOOL,
    UINT16,
    UINT32,
    INT16,
    INT32,
  } = MODBUS_DATA_TYPE;

  assert.deepEqual(getAllowedDataTypes(MODBUS_FUNCTION.READ_COILS), [BOOL]);
  assert.deepEqual(getAllowedDataTypes(MODBUS_FUNCTION.READ_HOLDING_REGISTERS), [
    BOOL,
    UINT16,
    UINT32,
    INT16,
    INT32,
  ]);
  assert.deepEqual(getAllowedDataTypes(MODBUS_FUNCTION.READ_INPUT_REGISTERS), [
    BOOL,
    UINT16,
    UINT32,
    INT16,
    INT32,
  ]);
  assert.deepEqual(getAllowedDataTypes(MODBUS_FUNCTION.WRITE_SINGLE_REGISTER), [UINT16, INT16]);
  assert.deepEqual(getAllowedDataTypes(MODBUS_FUNCTION.WRITE_MULTIPLE_REGISTERS), [
    UINT16,
    UINT32,
    INT16,
    INT32,
  ]);
  assert.deepEqual(getAllowedDataTypes(0), []);
});

test('Modbus 数据类型决定默认值和合法寄存器数量', () => {
  const {
    BOOL,
    UINT16,
    UINT32,
    INT16,
    INT32,
  } = MODBUS_DATA_TYPE;

  assert.equal(getDefaultRegCount(BOOL), 1);
  assert.equal(getDefaultRegCount(UINT16), 1);
  assert.equal(getDefaultRegCount(INT16), 1);
  assert.equal(getDefaultRegCount(UINT32), 2);
  assert.equal(getDefaultRegCount(INT32), 2);
  assert.equal(getDefaultRegCount(0), null);

  assert.deepEqual(getAllowedRegCounts(BOOL), [1, 2]);
  assert.deepEqual(getAllowedRegCounts(UINT16), [1]);
  assert.deepEqual(getAllowedRegCounts(INT16), [1]);
  assert.deepEqual(getAllowedRegCounts(UINT32), [2]);
  assert.deepEqual(getAllowedRegCounts(INT32), [2]);
  assert.deepEqual(getAllowedRegCounts(0), []);

  assert.equal(isValidRegCount(BOOL, 2), true);
  assert.equal(isValidRegCount(UINT16, 2), false);
  assert.equal(isValidRegCount(UINT32, 2), true);
  assert.equal(isValidRegCount(UINT32, 1), false);
});

test('Modbus 地址基准决定表单允许的最小地址', () => {
  assert.equal(getMinimumAddress(MODBUS_ADDRESS_BASE.ZERO), 0);
  assert.equal(getMinimumAddress(MODBUS_ADDRESS_BASE.ONE), 1);
  assert.equal(getMinimumAddress(undefined), 0);
});

test('Modbus 显式区间只支持 0x03 和 0x04，数量必须为 1 到 125 的整数', () => {
  assert.deepEqual(EXPLICIT_READ_FUNCTIONS, [
    MODBUS_FUNCTION.READ_HOLDING_REGISTERS,
    MODBUS_FUNCTION.READ_INPUT_REGISTERS,
  ]);
  assert.equal(isExplicitReadFunction(MODBUS_FUNCTION.READ_COILS), false);
  assert.equal(isExplicitReadFunction(MODBUS_FUNCTION.READ_HOLDING_REGISTERS), true);
  assert.equal(isExplicitReadFunction(MODBUS_FUNCTION.READ_INPUT_REGISTERS), true);
  assert.equal(isExplicitReadFunction(MODBUS_FUNCTION.WRITE_SINGLE_REGISTER), false);

  assert.equal(isValidExplicitQuantity(1), true);
  assert.equal(isValidExplicitQuantity(125), true);
  assert.equal(isValidExplicitQuantity(0), false);
  assert.equal(isValidExplicitQuantity(126), false);
  assert.equal(isValidExplicitQuantity(1.5), false);
  assert.equal(isValidExplicitQuantity('1'), false);
});

test('新增点位默认使用 0x03、UINT16 和地址基准对应的最小地址', () => {
  const zeroBasedPoint = createDefaultModbusPoint(MODBUS_ADDRESS_BASE.ZERO);
  const oneBasedPoint = createDefaultModbusPoint(MODBUS_ADDRESS_BASE.ONE);

  assert.deepEqual(zeroBasedPoint, {
    tag: '',
    function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS,
    address: 0,
    reg_count: 1,
    data_type: MODBUS_DATA_TYPE.UINT16,
    scale: 1,
    offset: 0,
    deadband: 0,
    word_order: 0,
    byte_order: 0,
    bit_index: null,
  });
  assert.equal(oneBasedPoint.address, 1);

  zeroBasedPoint.tag = '已修改';
  assert.equal(createDefaultModbusPoint(MODBUS_ADDRESS_BASE.ZERO).tag, '');
});

// 验证复制点位保留原 Tag，并按寄存器占用数递增地址。
test('复制点位保留原 Tag，并按寄存器占用数递增地址', () => {
  assert.equal(getDuplicatePointAddress(10, 1), 11);
  assert.equal(getDuplicatePointAddress(10, 2), 12);
  assert.equal(getDuplicatePointAddress(10, 0), 11);
  assert.equal(
    getNextDuplicatePointAddress(
      { function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS, address: 10, reg_count: 1 },
      [
        { function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS, address: 11, reg_count: 1 },
        { function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS, address: 12, reg_count: 1 },
      ],
    ),
    13,
  );
  assert.equal(
    getNextDuplicatePointAddress(
      { function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS, address: 10, reg_count: 1 },
      [{ function: MODBUS_FUNCTION.READ_INPUT_REGISTERS, address: 11, reg_count: 1 }],
    ),
    11,
  );
});

test('根据点位生成区间时按功能码分组并拆分 125 个寄存器上限', () => {
  const blocks = buildReadPlanBlocks([
    { tag: 'a', function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS, address: 0, reg_count: 1 },
    { tag: 'b', function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS, address: 1, reg_count: 2 },
    { tag: 'c', function: MODBUS_FUNCTION.READ_INPUT_REGISTERS, address: 0, reg_count: 1 },
    { tag: 'coil', function: MODBUS_FUNCTION.READ_COILS, address: 5, reg_count: 1 },
  ]);

  assert.deepEqual(blocks, [
    { function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS, start: 0, quantity: 3 },
    { function: MODBUS_FUNCTION.READ_INPUT_REGISTERS, start: 0, quantity: 1 },
  ]);
  assert.deepEqual(
    getCoveredReadPlanTags(
      [
        { tag: 'a', function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS, address: 0, reg_count: 1 },
        { tag: 'b', function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS, address: 1, reg_count: 2 },
      ],
      blocks,
    ),
    ['a', 'b'],
  );
});
