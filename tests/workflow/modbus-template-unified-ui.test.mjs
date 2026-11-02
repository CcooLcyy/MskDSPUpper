import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = await readFile(new URL('../../src/features/modbus-templates/TemplateModal.tsx', import.meta.url), 'utf8');

// 验证用户无需切换添加与更新模式即可处理同一张模板。
test('模板统一预览不再暴露操作切换', () => {
  assert.doesNotMatch(source, /aria-label="模板操作"/);
  assert.match(source, /应用所选变更/);
});

// 验证移除一键默认勾选入口，所有选择由用户操作。
test('模板弹窗不再提供默认选择按钮或按推荐结果自动选中', () => {
  assert.doesNotMatch(source, />默认选择<|initialSelection|setSelected\([^\n]*filter\(/);
  assert.match(source, /清空选择/);
});
