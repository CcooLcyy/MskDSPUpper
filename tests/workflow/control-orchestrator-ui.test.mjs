import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');

test('control orchestrator exposes a linear workflow CRUD and execute page', () => {
  const page = fs.readFileSync(path.join(root, 'src/pages/ControlOrchestrator/index.tsx'), 'utf8');
  const router = fs.readFileSync(path.join(root, 'src/router.tsx'), 'utf8');
  const tauri = fs.readFileSync(path.join(root, 'src/adapters/tauri.ts'), 'utf8');

  assert.match(page, /controlOrchestratorUpsertSequence/);
  assert.match(page, /controlOrchestratorExecuteSequence/);
  assert.match(page, /步骤间延时/);
  assert.match(page, /触发源点/);
  assert.match(page, /RETRY_COMMAND/);
  assert.match(page, /dcGetOrCreateConnection/);
  assert.match(page, /dcUpsertConnTags/);
  assert.match(page, /dcListConnections/);
  assert.match(page, /dcGetConnTags/);
  assert.match(page, /选择模块/);
  assert.match(page, /暂无已注册点名/);
  assert.doesNotMatch(page, /label="源模块" required><Input/);
  assert.match(router, /control-orchestrator/);
  assert.match(tauri, /control_orchestrator_list_sequences/);
  assert.match(tauri, /control_orchestrator_delete_sequence/);
});

// 验证控制编排页不会被路径前缀误判为控制策略页。
test('control orchestrator keeps an independent layout context', () => {
  const layout = fs.readFileSync(path.join(root, 'src/layouts/MainLayout.tsx'), 'utf8');

  assert.match(layout, /const isControlPage = location\.pathname === '\/control' \|\| location\.pathname\.startsWith\('\/control\/'\);/);
  assert.doesNotMatch(layout, /const isControlPage = location\.pathname\.startsWith\('\/control'\);/);
});
