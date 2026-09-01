import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..', '..');

// 验证IEC61850上位机展示模型网络目录并保存A/B网段绑定。
test('IEC61850 exposes SCL network candidates for A/B channel binding', () => {
  const page = fs.readFileSync(path.join(root, 'src/pages/IEC61850/index.tsx'), 'utf8');
  const types = fs.readFileSync(path.join(root, 'src/adapters/types.ts'), 'utf8');
  const browser = fs.readFileSync(path.join(root, 'src/adapters/browser.ts'), 'utf8');

  assert.match(types, /connected_access_points: Iec61850SclConnectedApSummary\[\]/);
  assert.match(types, /interface Iec61850SclConnectedApSummary/);
  assert.match(page, /getConnectedApCandidates/);
  assert.match(page, /选择 SCL 网段/);
  assert.match(page, /currentNetworkCandidates\.length === 1/);
  assert.match(page, /subnetwork_name: value \?\? ''/);
  assert.match(browser, /subnetwork_name: 'NETA'/);
  assert.match(browser, /subnetwork_name: 'NETB'/);
});
