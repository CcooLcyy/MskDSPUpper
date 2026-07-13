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
  const fileText = fs
    .readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
    .replace(/\r\n/g, '\n');

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

test('beta workflow only triggers one-segment beta branch names', () => {
  const fileText = fs.readFileSync(path.join(repoRoot, '.github/workflows/beta.yml'), 'utf8');

  assert.match(fileText, /^\s{6}- beta\/\*\s*$/m);
  assert.doesNotMatch(fileText, /^\s{6}- beta\/\*\*\s*$/m);
});

test('rolling release tags are created from the build commit', () => {
  const nightlyText = fs.readFileSync(path.join(repoRoot, '.github/workflows/nightly.yml'), 'utf8');
  const betaText = fs.readFileSync(path.join(repoRoot, '.github/workflows/beta.yml'), 'utf8');
  const nightlyBlock = extractStepBlock(nightlyText, 'Create or update rolling nightly release');
  const betaPrereleaseBlock = extractStepBlock(betaText, 'Create GitHub prerelease');
  const betaRollingBlock = extractStepBlock(betaText, 'Create or update rolling beta release');

  assert.match(nightlyBlock, /gh release create \$tag \$files --target "\$\{\{ steps\.nightly_head\.outputs\.sha \}\}"/);
  assert.match(betaPrereleaseBlock, /\$args \+= @\('--target', "\$\{\{ steps\.beta_head\.outputs\.sha \}\}"\)/);
  assert.match(betaRollingBlock, /gh release create \$tag \$files --target "\$\{\{ steps\.beta_head\.outputs\.sha \}\}"/);
});

test('release workflow verifies existing stable tags and fetches beta refs before lineage checks', () => {
  const fileText = fs.readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
  const fetchBlock = extractStepBlock(fileText, 'Fetch beta refs for lineage check');
  const resolveBlock = extractStepBlock(fileText, 'Resolve release target');
  const releaseBlock = extractStepBlock(fileText, 'Create or update GitHub Release');

  assert.match(fetchBlock, /git fetch origin '\+refs\/heads\/beta\/\*:refs\/remotes\/origin\/beta\/\*' --prune/);
  assert.match(resolveBlock, /github\.event\.inputs\.release_tag \|\| github\.ref_name/);
  assert.match(resolveBlock, /refs\/tags\/\$tag/);
  assert.doesNotMatch(resolveBlock, /git describe/);
  assert.match(releaseBlock, /gh release create \$tag \$files --verify-tag --title \$title --generate-notes --latest/);
});

test('promote workflow only dispatches release workflow after successful promotions', () => {
  const fileText = fs.readFileSync(path.join(repoRoot, '.github/workflows/promote.yml'), 'utf8');
  const evaluateBlock = extractStepBlock(fileText, 'Evaluate stale beta branches');
  const promoteBlock = extractStepBlock(fileText, 'Promote beta branches to stable tags');
  const triggerBlock = extractStepBlock(fileText, 'Trigger release workflows for promoted tags');

  assert.match(evaluateBlock, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(promoteBlock, /if: steps\.evaluate\.outputs\.has_release_dispatches == 'true'/);
  assert.match(
    triggerBlock,
    /if: steps\.evaluate\.outputs\.has_release_dispatches == 'true' && steps\.promote\.outputs\.release_dispatch_count != '0'/,
  );
  assert.match(triggerBlock, /steps\.promote\.outputs\.release_dispatch_tags_json/);
});
