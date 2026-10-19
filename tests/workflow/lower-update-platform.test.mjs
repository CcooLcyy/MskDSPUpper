import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const compile = (file) => ts.transpileModule(source(file), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText;
const loadRules = () => new Function(compile('src/utils/lower-update-platform.ts')
  .replace(/export /g, '') + '\nreturn { getLowerUpdateChannels, getLowerUpdateChannel, assertLowerUpdateManifest };')();

// 架构规则必须保留旧通道，并将 x64 限制到 CI。
test('lower update architecture rules reject unsupported manifests and normalize x64 channel', () => {
  const rules = loadRules();
  assert.deepEqual(rules.getLowerUpdateChannels('linux-arm64'), ['stable', 'beta', 'ci']);
  assert.deepEqual(rules.getLowerUpdateChannels('linux-x64'), ['ci']);
  assert.equal(rules.getLowerUpdateChannel('linux-x64', 'stable'), 'ci');
  assert.equal(rules.getLowerUpdateChannel('linux-arm64', 'beta'), 'beta');
  assert.throws(() => rules.getLowerUpdateChannels('linux-unknown'), /不支持/);
  assert.throws(() => rules.assertLowerUpdateManifest({ platform: 'linux-arm64', channel: 'ci' }, 'linux-x64', 'ci'), /架构/);
  assert.throws(() => rules.assertLowerUpdateManifest({ platform: 'linux-x64', channel: 'stable' }, 'linux-x64', 'stable'), /通道/);
  rules.assertLowerUpdateManifest({ platform: 'linux-x64', channel: 'ci' }, 'linux-x64', 'ci');
});

// 上下位机共用一个平台地址，拒绝混入路径或凭据。
test('software platform endpoint normalizes hosts and rejects invalid addresses', () => {
  const code = compile('src/utils/software-platform.ts').replace(/export /g, '');
  const { normalizeSoftwarePlatformEndpoint: normalize } = new Function(code + '\nreturn { normalizeSoftwarePlatformEndpoint };')();
  assert.equal(normalize(' http://192.168.10.198:50000/ '), 'http://192.168.10.198:50000');
  assert.equal(normalize('http://60.208.15.90:50000'), 'http://60.208.15.90:50000');
  assert.equal(normalize('http://platform.example.com:50000'), 'http://platform.example.com:50000');
  assert.equal(normalize('https://packages.example:443'), 'https://packages.example');
  for (const input of ['', 'file:///tmp', 'http://user:password@host', 'http://host/path', 'http://host?token=x', 'http://host#fragment', 'http://ho st', 'http://host\n:50000']) {
    assert.throws(() => normalize(input), /地址/);
  }
});

function providerHarness(api) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef(initial) {
      const i = cursor++;
      return slots[i] ??= { current: initial };
    },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.();
        slots[i] = { deps, cleanup: fn() };
      });
    },
    createElement: (_type, props) => props.value,
  };
  const contextCode = compile('src/components/lower-update/lower-update-auto-context.ts').replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  const context = new Function('createContext', 'useContext', contextCode + '\nreturn { initialLowerUpdateAutoStatus, LowerUpdateAutoContext };')((v) => v, () => null);
  const code = compile('src/components/lower-update/LowerUpdateAutoProvider.tsx').replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  const Provider = new Function('React', 'api', 'context', 'rules', 'window',
    'const { useState, useRef, useMemo, useCallback, useEffect } = React;\n' +
    'const { initialLowerUpdateAutoStatus, LowerUpdateAutoContext } = context;\n' +
    'const { getLowerUpdateChannels, getLowerUpdateChannel, assertLowerUpdateManifest } = rules;\n' +
    code + '\nreturn LowerUpdateAutoProvider;')(React, api, context, loadRules(), { setInterval: () => 1, clearInterval: () => {} });
  return () => {
    cursor = 0;
    const value = Provider({ children: null });
    const pending = effects; effects = []; pending.forEach((fn) => fn());
    return value;
  };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const manifestFor = (platform, channel) => ({ platform, channel, version: '1', asset: { name: `${platform}.tgz`, size: 1, sha256: 'abc' } });

// 实际运行 Provider：旧 ARM 下载完成后只能更新 ARM 槽位，x64 CI 不受其锁影响。
test('lower update provider isolates checks downloads and late completions by architecture', async () => {
  const checks = [];
  const downloads = [];
  const complete = new Map();
  const api = {
    checkLowerUpdate: async (channel, platform) => { checks.push([platform, channel]); return manifestFor(platform, channel); },
    listCachedLowerUpdates: async () => [],
    downloadLowerUpdate: (manifest) => new Promise((resolve) => { downloads.push(manifest); complete.set(`${manifest.platform}:${manifest.channel}`, resolve); }),
  };
  const render = providerHarness(api);
  let value = render();
  assert.equal(value.platform, 'linux-arm64');
  await settle();
  assert.deepEqual(checks, [['linux-arm64', 'stable'], ['linux-arm64', 'beta'], ['linux-arm64', 'ci']]);
  const armPromise = value.ensureDownloaded(manifestFor('linux-arm64', 'ci'));
  value.setPlatform('linux-x64');
  value = render(); await settle();
  assert.deepEqual(checks.at(-1), ['linux-x64', 'ci']);
  assert.equal(downloads.length, 4, 'ARM CI 下载锁不能阻止 x64 CI');
  const x64Promise = value.ensureDownloaded(manifestFor('linux-x64', 'ci'));
  assert.equal(x64Promise, value.ensureDownloaded(manifestFor('linux-x64', 'ci')));
  complete.get('linux-arm64:ci')({ package_name: 'arm', package_path: '/arm', downloaded_bytes: 1, sha256: 'abc' });
  await armPromise; await settle();
  value = render();
  assert.equal(value.platform, 'linux-x64');
  assert.equal(value.channels.ci.kind, 'downloading');
  assert.equal(value.channels.ci.manifest.platform, 'linux-x64');
  complete.get('linux-x64:ci')({ package_name: 'x64', package_path: '/x64', downloaded_bytes: 1, sha256: 'abc' });
  await x64Promise; await settle();
  value = render();
  assert.equal(value.channels.ci.downloadResult.package_path, '/x64');
  value.setPlatform('linux-arm64'); value = render();
  assert.equal(value.channels.ci.downloadResult.package_path, '/arm');
});

// 前后端适配器参数与浏览器缓存键必须传递架构。
test('lower update adapters forward platform and separate browser cache keys', () => {
  const tauri = source('src/adapters/tauri.ts');
  const browser = source('src/adapters/browser.ts');
  assert.match(tauri, /platform: LowerUpdatePlatform = 'linux-arm64'/);
  assert.doesNotMatch(tauri, /baseUrl:|getLowerUpdateStaticBaseUrl/);
  assert.match(tauri, /channel: channel \?\? null, platform/);
  assert.match(browser, /浏览器开发模式不支持平台 gRPC/);
  assert.doesNotMatch(browser, /buildLowerUpdateLatestUrl/);
  assert.match(browser, /item\.manifest\.platform === platform/);
  assert.match(browser, /browserRunningLowerImageId = request\.expected_image_id/);
});
