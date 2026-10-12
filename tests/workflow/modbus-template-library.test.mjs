import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateModbusTemplate, planTemplateApplication } from '../../src/features/modbus-templates/model.ts';
import { buildReadPlanBlocks } from '../../src/pages/ModbusRTU/modbus-form-rules.ts';
import { saveTemplateReadPlanAndPoints } from '../../src/features/modbus-templates/read-plan-save.ts';

const directory = new URL('../../src/features/modbus-templates/builtin/', import.meta.url);

// 验证随软件发布的所有正式模板均能加载、ID唯一并携带可追溯文档信息。
test('正式模板库校验及默认采集点的协议枚举转换', () => {
  const files = readdirSync(directory).filter((file) => file.endsWith('.json'));
  assert.deepEqual(files, ['aiswei-inverter-v2-1-5.json', 'huawei-sun2000-three-v3-02.json', 'sungrow-pv-v1-1-78.json'], '内置模板仅包含用户确认的爱士惟、华为与阳光模板');
  const ids = new Set();
  for (const file of files) {
    const template = validateModbusTemplate(JSON.parse(readFileSync(new URL(file, directory), 'utf8')));
    const expected = file.startsWith('aiswei-') ? ['爱士惟', '爱士惟逆变器 · V2.1.5', 35]
      : file.startsWith('huawei-') ? ['华为', '华为 SUN2000 三相 · V3.0', 101]
      : ['阳光电源', '阳光电源光伏逆变器 · V1.1.78', 73];
    assert.deepEqual([template.manufacturer, template.name, template.points.length], expected);
    assert.ok(!ids.has(template.id), file); ids.add(template.id);
    assert.ok(template.sources.length > 0, `${file} 缺少来源`);
    for (const source of template.sources) assert.match(source.sha256, /^[a-f0-9]{64}$/i);
    for (const point of template.points) {
      assert.ok(point.source_page > 0, `${file} ${point.tag} 缺少来源页码`);
      if (point.condition) assert.equal(point.default_selected, false, `${file} ${point.tag} 条件点不得默认选择`);
    }
    const plan = planTemplateApplication(template, { addressBase: 1, existingPoints: [] });
    assert.equal(plan.rows.filter((row) => row.selected && row.conflict).length, 0, `${file} 默认点位不应互相冲突`);
    for (const row of plan.rows) {
      assert.equal(row.point.address, row.source.address - template.address_base);
      assert.equal(row.point.word_order, row.source.word_order === 'HL' ? 1 : 2);
      assert.equal(row.point.byte_order, row.source.byte_order === 'AB' ? 1 : 2);
      if (row.selected) assert.ok([1, 2, 3].includes(row.point.function), '写控制点不得默认选中');
    }
  }
});

// 验证按用户指定地址裁剪模板，将保留的控制点定义为写功能，并保护原有只读点表。
test('华为模板删除 PV 点并仅保留功率及开关机控制，保留其余 32 个原始只读点', () => {
  const template = validateModbusTemplate(JSON.parse(readFileSync(new URL('huawei-sun2000-three-v3-02.json', directory), 'utf8')));
  const removed = [40000, 40037, 40038, 40196, 40198, 42000, 42015, 42017, 42019, 43006];
  const expectedControls = [
    [40120, 6], [40122, 6], [40123, 6], [40125, 6],
    [40126, 16], [40129, 16], [40200, 6], [40201, 6],
  ];
  for (const address of removed) assert.ok(!template.points.some((point) => point.address === address), `地址 ${address} 应从模板删除`);
  assert.ok(!template.points.some((point) => point.address >= 32016 && point.address <= 32063), '48 个 PV 电压和电流点应全部删除');
  const controlAddresses = new Set(expectedControls.map(([address]) => address));
  const controls = template.points.filter((point) => controlAddresses.has(point.address));
  assert.deepEqual(controls.map((point) => [point.address, point.function_code]).sort((a, b) => a[0] - b[0]), expectedControls);
  assert.equal(template.points.filter((point) => [5, 6, 16].includes(point.function_code)).length, 8);
  for (const point of controls) {
    assert.equal(point.default_selected, false, `${point.tag} 控制点不得默认选择`);
    assert.equal(point.function_code, point.reg_count === 2 ? 16 : 6);
  }
  const readOnly = template.points.filter((point) => !controlAddresses.has(point.address) && point.data_type !== 'BOOL');
  assert.equal(readOnly.length, 32);
  assert.ok(readOnly.every((point) => point.function_code === 3));
  // 锁定去掉 PV 和六个原始位域整字后，32 个原有只读点的顺序及全部字段。
  const normalizedReadOnly = readOnly.map((point) => Object.fromEntries(Object.keys(point).sort().map((key) => [key, point[key]])));
  assert.equal(createHash('sha256').update(JSON.stringify(normalizedReadOnly)).digest('hex'), '5e1d5c8cda946b5d81fa1dd844533bf2cd2a819cf0c676d75cc9297af34ccf43');
  const defaults = planTemplateApplication(template, { addressBase: 1, existingPoints: [] });
  assert.ok(defaults.rows.filter((row) => controlAddresses.has(row.source.address)).every((row) => !row.selected));
});

// 验证源协议明确的 15 个状态位和 46 个告警位均独立映射，避免漏位、错位或误拆枚举。
test('华为状态及告警完整展开 61 个 BOOL 遥信，设备状态仍保留整字枚举', () => {
  const template = validateModbusTemplate(JSON.parse(readFileSync(new URL('huawei-sun2000-three-v3-02.json', directory), 'utf8')));
  const expected = [
    [32000, 1, ['待机', '并网', '正常并网', '限电降额并网', '自降额并网', '正常停运', '故障停运', '限电停运', '关机', '点检']],
    [32002, 1, ['非闭锁状态', 'PV连接状态', 'DSP数据采集状态']],
    [32003, 2, ['离网', '离网使能开关']],
    [32008, 1, ['输入组串电压高', '直流电弧故障', '组串反接', '组串电流反灌', '组串功率异常', 'AFCI自检失败', '电网相线对PE短路', '电网掉电', '电网欠压', '电网过压', '电网电压不平衡', '电网过频', '电网欠频', '电网频率不稳定', '输出过流', '输出电流直流分量过大']],
    [32009, 1, ['残余电流异常', '系统接地异常', '绝缘阻抗低', '温度过高', '设备异常', '升级失败或版本不匹配', 'License到期', '监控单元故障', '功率采集器故障', '储能设备异常', '主动孤岛', '被动孤岛', '瞬时交流过压', '外部设备端口短路', '离网输出过载', '电池板配置异常']],
    [32010, 1, ['优化器故障', '内置PID工作异常', '输入组串对地电压高', '外部风扇异常', '储能反接', '并离网控制器异常', '组串丢失', '内部风扇异常', '直流保护单元异常', 'EL单元异常', '有功调度指令异常', '无功调度指令异常', 'CT接线异常', '直流电弧故障（ADMC告警，需手动清除）']],
  ];
  assert.equal(template.points.filter((point) => point.data_type === 'BOOL').length, 61);
  for (const [address, regCount, names] of expected) {
    const bits = template.points.filter((point) => point.address === address).sort((a, b) => a.bit_index - b.bit_index);
    assert.equal(bits.length, names.length, `地址 ${address} 位域数量应完整且无整字重复`);
    for (const [bitIndex, name] of names.entries()) {
      const point = bits[bitIndex];
      assert.equal(point.function_code, 3);
      assert.equal(point.data_type, 'BOOL');
      assert.equal(point.reg_count, regCount);
      assert.equal(point.bit_index, bitIndex);
      assert.ok(point.tag.includes(name), `地址 ${address} bit${bitIndex} 应表示 ${name}`);
      const sourcePage = address < 32008 ? 18 : address === 32008 && bitIndex <= 12 ? 48 : address === 32010 && bitIndex >= 10 ? 50 : 49;
      assert.equal(point.source_page, sourcePage, `地址 ${address} bit${bitIndex} 来源应指向实际定义页`);
    }
  }
  for (const [address, bitIndex] of [[32008, 1], [32008, 5], [32009, 8], [32009, 13], [32009, 14], [32010, 0], [32010, 1], [32010, 4], [32010, 5], [32010, 8], [32003, 0], [32003, 1]]) {
    const point = template.points.find((candidate) => candidate.address === address && candidate.bit_index === bitIndex);
    assert.ok(point.condition, `地址 ${address} bit${bitIndex} 应保留功能模块或端序适用条件`);
    assert.equal(point.default_selected, false, '需要核对功能模块或端序的遥信不得默认勾选');
  }
  const nonLocked = template.points.find((point) => point.address === 32002 && point.bit_index === 0);
  assert.match(nonLocked.description, /0[：:]\s*闭锁/);
  assert.match(nonLocked.description, /1[：:]\s*非闭锁/);
  const deviceStatus = template.points.filter((point) => point.address === 32089);
  assert.equal(deviceStatus.length, 1);
  assert.equal(deviceStatus[0].data_type, 'UINT16');
  assert.equal(deviceStatus[0].bit_index, null, '32089 为枚举编码，不能按 bit 拆成遥信');
  const plan = planTemplateApplication(template, { addressBase: 1, existingPoints: [], selectedIds: template.points.filter((point) => point.data_type === 'BOOL').map((point) => point.id) });
  assert.equal(plan.points.length, 61, '全部遥信应可同时应用而不产生同寄存器不同位的冲突');
  assert.ok(plan.rows.filter((row) => row.selected).every((row) => row.conflict === null && row.point.function === 2 && row.point.data_type === 1));
  assert.deepEqual(buildReadPlanBlocks(plan.points), [
    { function: 2, start: 32000, quantity: 1 },
    { function: 2, start: 32002, quantity: 3 },
    { function: 2, start: 32008, quantity: 3 },
  ], '同字多个位应共用完整读取区间，状态3应包含两个寄存器');
});

// 验证一基应用保留 32 位位域的完整范围及端序，校验拒绝超出 16/32 位边界的位索引。
test('BOOL 模板应用保留 bit_index 和端序，并拒绝寄存器位边界越界', () => {
  const template = validateModbusTemplate(JSON.parse(readFileSync(new URL('huawei-sun2000-three-v3-02.json', directory), 'utf8')));
  const state3 = template.points.filter((point) => point.address === 32003);
  assert.equal(state3.length, 2);
  const applied = planTemplateApplication(template, { addressBase: 2, existingPoints: [], selectedIds: state3.map((point) => point.id) });
  assert.equal(applied.points.length, 2);
  for (const row of applied.rows.filter((row) => row.selected)) {
    assert.equal(row.point.address, 32004);
    assert.equal(row.point.reg_count, 2);
    assert.equal(row.point.bit_index, row.source.bit_index);
    assert.equal(row.point.word_order, row.source.word_order === 'HL' ? 1 : 2);
    assert.equal(row.point.byte_order, row.source.byte_order === 'AB' ? 1 : 2);
  }
  const source = { ...template.points[0], id: 'bit-boundary', tag: '位边界', data_type: 'BOOL', function_code: 3, address: 32003, reg_count: 2, bit_index: 31, word_order: 'LH', byte_order: 'BA', scale: '1', offset: '0', deadband: '0' };
  const boundaryTemplate = { ...template, points: [source] };
  const boundary = planTemplateApplication(boundaryTemplate, { addressBase: 1, existingPoints: [], selectedIds: [source.id] });
  assert.equal(boundary.points.length, 1);
  assert.equal(boundary.points[0].bit_index, 31);
  assert.equal(boundary.points[0].reg_count, 2);
  assert.equal(boundary.points[0].word_order, 2);
  assert.equal(boundary.points[0].byte_order, 2);
  assert.throws(() => validateModbusTemplate({ ...boundaryTemplate, points: [{ ...source, bit_index: 32 }] }), /位索引/);
  assert.throws(() => validateModbusTemplate({ ...boundaryTemplate, points: [{ ...source, reg_count: 1, bit_index: 16 }] }), /位索引/);
  assert.equal(validateModbusTemplate({ ...boundaryTemplate, points: [{ ...source, reg_count: 1, bit_index: 15 }] }).points[0].bit_index, 15);
});

// 验证控制点应用后的协议枚举和保存路径，确保它们不生成或追加自动采集区间。
test('华为写控制正确转换协议枚举且不会扩展自动读取区间', async () => {
  const template = validateModbusTemplate(JSON.parse(readFileSync(new URL('huawei-sun2000-three-v3-02.json', directory), 'utf8')));
  const addresses = [40120, 40122, 40123, 40125, 40126, 40129, 40200, 40201];
  const sources = template.points.filter((point) => addresses.includes(point.address));
  const plan = planTemplateApplication(template, { addressBase: 1, existingPoints: [], selectedIds: sources.map((point) => point.id) });
  assert.equal(plan.points.length, 8);
  for (const row of plan.rows.filter((row) => row.selected)) {
    assert.equal(row.conflict, null);
    assert.equal(row.point.function, row.source.reg_count === 2 ? 5 : 4, `${row.finalTag} 应映射为写寄存器枚举`);
  }
  assert.deepEqual(buildReadPlanBlocks(plan.points), [], '控制点不能生成批量读取区间');
  const config = { conn_name: 'huawei', read_plan: { mode: 2, blocks: [{ function: 2, start: 32080, quantity: 2 }] } };
  const savedPoints = [];
  let configSaves = 0;
  const extended = await saveTemplateReadPlanAndPoints({
    config, additions: plan.points, points: plan.points,
    saveConfig: async () => { configSaves += 1; },
    savePoints: async (points) => { savedPoints.push(points); },
  });
  assert.equal(extended, false);
  assert.equal(configSaves, 0, '仅新增控制点应保留原读取计划');
  assert.deepEqual(savedPoints, [plan.points], '控制点仍应保存到点表以供后续下发命令');
});

// 验证已批准的两协议页面都通过复读点表和运行状态保护保存模板，不能直接绕过保护写点表。
test('RTU/TCP 接入模板保存保护并使用正式模板弹窗', () => {
  for (const protocol of ['ModbusRTU', 'ModbusTCP']) {
    const source = readFileSync(new URL(`../../src/pages/${protocol}/index.tsx`, import.meta.url), 'utf8');
    assert.match(source, /saveTemplatePoints\(\{ expected: points, additions/);
    assert.match(source, /onApply=\{handleTemplateApply\}/);
    assert.match(source, /onApplyTemplate=\{\(\) => setTemplateModalOpen\(true\)\}/);
    if (protocol === 'ModbusRTU') {
      assert.match(source, /saveTemplateReadPlanAndPoints\(/);
      assert.match(source, /return runSelectedLinkStopped\(async/);
      assert.match(source, /\}, \{ initialState \}\)/);
    } else {
      assert.match(source, /save: \(nextPoints\) => savePointTablePreservingRuntime/);
    }
    assert.match(source, /const initialState = await getLinkState\(selectedConn\)/);
  }
});
