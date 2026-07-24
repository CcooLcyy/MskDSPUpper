import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const iec104Source = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');

// 验证 IEC104 复制点位进入弹窗并保留原 Tag，避免直接提交自动生成副本。
test('IEC104 复制点位打开弹窗并保留原 Tag', () => {
  assert.match(iec104Source, /const openCopyPoint = useCallback/);
  assert.match(iec104Source, /tag: source\.tag/);
  assert.match(iec104Source, /useEffect\(\(\) => \{[\s\S]*pointForm\.setFields\(\[\{ name: 'tag', errors: \['该标签已存在'\] \}\]\)/);
  assert.match(iec104Source, /setPointModalOpen\(true\)/);
  assert.match(iec104Source, /onClick=\{\(\) => openCopyPoint\(originalIndex\)\}/);
});

// 验证 IEC104 复制点位仍然保留自动选择可用 IOA 的路径。
test('IEC104 复制点位仍校验 IOA 可用性', () => {
  assert.match(iec104Source, /getNextAvailableIoa/);
  assert.match(iec104Source, /pointIoaDuplicate/);
});

// 验证 IEC104 复制点位不再绕过弹窗直接保存点表。
test('IEC104 复制点位不直接提交 API', () => {
  const copyStart = iec104Source.indexOf('const openCopyPoint = useCallback');
  const deleteStart = iec104Source.indexOf('const handleDeletePoint = useCallback', copyStart);
  assert.ok(copyStart >= 0 && deleteStart > copyStart);
  assert.doesNotMatch(iec104Source.slice(copyStart, deleteStart), /api\.iec104UpsertPointTable/);
});
