import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8').replaceAll('\r\n', '\n');
const exists = (file) => fs.existsSync(path.join(repoRoot, file));
const workflow = read('.github/workflows/ci.yml');
const packager = read('scripts/workflow/build-platform-package.ps1');

function job(name) {
  const lines = workflow.split('\n');
  const start = lines.indexOf('  ' + name + ':', lines.indexOf('jobs:') + 1);
  assert.notEqual(start, -1, '缺少作业 ' + name);
  const end = lines.findIndex((line, index) => index > start && /^  \S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function stepUsing(jobText, action, withPath) {
  const block = jobText.split(/(?=^      - name: )/m)
    .find((step) => step.includes('uses: ' + action + '@') &&
      (withPath === undefined || step.includes('path: ' + withPath)));
  assert.ok(block, '缺少步骤 ' + action);
  return block;
}

function assertOrder(text, before, after) {
  const first = text.indexOf(before);
  const second = text.indexOf(after);
  assert.ok(first >= 0 && second > first, before + ' 必须先于 ' + after);
}

test('主干、维护分支、正式标签和 PR 使用统一验证入口', () => {
  const triggers = workflow.split(/^permissions:/m)[0];
  assert.match(triggers, /^  pull_request:$/m);
  assert.match(triggers, /^  push:\n    branches:\n      - main\n      - 'release\/\*'\n    tags:\n      - 'v\*'$/m);
  assert.match(triggers, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(triggers, /beta/);
});

test('冻结安装包只能在验证通过后打包，PR 不进入签名环境', () => {
  const packageJob = job('package');
  assert.match(packageJob, /^    needs: \[verify, checks\]$/m);
  assert.match(packageJob, /^    if: github\.event_name != 'pull_request'$/m);
  assert.match(packageJob, /^    environment: upper-signing$/m);
  assert.match(packageJob, /TAURI_SIGNING_PRIVATE_KEY:.*secrets\.TAURI_SIGNING_PRIVATE_KEY\b/);
  for (const name of ['verify', 'checks']) {
    const validation = job(name);
    assert.doesNotMatch(validation, /^    (?:needs|if|environment):/m);
    assert.doesNotMatch(validation, /TAURI_SIGNING_PRIVATE_KEY|PLATFORM_UPLOAD_TOKEN/);
  }
});

test('两个并行验证作业覆盖原有测试、前端类型和完整 Rust 目标', () => {
  const verify = job('verify');
  const checks = job('checks');
  assert.match(workflow, /^  NODE_VERSION: '24\.22\.2'$/m);
  assert.match(verify, /^    runs-on: windows-latest$/m);
  assert.match(checks, /^    runs-on: windows-latest$/m);
  assertOrder(verify, 'run: npm ci', 'run: npm run build');
  assertOrder(verify, 'run: npm run build', 'run: cargo test');
  assert.match(verify, /^        run: cargo test --release --locked --manifest-path src-tauri\/Cargo\.toml --target \$env:RUST_TARGET --timings$/m);
  assert.doesNotMatch(verify, /--lib\b/);
  for (const command of ['test:workflow', 'test:offline', 'lint']) {
    assertOrder(checks, 'run: npm ci', 'run: npm run ' + command);
  }
  assert.match(checks, /python -B -m unittest discover -s tests\/gitlab\b/);
});

test('验证与打包都检出设备协议，发布作业无需协议子模块', () => {
  for (const name of ['verify', 'checks', 'package']) {
    const checkout = stepUsing(job(name), 'actions/checkout');
    assert.match(checkout, /submodules:\s*(?:true|recursive)\b/);
    assert.match(checkout, /persist-credentials: false\b/);
  }
  assert.doesNotMatch(stepUsing(job('publish'), 'actions/checkout'), /submodules:\s*(?:true|recursive)\b/);
});

test('签名验证恢复夹具原始字节，打包保留 Tauri 更新签名', () => {
  assertOrder(job('verify'), 'git restore --source=HEAD --worktree -- src-tauri/testdata/updater/fixture.bin', 'cargo test');
  assert.match(job('package'), /run: \.\/scripts\/workflow\/build-platform-package\.ps1/);
  assert.match(packager, /'--updater-artifacts', 'true'/);
  assert.match(packager, /\.plugins\.updater\.endpoints = @\(\)/);
  assertOrder(packager, 'stage-release.mjs', 'freeze_metadata.py');
  assert.match(packager, /finally\s*\{\s*Invoke-Checked 'node' @\('scripts\/workflow\/restore-manifests\.mjs'/);
});

test('发布依赖本次打包产物且仅接受主干或标签', () => {
  const packageJob = job('package');
  const publish = job('publish');
  assert.match(publish, /^    needs: package$/m);
  assert.match(publish, /^    if: github\.event_name != 'pull_request' && \(github\.ref == 'refs\/heads\/main' \|\| github\.ref_type == 'tag'\)$/m);

  const name = packageJob.match(/^      artifact_name:\s*(.+)$/m)?.[1];
  const upload = stepUsing(packageJob, 'actions/upload-artifact', 'package/platform/');
  assert.ok(name, '缺少冻结安装包的产物名称');
  assert.match(name, /steps\.build\.outputs\.artifact_base_name/);
  assert.ok(upload.includes('name: ' + name), '发布作业必须接收实际上传的产物名称');
  assert.match(upload, /if-no-files-found: error\b/);

  const download = stepUsing(publish, 'actions/download-artifact');
  assert.match(download, /name:.*needs\.package\.outputs\.artifact_name\b/);
  assert.match(download, /path: package\/platform\//);
  assertOrder(publish, 'actions/download-artifact@', 'init_platform_proto.py');
  assertOrder(publish, 'init_platform_proto.py', 'platform_client.py');
  assert.match(publish, /platform_client\.py --metadata package\/platform\/upload-metadata\.json/);
});

test('平台发布按通道串行，新提交不能取消正在发布的作业', () => {
  const globalSettings = workflow.split(/^jobs:/m)[0];
  const publish = job('publish');
  assert.doesNotMatch(globalSettings, /^concurrency:/m);
  assert.match(publish, /^      group: upper-platform-.*github\.ref_type == 'tag' && 'stable' \|\| 'ci'/m);
  assert.match(publish, /^      cancel-in-progress: false$/m);
  assert.match(publish, /^      queue: max$/m);
  for (const name of ['verify', 'checks']) {
    const validation = job(name);
    assert.ok(validation.includes('group: upper-' + name + '-${{ github.ref }}'));
    assert.match(validation, /^      cancel-in-progress: true$/m);
  }
});

test('正式版在构建前检查远端标签及来源历史', () => {
  const verify = job('verify');
  assertOrder(verify, 'release_policy.py', 'verify_stable_source.py');
  assert.match(verify, /verify_stable_source\.py --repository origin --tag \$env:GITHUB_REF_NAME --sha \$env:GITHUB_SHA/);
});

test('验证和打包报告 Rust 缓存命中并允许在线解析', () => {
  assert.doesNotMatch(workflow, /CARGO_NET_OFFLINE/);
  for (const name of ['verify', 'package']) {
    const block = job(name);
    const cache = stepUsing(block, 'Swatinem/rust-cache');
    const id = cache.match(/^\s*id:\s*([\w-]+)$/m)?.[1];
    assert.ok(id, 'Rust 缓存需要步骤标识以报告命中状态');
    assert.match(cache, /cache-targets: 'true'/);
    assert.ok(block.includes('steps.' + id + '.outputs.cache-hit'), '需要报告 Rust 缓存命中状态');
  }
});

test('验证和打包分别上传 Cargo 编译计时，报告缺失时保留原作业结果', () => {
  assert.match(packager, /\$release\.config, '--', '--timings'\)/);
  for (const name of ['verify', 'package']) {
    const upload = stepUsing(job(name), 'actions/upload-artifact', 'src-tauri/target/cargo-timings/cargo-timing.html');
    assert.ok(upload.includes('name: upper-' + name + '-cargo-timings-${{ github.run_id }}-${{ github.run_attempt }}'));
    assert.match(upload, /^        if: always\(\)$/m);
    assert.match(upload, /^          if-no-files-found: ignore$/m);
  }
});

test('发布工作流使用 PowerShell 7，支持中文脚本与原生命令退出码', () => {
  for (const name of ['verify', 'checks', 'package', 'publish']) {
    assert.match(job(name), /^    defaults:\n      run:\n        shell: pwsh$/m);
  }
  assert.doesNotMatch(workflow, /^\s*shell:\s*powershell\b/m);
});

test('已退役的 R2、Beta 和 GitLab 发布入口保持关闭', () => {
  assert.doesNotMatch(workflow, /Publish-R2StaticUpdater|R2_ACCESS_KEY|STATIC_UPDATE_BASE_URL/);
  for (const file of [
    '.gitlab-ci.yml',
    '.github/workflows/beta.yml',
    '.github/workflows/release.yml',
    '.github/workflows/sync-static-updater.yml',
  ]) {
    assert.equal(exists(file), false, '退役入口仍存在 ' + file);
  }
});
