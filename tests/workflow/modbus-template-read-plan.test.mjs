import assert from 'node:assert/strict';
import test from 'node:test';
import { saveTemplateReadPlanAndPoints } from '../../src/features/modbus-templates/read-plan-save.ts';

const point = (tag, address, extra = {}) => ({ tag, address, function: 2, data_type: 2, reg_count: 1,
  scale: 1, offset: 0, deadband: 0, scale_decimal: '1', offset_decimal: '0', deadband_decimal: '0',
  word_order: 1, byte_order: 1, bit_index: null, ...extra });
const config = (plan = { mode: 2, blocks: [{ function: 2, start: 100, quantity: 10 }] }) => ({
  conn_name: '模板测试', serial: { device: '/dev/ttyUSB0', baud_rate: 19200, data_bits: 8, parity: 1, stop_bits: 1, read_timeout_ms: 2500 },
  device_id: 8, poll_interval_ms: 1200, address_base: 1, read_plan: plan, transport_type: 1,
  serial_port: 'RS485-2', request_timeout_ms: 3000, serial_byte_timeout_ms: 100,
  serial_frame_timeout_ms: 100, serial_est_size: 256,
});

// 验证模板点位保存后即被原批量策略覆盖，同时保留用户手工区间和最新连接参数。
test('追加未覆盖模板寄存器点，保留已有区间和其他配置，先策略后点表', async () => {
  const original = config(), snapshot = structuredClone(original);
  const oldPoint = point('原有点', 100), addition = point('新增点', 300);
  const calls = [];
  const supplemented = await saveTemplateReadPlanAndPoints({ config: original, additions: [addition], points: [oldPoint, addition],
    saveConfig: async (next) => { calls.push(['策略', next]); },
    savePoints: async (next) => { calls.push(['点表', next]); },
  });
  assert.equal(supplemented, true);
  assert.deepEqual(calls.map(([type]) => type), ['策略', '点表']);
  assert.deepEqual(calls[0][1], { ...snapshot, read_plan: { mode: 2, blocks: [...snapshot.read_plan.blocks, { function: 2, start: 300, quantity: 1 }] } });
  assert.deepEqual(calls[1][1], [oldPoint, addition]);
  assert.deepEqual(original, snapshot);
});

test('已被原区间完整覆盖的新增点只保存点表', async () => {
  const addition = point('已覆盖', 105, { reg_count: 2, data_type: 3 });
  let writes = 0;
  assert.equal(await saveTemplateReadPlanAndPoints({ config: config(), additions: [addition], points: [addition],
    saveConfig: async () => assert.fail('完整覆盖时不得更新策略'), savePoints: async () => { writes += 1; },
  }), false);
  assert.equal(writes, 1);
});

test('只覆盖一半的双寄存器点补齐完整范围，不拆开读取', async () => {
  const addition = point('跨区间', 109, { reg_count: 2, data_type: 3 });
  let savedConfig;
  await saveTemplateReadPlanAndPoints({ config: config(), additions: [addition], points: [addition],
    saveConfig: async (next) => { savedConfig = next; }, savePoints: async () => {},
  });
  assert.deepEqual(savedConfig.read_plan.blocks, [{ function: 2, start: 100, quantity: 10 }, { function: 2, start: 109, quantity: 2 }]);
});

test('相同地址不同读功能码分别补齐，不把线圈和写点加入区间', async () => {
  const additions = [point('保持', 105), point('输入', 105, { function: 3 }), point('线圈', 300, { function: 1, data_type: 1 }),
    point('写单寄存器', 301, { function: 4 }), point('写多寄存器', 302, { function: 5 }), point('写线圈', 304, { function: 6, data_type: 1 })];
  let savedConfig;
  await saveTemplateReadPlanAndPoints({ config: config(), additions, points: additions,
    saveConfig: async (next) => { savedConfig = next; }, savePoints: async () => {},
  });
  assert.deepEqual(savedConfig.read_plan.blocks, [{ function: 2, start: 100, quantity: 10 }, { function: 3, start: 105, quantity: 1 }]);
});

test('补齐连续地址按125上限分块，双寄存器点保持完整且末地址不过65535', async () => {
  const additions = Array.from({ length: 125 }, (_, index) => point(`连续${index}`, 65409 + index));
  additions.push(point('末端双寄存器', 65534, { data_type: 3, reg_count: 2 }));
  let savedConfig;
  await saveTemplateReadPlanAndPoints({ config: config({ mode: 2, blocks: [{ function: 3, start: 10, quantity: 1 }] }), additions, points: additions,
    saveConfig: async (next) => { savedConfig = next; }, savePoints: async () => {},
  });
  assert.deepEqual(savedConfig.read_plan.blocks, [{ function: 3, start: 10, quantity: 1 },
    { function: 2, start: 65409, quantity: 125 }, { function: 2, start: 65534, quantity: 2 }]);
});

test('逐点和未配置读取策略均不改变，只保存点表', async () => {
  for (const plan of [{ mode: 1, blocks: [{ function: 2, start: 10, quantity: 5 }] }, null]) {
    const addition = point('新增', 300);
    assert.equal(await saveTemplateReadPlanAndPoints({ config: config(plan), additions: [addition], points: [addition],
      saveConfig: async () => assert.fail('不得改变逐点策略'), savePoints: async () => {},
    }), false);
  }
});

test('仅新增写点或线圈时不保存读取策略', async () => {
  const additions = [point('写点', 500, { function: 4 }), point('线圈', 510, { function: 1, data_type: 1 })];
  assert.equal(await saveTemplateReadPlanAndPoints({ config: config(), additions, points: additions,
    saveConfig: async () => assert.fail('写点和线圈不参与区间补齐'), savePoints: async () => {},
  }), false);
});

test('读取策略保存失败时不保存点表，不返回成功', async () => {
  const addition = point('新增', 300);
  await assert.rejects(saveTemplateReadPlanAndPoints({ config: config(), additions: [addition], points: [addition],
    saveConfig: async () => { throw new Error('策略保存失败'); }, savePoints: async () => assert.fail('不得保存点表'),
  }), /策略保存失败/);
});

test('点表保存失败时恢复原策略，传播原错误', async () => {
  const original = config(), addition = point('新增', 300), calls = [];
  const failure = new Error('设备拒绝点表');
  await assert.rejects(saveTemplateReadPlanAndPoints({ config: original, additions: [addition], points: [addition],
    saveConfig: async (next) => { calls.push(['策略', next]); },
    savePoints: async () => { calls.push(['点表']); throw failure; },
  }), (error) => error === failure);
  assert.deepEqual(calls.map(([type]) => type), ['策略', '点表', '策略']);
  assert.deepEqual(calls[2][1], original);
});

test('点表保存和恢复策略同时失败时明确报告两项错误', async () => {
  const addition = point('新增', 300);
  let configWrites = 0;
  await assert.rejects(saveTemplateReadPlanAndPoints({ config: config(), additions: [addition], points: [addition],
    saveConfig: async () => { if (++configWrites === 2) throw new Error('连接断开，回滚失败'); },
    savePoints: async () => { throw new Error('点表写入失败'); },
  }), (error) => /点表写入失败/.test(error.message) && /恢复原读取策略失败/.test(error.message) && /连接断开，回滚失败/.test(error.message));
  assert.equal(configWrites, 2);
});
