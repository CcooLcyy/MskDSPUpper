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

function extractNamedStepBlocks(fileText) {
  const lines = fileText.split(/\r?\n/);
  const blocks = [];
  let currentBlock = null;

  for (const line of lines) {
    if (line.trimStart().startsWith('- name: ')) {
      if (currentBlock) {
        blocks.push(currentBlock.join('\n'));
      }
      currentBlock = [line];
    } else if (currentBlock) {
      currentBlock.push(line);
    }
  }

  if (currentBlock) {
    blocks.push(currentBlock.join('\n'));
  }

  return blocks;
}

function extractJobBlock(fileText, jobName) {
  const lines = fileText.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(startIndex, -1, `missing workflow job: ${jobName}`);

  const blockLines = [lines[startIndex]];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^  \S/.test(lines[index])) {
      break;
    }
    blockLines.push(lines[index]);
  }

  return blockLines.join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    /^  package-build:\n    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m,
  );
});

test('ci workflow gates static publishing behind verification and packaging', () => {
  const fileText = fs
    .readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
    .replace(/\r\n/g, '\n');

  const packageBlock = extractJobBlock(fileText, 'package-build');
  const publishBlock = extractJobBlock(fileText, 'publish');

  assert.doesNotMatch(
    packageBlock,
    /^    needs:/m,
    'package-build must start in parallel with verify-debug instead of waiting for it',
  );
  assert.match(publishBlock, /^    needs:\n      - verify-debug\n      - package-build$/m);
  assert.match(
    publishBlock,
    /^    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m,
  );

  assert.match(
    packageBlock,
    /^      artifact_base_name: \$\{\{ steps\.metadata\.outputs\.artifact_base_name \}\}$/m,
  );
  assert.doesNotMatch(packageBlock, /Publish-R2StaticUpdater\.ps1/);
  assert.ok(
    packageBlock.indexOf('Upload CI package artifact') <
      packageBlock.indexOf('name: Restore manifests'),
    'package-build must upload its artifact before restoring manifests',
  );
  assert.ok(
    publishBlock.indexOf('Download CI package artifact') <
      publishBlock.indexOf('Sync CI static updater source'),
    'publish must download the package artifact before syncing to the static channel',
  );
  assert.match(
    publishBlock,
    /name: \$\{\{ needs\.package-build\.outputs\.artifact_base_name \}\}/,
  );
  assert.match(
    publishBlock,
    /-PackageOutputDir "\$\{\{ needs\.package-build\.outputs\.output_dir \}\}"/,
  );
});

test('ci package publishes updater artifacts to the ci static channel', () => {
  const fileText = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const renderBlock = extractStepBlock(fileText, 'Render release tauri config');
  const stageBlock = extractStepBlock(fileText, 'Stage artifacts');
  const syncBlock = extractStepBlock(fileText, 'Sync CI static updater source');

  assert.match(renderBlock, /\$env:STATIC_UPDATE_BASE_URL\/ci\/latest\.json/);
  assert.match(stageBlock, /\$env:STATIC_UPDATE_BASE_URL\/ci\/\$env:PLATFORM_ID/);
  assert.match(syncBlock, /Publish-R2StaticUpdater\.ps1/);
  assert.match(syncBlock, /AWS_ACCESS_KEY_ID: \$\{\{ secrets\.R2_ACCESS_KEY_ID \}\}/);
  assert.match(syncBlock, /AWS_SECRET_ACCESS_KEY: \$\{\{ secrets\.R2_SECRET_ACCESS_KEY \}\}/);
  assert.match(syncBlock, /-ChannelPath ci/);
});

// 验证 Rust 依赖和 target 产物均缓存，并为每个缓存步骤输出命中状态。
test('release workflows enable Rust target caching and report cache hits', () => {
  const workflowPaths = [
    '.github/workflows/ci.yml',
    '.github/workflows/beta.yml',
    '.github/workflows/nightly.yml',
    '.github/workflows/release.yml',
  ];
  let rustCacheStepCount = 0;

  for (const workflowPath of workflowPaths) {
    const fileText = fs.readFileSync(path.join(repoRoot, workflowPath), 'utf8');
    const namedStepBlocks = extractNamedStepBlocks(fileText);
    const rustCacheEntries = namedStepBlocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => /uses:\s*Swatinem\/rust-cache@/m.test(block));
    const rustCacheSteps = rustCacheEntries.map(({ block }) => block);

    assert.ok(rustCacheSteps.length > 0, `${workflowPath} must configure Swatinem/rust-cache`);
    rustCacheStepCount += rustCacheSteps.length;

    for (const [entryIndex, { block: stepBlock, index: stepIndex }] of rustCacheEntries.entries()) {
      assert.match(
        stepBlock,
        /^\s*cache-targets:\s*'true'\s*$/m,
        `${workflowPath} Rust cache step ${entryIndex + 1} must enable target caching`,
      );

      const idMatch = stepBlock.match(/^\s*id:\s*([A-Za-z_][\w-]*)\s*$/m);
      assert.ok(idMatch, `${workflowPath} Rust cache step ${entryIndex + 1} must define an id`);

      const nextCacheStepIndex = rustCacheEntries[entryIndex + 1]?.index ?? namedStepBlocks.length;
      const followingSteps = namedStepBlocks.slice(stepIndex, nextCacheStepIndex).join('\n');
      const cacheHitOutput = new RegExp(
        `steps\\.${escapeRegExp(idMatch[1])}\\.outputs\\.cache-hit`,
      );
      assert.match(
        followingSteps,
        cacheHitOutput,
        `${workflowPath} must report cache-hit for Rust cache id ${idMatch[1]}`,
      );
    }
  }

  assert.equal(rustCacheStepCount, 6, 'ci/beta/nightly/release should expose six Rust cache steps');
});

// 验证上位机静态服务器资产上传提供异步进度、远端大小轮询和退出码传播。
test('上位机静态更新上传显示远端进度', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'scripts/workflow/Sync-StaticUpdater.ps1'),
    'utf8',
  );

  assert.match(script, /Start-Process/);
  assert.match(script, /Start-Sleep -Seconds 10/);
  assert.match(script, /stat -c %s/);
  assert.match(script, /上传进度/);
  assert.match(script, /每 10 秒显示一次进度/);
  assert.match(script, /预计剩余/);
  assert.match(script, /WaitForExit/);
  assert.match(script, /latest\.json last|latest\.json.*最后|最后上传 latest\.json/);
});

test('beta workflow only triggers one-segment beta branch names', () => {
  const fileText = fs.readFileSync(path.join(repoRoot, '.github/workflows/beta.yml'), 'utf8');

  assert.match(fileText, /^\s{6}- beta\/\*\s*$/m);
  assert.doesNotMatch(fileText, /^\s{6}- beta\/\*\*\s*$/m);
});

test('beta workflow tolerates target branches without the sccache stats helper', () => {
  const fileText = fs.readFileSync(path.join(repoRoot, '.github/workflows/beta.yml'), 'utf8');
  const statsBlocks = fileText
    .split(/(?=^[ \t]+- name: )/m)
    .filter((block) => block.trimStart().startsWith('- name: Show sccache stats'));

  assert.equal(statsBlocks.length, 2);
  for (const block of statsBlocks) {
    assert.match(block, /\$statsScript = '\.\\scripts\\workflow\\Show-SccacheStats\.ps1'/);
    assert.match(block, /if \(Test-Path -LiteralPath \$statsScript\) \{/);
    assert.match(block, /& \$statsScript/);
    assert.match(block, /skipping stats/);
  }
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
