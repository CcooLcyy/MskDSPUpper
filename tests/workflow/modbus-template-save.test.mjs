import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveTemplatePoints } from '../../src/features/modbus-templates/save-template.ts';

const point = (tag, address) => ({ tag, address, function: 2, data_type: 2, reg_count: 1, scale: 1, offset: 0, deadband: 0, scale_decimal: '1', offset_decimal: '0', deadband_decimal: '0', word_order: 1, byte_order: 1, bit_index: null });

// 验证保存前复读点表，其他操作造成的变化不会被整表替换覆盖。
test('模板应用遇到新点表时通知刷新并禁止保存', async () => {
  let saved = false;
  let refreshed;
  await assert.rejects(saveTemplatePoints({
    expected: [point('原有', 1)], additions: [point('新增', 2)],
    read: async () => [point('原有', 1), point('其他用户新增', 3)],
    save: async () => { saved = true; }, onChanged: (points) => { refreshed = points; },
  }), /点表已变化/);
  assert.equal(saved, false);
  assert.equal(refreshed.length, 2);
});

// 验证对象字段顺序和点位顺序不影响比较，保存仍保留最新点表顺序。
test('模板应用保留最新原点位并仅追加一次', async () => {
  const first = point('原有1', 1), second = point('原有2', 3), addition = point('新增', 8);
  let saved;
  const result = await saveTemplatePoints({ expected: [first, second], additions: [addition],
    read: async () => [Object.fromEntries(Object.entries(second).reverse()), first],
    save: async (points) => { saved = points; return '已保存'; }, onChanged: () => assert.fail('无需刷新'),
  });
  assert.deepEqual(saved.map((item) => item.tag), ['原有2', '原有1', '新增']);
  assert.equal(result.result, '已保存');
});

// 验证设备接口失败不会返回成功结果，允许界面保留选择后重试。
test('模板应用传播保存失败', async () => {
  await assert.rejects(saveTemplatePoints({ expected: [], additions: [point('新增', 8)], read: async () => [],
    save: async () => { throw new Error('设备保存失败'); }, onChanged: () => {},
  }), /设备保存失败/);
});

// 验证旧点表未携带 decimal 原文时不会被页面的规范化误判为其他人修改。
test('模板应用兼容旧点表空 decimal 字段', async () => {
  const expected = point('旧点位', 1);
  const raw = { ...expected, scale_decimal: '', offset_decimal: '', deadband_decimal: '' };
  let saved;
  await saveTemplatePoints({ expected: [expected], additions: [point('新增', 8)], read: async () => [raw],
    save: async (points) => { saved = points; }, onChanged: () => assert.fail('旧字段不应误报变化'),
  });
  assert.equal(saved.length, 2);
  assert.equal(saved[0].scale_decimal, '1');
});

// 验证确认期间连接地址基准变化时，提交前阻断旧计划，不触发点表保存。
test('模板提交先校验连接地址基准', async () => {
  await assert.rejects(saveTemplatePoints({ expected: [], additions: [point('新增', 8)],
    verifyConnection: async () => { throw new Error('连接地址基准已变化'); },
    read: async () => assert.fail('不得继续读点表'), save: async () => assert.fail('不得保存旧计划'), onChanged: () => {},
  }), /地址基准已变化/);
});
