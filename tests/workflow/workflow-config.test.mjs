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

function extractRunBlock(stepBlock) {
  const lines = stepBlock.split('\n');
  const runIndex = lines.findIndex((line) => /^\s*run:/.test(line));
  if (runIndex === -1) {
    return null;
  }

  const runLine = lines[runIndex];
  const inlineValue = runLine.replace(/^\s*run:\s*/, '');
  if (!/^[|>]/.test(inlineValue)) {
    return inlineValue;
  }

  const runIndent = runLine.match(/^\s*/)[0].length;
  const bodyLines = [];

  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      bodyLines.push(line);
      continue;
    }
    if (line.match(/^\s*/)[0].length <= runIndent) {
      break;
    }
    bodyLines.push(line);
  }

  return bodyLines.join('\n');
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

function listJobBlocks(fileText) {
  const lines = fileText.split('\n');
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.notEqual(jobsIndex, -1, 'missing jobs: section');

  const blocks = [];
  let current = null;

  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      if (current) {
        blocks.push(current);
      }
      current = { name: lines[index].trim().replace(/:$/, ''), lines: [] };
    }
    if (current) {
      current.lines.push(lines[index]);
    }
  }

  if (current) {
    blocks.push(current);
  }

  return blocks.map((block) => ({ name: block.name, block: block.lines.join('\n') }));
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

// 回归：rust-cache 恢复的 registry 索引无法支撑 offline 解析，缓存命中时开启 CARGO_NET_OFFLINE
// 会让 cargo 直接报 "no matching package named `anyhow` found"，因此 CI 不得强制离线模式。
test('ci workflow does not force cargo into offline mode', () => {
  const fileText = fs
    .readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
    .replace(/\r\n/g, '\n');

  assert.doesNotMatch(
    fileText,
    /CARGO_NET_OFFLINE/,
    'CARGO_NET_OFFLINE breaks cargo resolution on a Rust cache hit',
  );
});

// 回归：run 块会被 runner 写成无 BOM 的 UTF-8 脚本，Windows PowerShell 5.1 按 ANSI 代码页读取，
// 非 ASCII 字符可能被解码成智能引号并触发 ParserError，因此 5.1 步骤的 run 块必须保持纯 ASCII。
test('powershell 5.1 steps keep their run blocks ASCII-only', () => {
  const workflowPaths = [
    '.github/workflows/ci.yml',
    '.github/workflows/beta.yml',
    '.github/workflows/nightly.yml',
    '.github/workflows/release.yml',
  ];
  let checkedStepCount = 0;

  for (const workflowPath of workflowPaths) {
    const fileText = fs
      .readFileSync(path.join(repoRoot, workflowPath), 'utf8')
      .replace(/\r\n/g, '\n');

    for (const stepBlock of extractNamedStepBlocks(fileText)) {
      if (!/^\s*shell:\s*powershell\b/m.test(stepBlock)) {
        continue;
      }

      const runBlock = extractRunBlock(stepBlock);
      assert.notEqual(runBlock, null, `${workflowPath} powershell step must define a run block`);
      checkedStepCount += 1;

      assert.doesNotMatch(
        runBlock,
        /[^\t\n\r\x20-\x7e]/,
        `${workflowPath} powershell 5.1 run block must stay ASCII-only`,
      );
    }
  }

  assert.ok(checkedStepCount > 0, 'expected at least one powershell 5.1 step to check');
});

// 回归：runner 会先注入 $ErrorActionPreference='Stop'，而 cargo 即使成功也会把进度写到 stderr；
// 只要 run 块接了 2>&1，那一行 stderr 就会被当成终止性错误（nightly 曾经因此每天必挂）。
// 凡含 2>&1 的 5.1 步骤都必须覆盖成 Continue；真实失败仍由各步的 $LASTEXITCODE 判断负责。
test('powershell 5.1 steps with 2>&1 must relax $ErrorActionPreference', () => {
  const workflowPaths = [
    '.github/workflows/ci.yml',
    '.github/workflows/beta.yml',
    '.github/workflows/nightly.yml',
    '.github/workflows/release.yml',
  ];
  let checkedStepCount = 0;

  for (const workflowPath of workflowPaths) {
    const fileText = fs
      .readFileSync(path.join(repoRoot, workflowPath), 'utf8')
      .replace(/\r\n/g, '\n');

    for (const stepBlock of extractNamedStepBlocks(fileText)) {
      if (!/^\s*shell:\s*powershell\b/m.test(stepBlock)) {
        continue;
      }

      const runBlock = extractRunBlock(stepBlock);
      if (runBlock === null || !/2>&1/.test(runBlock)) {
        continue;
      }

      checkedStepCount += 1;
      assert.match(
        stepBlock,
        /\$ErrorActionPreference\s*=\s*["']Continue["']/,
        `${workflowPath} 步骤使用了 2>&1，必须在 run 块内覆盖 $ErrorActionPreference 为 Continue`,
      );
    }
  }

  assert.ok(
    checkedStepCount >= 20,
    `expected at least 20 guarded 2>&1 steps, got ${checkedStepCount}`,
  );
});

// 回归：PowerShell 向原生命令传参时会丢掉空字符串元素，于是后面的 flag 会被当成它的值，
// node 的 parseArgs 会报 "argument is ambiguous"（beta 的 resolve 步骤曾经如此）。
test('powershell steps do not pass possibly-empty expressions as standalone arguments', () => {
  const workflowPaths = [
    '.github/workflows/ci.yml',
    '.github/workflows/beta.yml',
    '.github/workflows/nightly.yml',
    '.github/workflows/release.yml',
  ];

  for (const workflowPath of workflowPaths) {
    const lines = fs
      .readFileSync(path.join(repoRoot, workflowPath), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n');

    for (let index = 0; index < lines.length - 1; index += 1) {
      if (!/^\s*'--[a-zA-Z][\w-]*'?,?\s*$/.test(lines[index])) {
        continue;
      }

      // 只盯"确实可能为空"的命名空间：dispatch 输入、仓库变量、环境变量。
      // github.ref_name / github.sha / github.repository 这类在支持的事件里不会为空。
      assert.doesNotMatch(
        lines[index + 1],
        /^\s*"\$\{\{\s*(?:github\.event\.inputs|inputs|vars|env)\./,
        `${workflowPath}:${index + 2} 把可能为空的表达式当作独立参数传递，PowerShell 会丢弃空字符串`,
      );
    }
  }
});

// 回归：tests/workflow 里有 4 个用例直接读取 proto/*.proto，凡是执行该测试套件的 job 都必须
// 让子模块可用（checkout 时 submodules: true，或显式 git submodule update --init），
// 否则会以 ENOENT 失败（曾有 workflow 因为忘记拉子模块而整条链路失败）。
test('jobs running the workflow test suite must make the proto submodule available', () => {
  const workflowDir = path.join(repoRoot, '.github', 'workflows');
  const workflowPaths = fs
    .readdirSync(workflowDir)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => `.github/workflows/${file}`);
  let checkedJobCount = 0;

  for (const workflowPath of workflowPaths) {
    const fileText = fs
      .readFileSync(path.join(repoRoot, workflowPath), 'utf8')
      .replace(/\r\n/g, '\n');

    for (const job of listJobBlocks(fileText)) {
      if (!/npm run test:workflow|node --test tests\/workflow/.test(job.block)) {
        continue;
      }

      checkedJobCount += 1;
      assert.match(
        job.block,
        /git submodule update --init|submodules:\s*true/,
        `${workflowPath} 的 job「${job.name}」会运行 tests/workflow，必须先让 proto 子模块可用`,
      );
    }
  }

  assert.ok(checkedJobCount >= 4, `expected at least 4 test jobs, got ${checkedJobCount}`);
});

// publish 工作区是干净检出，package/metadata 与 package/.manifest-backup 都不存在，
// 因此产物来源只能用已下载产物自身内嵌的提交信息校验。
test('ci publish verifies the downloaded artifact against the current commit', () => {
  const fileText = fs
    .readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
    .replace(/\r\n/g, '\n');
  const verifyBlock = extractStepBlock(fileText, 'Verify artifact commit');

  assert.match(verifyBlock, /needs\.package-build\.outputs\.output_dir/);
  assert.match(verifyBlock, /latest\.json/);
  assert.match(verifyBlock, /\$env:GITHUB_SHA\.Substring\(0, 7\)/);
  assert.match(verifyBlock, /sha\\\./);
  assert.doesNotMatch(
    verifyBlock,
    /package[/\\]metadata/,
    'publish 工作区没有 package/metadata，不能据此校验产物来源',
  );
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

test('release workflow keeps manual stable publishing path', () => {
  const fileText = fs
    .readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8')
    .replace(/\r\n/g, '\n');

  assert.match(fileText, /^\s{2}push:\n\s{4}tags:\n\s{6}- v\*$/m);
  assert.match(fileText, /^\s{2}workflow_dispatch:$/m);
});
