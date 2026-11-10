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

function assertJobGate(jobText, ...expected) {
  const gate = jobText.match(/^    if: >-\n((?: {6,}[^\n]+\n)+)/m)?.[1];
  assert.ok(gate, '缺少作业门禁');
  assert.equal(gate.trim().replaceAll(/\s+/g, ' '), expected.join(' '));
}

test('主干、维护分支、正式标签和 PR 使用统一验证入口', () => {
  const triggers = workflow.split(/^permissions:/m)[0];
  assert.match(triggers, /^  pull_request:$/m);
  assert.match(triggers, /^  push:\n    branches:\n      - main\n      - 'release\/\*'\n    tags:\n      - 'v\*'$/m);
  assert.match(triggers, /^  workflow_dispatch:$/m);
  const rustTestMode = triggers.split(/^      rust_test_mode:\n/m)[1];
  assert.ok(rustTestMode, '缺少手动触发的 Rust 测试模式');
  assert.match(rustTestMode, /^        type: choice\n        default: normal\n        options:\n          - normal\n          - baseline\n          - opt-level-1$/m);
  assert.match(triggers, /^      parallel_package:\n        description: .+\n        type: boolean\n        default: false$/m);
  assert.doesNotMatch(triggers, /beta/);
});

test('签名打包依赖验证通过，并行路径还要求正式 EXE 编译成功', () => {
  const packageJob = job('package');
  assert.match(packageJob, /^    needs: \[verify, checks, prebuild\]$/m);
  assertJobGate(packageJob,
    "${{ !cancelled() && needs.verify.result == 'success' && needs.checks.result == 'success'",
    "&& github.event_name != 'pull_request' && (github.event_name != 'workflow_dispatch' || inputs.rust_test_mode == 'normal')",
    "&& (needs.prebuild.result == 'success' || needs.prebuild.result == 'skipped' && !inputs.parallel_package",
    "&& (github.event_name != 'push' || github.ref != 'refs/heads/main')) }}",
  );
  assert.match(packageJob, /^    environment: upper-signing$/m);
  assert.match(packageJob, /TAURI_SIGNING_PRIVATE_KEY:.*secrets\.TAURI_SIGNING_PRIVATE_KEY\b/);
  for (const name of ['verify', 'checks']) {
    const validation = job(name);
    assert.doesNotMatch(validation, /^    (?:needs|if|environment):/m);
    assert.doesNotMatch(validation, /TAURI_SIGNING_PRIVATE_KEY|PLATFORM_UPLOAD_TOKEN/);
  }
});

test('main 推送和显式试点预编译正式 EXE，并把同次尝试的产物交给签名打包', () => {
  const prebuild = job('prebuild');
  const packageJob = job('package');
  assertJobGate(prebuild,
    "github.ref == 'refs/heads/main'",
    "&& (github.event_name == 'push' || github.event_name == 'workflow_dispatch' && inputs.parallel_package && inputs.rust_test_mode == 'normal')",
  );
  assert.doesNotMatch(prebuild, /^    (?:needs|environment):|TAURI_SIGNING_PRIVATE_KEY|PLATFORM_UPLOAD_TOKEN/m);
  assertOrder(prebuild, 'run: npm ci', 'run: ./scripts/workflow/build-platform-package.ps1 -Prebuild');
  assertOrder(prebuild, 'run: ./scripts/workflow/build-platform-package.ps1 -Prebuild', 'actions/upload-artifact@');

  const artifactPath = 'package/prebuilt/';
  const artifact = '          name: upper-prebuilt-exe-${{ github.run_id }}-${{ github.run_attempt }}';
  const upload = stepUsing(prebuild, 'actions/upload-artifact', artifactPath);
  const download = stepUsing(packageJob, 'actions/download-artifact', artifactPath);
  assert.ok(upload.split('\n').includes(artifact));
  assert.ok(download.split('\n').includes(artifact));
  assert.match(upload, /^          if-no-files-found: error$/m);
  assert.match(download, /^        if: needs\.prebuild\.result == 'success'$/m);
  const prebuilt = "${{ needs.prebuild.result == 'success' && 'true' || 'false' }}";
  assert.ok(packageJob.split('\n').includes('      prebuilt: ' + prebuilt));
  assert.ok(packageJob.split('\n').includes('          BUNDLE_PREBUILT: ' + prebuilt));
  assertOrder(packageJob, 'actions/download-artifact@', 'run: ./scripts/workflow/build-platform-package.ps1 -BundlePrebuilt:');
  assert.match(packageJob, /^        run: \.\/scripts\/workflow\/build-platform-package\.ps1 -BundlePrebuilt:\(\$env:BUNDLE_PREBUILT -eq 'true'\)$/m);
});

test('两个并行验证作业覆盖原有测试、前端类型和完整 Rust 目标', () => {
  const verify = job('verify');
  const checks = job('checks');
  assert.match(workflow, /^  NODE_VERSION: '24\.22\.2'$/m);
  assert.match(verify, /^    runs-on: windows-latest$/m);
  assert.match(checks, /^    runs-on: windows-latest$/m);
  assertOrder(verify, 'run: npm ci', 'run: npm run build');
  assertOrder(verify, 'run: npm run build', 'cargo test');
  assert.match(verify, /^          cargo test --release --locked --manifest-path src-tauri\/Cargo\.toml --target \$env:RUST_TARGET --timings @profileArgs$/m);
  assert.doesNotMatch(verify, /--lib\b/);
  for (const command of ['test:workflow', 'test:offline', 'lint']) {
    assertOrder(checks, 'run: npm ci', 'run: npm run ' + command);
  }
  assert.match(checks, /python -B -m unittest discover -s tests\/gitlab\b/);
});

test('Rust 对照实验只在 opt-level-1 模式覆盖应用包的 Release 优化等级', () => {
  const verify = job('verify');
  assert.match(verify, /^          RUST_TEST_MODE: \$\{\{ inputs\.rust_test_mode \}\}$/m);
  assert.match(verify, /^          \$profileArgs = @\(\)\n          if \(\$env:RUST_TEST_MODE -eq 'opt-level-1'\) \{\n            \$profileArgs = @\('--config', 'profile\.release\.package\.mskdsp-upper\.opt-level=1'\)\n          \}$/m);
});

test('验证与打包都检出设备协议，发布作业无需协议子模块', () => {
  for (const name of ['verify', 'checks', 'prebuild', 'package']) {
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

test('发布仅接受常规主干或标签运行，并行打包产物须先验证签名', () => {
  const packageJob = job('package');
  const publish = job('publish');
  assert.match(publish, /^    needs: \[package, verify_parallel_package\]$/m);
  assertJobGate(publish,
    "${{ !cancelled() && needs.package.result == 'success'",
    "&& (needs.package.outputs.prebuilt == 'true' && needs.verify_parallel_package.result == 'success'",
    "|| needs.package.outputs.prebuilt == 'false' && needs.verify_parallel_package.result == 'skipped')",
    "&& github.event_name != 'pull_request' && !inputs.parallel_package",
    "&& (github.ref == 'refs/heads/main' || github.ref_type == 'tag') }}",
  );

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

test('并行打包独立验证安装包的 SHA256 和更新签名', () => {
  const validation = job('verify_parallel_package');
  assert.match(validation, /^    needs: package$/m);
  assert.match(validation, /^    if: \$\{\{ !cancelled\(\) && needs\.package\.result == 'success' && needs\.package\.outputs\.prebuilt == 'true' \}\}$/m);
  assert.doesNotMatch(validation, /^    environment:|TAURI_SIGNING_PRIVATE_KEY|PLATFORM_UPLOAD_TOKEN/m);
  const download = stepUsing(validation, 'actions/download-artifact', 'package/platform/');
  assert.match(download, /^          name: \$\{\{ needs\.package\.outputs\.artifact_name \}\}$/m);
  assertOrder(validation, 'actions/download-artifact@', 'sudo apt-get install -y minisign');
  assert.match(validation, /hashlib\.file_digest\(contents, "sha256"\)\.hexdigest\(\) != metadata\["sha256"\]/);
  assert.match(validation, /signature != metadata\["signature"\]/);
  assert.match(validation, /Path\("src-tauri\/tauri\.conf\.json"\)/);
  assert.match(validation, /config\["plugins"\]\["updater"\]\["pubkey"\]/);
  assert.match(validation, /subprocess\.run\(\["minisign", "-Vm", str\(installer\), "-p", str\(key\), "-x", str\(sig\)\], check=True\)/);
});

test('平台发布按通道串行，新提交不能取消正在发布的作业', () => {
  const globalSettings = workflow.split(/^jobs:/m)[0];
  const publish = job('publish');
  assert.doesNotMatch(globalSettings, /^concurrency:/m);
  assert.match(publish, /^      group: upper-platform-.*github\.ref_type == 'tag' && 'stable' \|\| 'ci'/m);
  assert.match(publish, /^      cancel-in-progress: false$/m);
  assert.match(publish, /^      queue: max$/m);
  const pilotSuffix = "${{ inputs.parallel_package && '-parallel-package' || '' }}";
  for (const name of ['verify', 'checks', 'prebuild', 'package']) {
    const validation = job(name);
    const mode = ['verify', 'checks'].includes(name) ? "-${{ inputs.rust_test_mode || 'normal' }}" : '';
    assert.ok(validation.split('\n').includes('      group: upper-' + name + '-${{ github.ref }}' + mode + pilotSuffix));
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
  for (const name of ['verify', 'prebuild', 'package']) {
    const block = job(name);
    const cache = stepUsing(block, 'Swatinem/rust-cache');
    const id = cache.match(/^\s*id:\s*([\w-]+)$/m)?.[1];
    assert.ok(id, 'Rust 缓存需要步骤标识以报告命中状态');
    assert.match(cache, /cache-targets: 'true'/);
    assert.ok(block.includes('steps.' + id + '.outputs.cache-hit'), '需要报告 Rust 缓存命中状态');
  }
  const prebuildCache = stepUsing(job('prebuild'), 'Swatinem/rust-cache');
  assert.ok(prebuildCache.includes('shared-key: upper-${{ env.RUST_TARGET }}-package'));
  assert.match(prebuildCache, /^          save-if: \$\{\{ github\.event_name == 'push' \}\}$/m);
  assert.match(stepUsing(job('package'), 'Swatinem/rust-cache'), /^        if: needs\.prebuild\.result != 'success'$/m);
});

test('验证和打包分别上传 Cargo 编译计时，报告缺失时保留原作业结果', () => {
  assert.match(packager, /\$release\.config, '--', '--timings'\)/);
  for (const name of ['verify', 'prebuild', 'package']) {
    const upload = stepUsing(job(name), 'actions/upload-artifact', 'src-tauri/target/cargo-timings/cargo-timing.html');
    assert.ok(upload.includes('name: upper-' + name + '-cargo-timings-${{ github.run_id }}-${{ github.run_attempt }}'));
    assert.match(upload, name === 'package' ? /^        if: always\(\) && needs\.prebuild\.result != 'success'$/m : /^        if: always\(\)$/m);
    assert.match(upload, /^          if-no-files-found: ignore$/m);
  }
});

test('发布工作流使用 PowerShell 7，支持中文脚本与原生命令退出码', () => {
  for (const name of ['verify', 'checks', 'prebuild', 'package', 'publish']) {
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
