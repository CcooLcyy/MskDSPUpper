import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseEditablePointValue,
  resolveEditablePointValueType,
} from '../../src/utils/control-point-value.ts';

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
  assert.match(page, /internalOutputTag/);
  assert.match(page, /step:\$\{sequenceName\}:\$\{stepName\}/);
  assert.match(page, /自动路由已同步/);
  assert.match(page, /dcListConnections/);
  assert.match(page, /dcGetConnTags/);
  assert.match(page, /选择模块/);
  assert.match(page, /暂无已注册点名/);
  assert.doesNotMatch(page, /label="源模块" required><Input/);
  assert.match(router, /control-orchestrator/);
  assert.match(tauri, /control_orchestrator_list_sequences/);
  assert.match(tauri, /control_orchestrator_delete_sequence/);
});

// 验证控制编排保存和删除时会维护触发路由及每一步的内部输出路由。
test('control orchestrator owns trigger and step output routes', () => {
  const page = fs.readFileSync(path.join(root, 'src/pages/ControlOrchestrator/index.tsx'), 'utf8');

  assert.match(page, /syncBinding\(previous, config\)/);
  assert.match(page, /syncBinding\(selected, null\)/);
  assert.match(page, /dcDeleteRoutes\(staleRoutes\)/);
  assert.match(page, /dcUpsertRoutes\(routesToAdd, false\)/);
  assert.match(page, /dcUpsertConnTags\(connection\.conn_id, \[\.\.\.new Set\(activeRouteTags\)\], true\)/);
});

// 验证控制编排页不会被路径前缀误判为控制策略页。
test('control orchestrator keeps an independent layout context', () => {
  const layout = fs.readFileSync(path.join(root, 'src/layouts/MainLayout.tsx'), 'utf8');

  assert.match(layout, /const isControlPage = location\.pathname === '\/control' \|\| location\.pathname\.startsWith\('\/control\/'\);/);
  assert.doesNotMatch(layout, /const isControlPage = location\.pathname\.startsWith\('\/control'\);/);
});

// 验证控制编排的十进制命令值保留输入原文，并拒绝非法文本而不是静默转换为零。
test('control orchestrator preserves Decimal command text', () => {
  assert.deepEqual(
    parseEditablePointValue('Decimal', '0.12345678901234567890'),
    { type: 'Decimal', value: '0.12345678901234567890' },
  );
  assert.deepEqual(
    parseEditablePointValue('Decimal', '-1e-20'),
    { type: 'Decimal', value: '-1e-20' },
  );
  assert.throws(
    () => parseEditablePointValue('Decimal', '1.2.3'),
    /十进制命令值 必须是完整十进制数/,
  );
  assert.equal(
    resolveEditablePointValueType({ type: 'Decimal', value: '0.1' }),
    'Decimal',
  );
});

// 验证控制编排页面同时保留协议所需的 Double，并提供 Decimal 工程量命令类型。
test('control orchestrator exposes Decimal without removing Double', () => {
  const page = fs.readFileSync(path.join(root, 'src/pages/ControlOrchestrator/index.tsx'), 'utf8');
  const helper = fs.readFileSync(path.join(root, 'src/utils/control-point-value.ts'), 'utf8');

  assert.match(helper, /'Bool', 'Int', 'Double', 'Decimal', 'String'/);
  assert.match(page, /EDITABLE_POINT_VALUE_TYPES/);
  assert.match(page, /parseEditablePointValue/);
});
