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
