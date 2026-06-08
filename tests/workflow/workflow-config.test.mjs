import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

function extractStepBlock(fileText, stepName) {
  const lines = fileText.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(startIndex, -1, `missing workflow step: ${stepName}`);

  const blockLines = [lines[startIndex]];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trimStart().startsWith('- name: ')) {
      break;
    }
    blockLines.push(lines[index]);
  }

  return blockLines.join('\n');
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

for (const [workflowPath, stepName] of [
  ['.github/workflows/beta.yml', 'Render beta tauri config'],
  ['.github/workflows/nightly.yml', 'Render tauri config'],
  ['.github/workflows/release.yml', 'Render stable tauri config'],
  ['.github/workflows/ci.yml', 'Render release tauri config'],
]) {
  test(`${workflowPath} forces updater artifact generation for release packaging`, () => {
    const fileText = fs.readFileSync(path.join(repoRoot, workflowPath), 'utf8');
    const stepBlock = extractStepBlock(fileText, stepName);

    assert.match(stepBlock, /--updater-artifacts true/);
  });
}

test('release workflow skips stable manifest rewrite when versions already match', () => {
  const fileText = fs.readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
  const detectBlock = extractStepBlock(fileText, 'Detect stable manifest alignment');
  const applyBlock = extractStepBlock(fileText, 'Apply stable version');

  assert.match(detectBlock, /Cargo\.toml/);
  assert.match(detectBlock, /needs_apply=/);
  assert.match(applyBlock, /if: steps\.manifest_alignment\.outputs\.needs_apply == 'true'/);
});

test('ci workflow only runs push builds on main while keeping pull request checks', () => {
  const fileText = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');

  assert.match(fileText, /^\s{2}pull_request:\s*$/m);
  assert.match(fileText, /^\s{2}push:\s*$/m);
  assert.match(fileText, /^\s{6}- main\s*$/m);
  assert.doesNotMatch(fileText, /^\s{6}- master\s*$/m);
  assert.doesNotMatch(fileText, /^\s{6}- beta\/\*\*\s*$/m);

  assert.match(
    fileText,
    /^  package-main:\n    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m,
  );
});

test('ci package publishes updater artifacts to the ci static channel', () => {
  const fileText = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const renderBlock = extractStepBlock(fileText, 'Render release tauri config');
  const stageBlock = extractStepBlock(fileText, 'Stage artifacts');
  const syncBlock = extractStepBlock(fileText, 'Sync CI static updater source');

  assert.match(renderBlock, /\$env:STATIC_UPDATE_BASE_URL\/ci\/latest\.json/);
  assert.match(stageBlock, /\$env:STATIC_UPDATE_BASE_URL\/ci\/\$env:PLATFORM_ID/);
  assert.match(syncBlock, /Sync-StaticUpdater\.ps1/);
  assert.match(syncBlock, /-ChannelPath ci/);
  assert.match(syncBlock, /secrets\.UPDATE_STATIC_SSH_KEY/);
});
