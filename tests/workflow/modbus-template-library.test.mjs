import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateModbusTemplate, planTemplateApplication } from '../../src/features/modbus-templates/model.ts';

const directory = new URL('../../src/features/modbus-templates/builtin/', import.meta.url);

// 验证随软件发布的所有正式模板均能加载、ID唯一并携带可追溯文档信息。
test('正式模板库校验及默认采集点的协议枚举转换', () => {
  const files = readdirSync(directory).filter((file) => file.endsWith('.json'));
  assert.deepEqual(files, ['huawei-sun2000-three-v3-02.json'], '内置模板仅保留用户指定的华为三相 V3.0');
  const ids = new Set();
  for (const file of files) {
    const template = validateModbusTemplate(JSON.parse(readFileSync(new URL(file, directory), 'utf8')));
    assert.equal(template.manufacturer, '华为');
    assert.equal(template.name, '华为 SUN2000 三相 · V3.0');
    assert.equal(template.points.length, 104);
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
