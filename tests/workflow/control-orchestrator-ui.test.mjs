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
  assert.match(router, /control-orchestrator/);
  assert.match(tauri, /control_orchestrator_list_sequences/);
  assert.match(tauri, /control_orchestrator_delete_sequence/);
});
