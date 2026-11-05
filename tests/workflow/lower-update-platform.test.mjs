import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const source = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const compile = (file) => ts.transpileModule(source(file), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText;
const loadRules = () => new Function(compile('src/utils/lower-update-platform.ts')
  .replace(/export /g, '') + '\nreturn { isStableUpdateClient, getLowerUpdateChannels, getLowerUpdateChannel, assertLowerUpdateManifest };')();

// Stable 客户端仅能选择 Stable；历史 Beta 和 CI 仅使用现行两个通道。
test('stable clients restrict both architecture selection and manifest acceptance', () => {
  const rules = loadRules();
  for (const version of ['0.8.0', null, '']) {
    assert.equal(rules.isStableUpdateClient(version), true);
    assert.deepEqual(rules.getLowerUpdateChannels('linux-arm64', version), ['stable']);
    assert.deepEqual(rules.getLowerUpdateChannels('linux-x64', version), []);
    assert.equal(rules.getLowerUpdateChannel('linux-arm64', 'ci', version), 'stable');
    assert.throws(() => rules.assertLowerUpdateManifest({ platform: 'linux-arm64', channel: 'ci' }, 'linux-arm64', 'ci', version), /通道/);
    rules.assertLowerUpdateManifest({ platform: 'linux-arm64', channel: 'stable' }, 'linux-arm64', 'stable', version);
  }
  for (const version of ['0.8.0-beta.1', '0.8.0-ci.1']) {
    assert.equal(rules.isStableUpdateClient(version), false);
    assert.deepEqual(rules.getLowerUpdateChannels('linux-arm64', version), ['stable', 'ci']);
    assert.deepEqual(rules.getLowerUpdateChannels('linux-x64', version), ['ci']);
  }
});

// 退役 Beta 不改变架构限制，旧选择归一到 Stable，Beta 清单不能进入新下载。
test('lower update architecture rules reject unsupported manifests and normalize x64 channel', () => {
  const rules = loadRules();
  assert.deepEqual(rules.getLowerUpdateChannels('linux-arm64'), ['stable', 'ci']);
  assert.deepEqual(rules.getLowerUpdateChannels('linux-x64'), ['ci']);
  assert.equal(rules.getLowerUpdateChannel('linux-x64', 'stable'), 'ci');
  assert.equal(rules.getLowerUpdateChannel('linux-arm64', 'beta'), 'stable');
  assert.throws(() => rules.assertLowerUpdateManifest({ platform: 'linux-arm64', channel: 'beta' }, 'linux-arm64', 'beta'), /通道/);
  assert.throws(() => rules.getLowerUpdateChannels('linux-unknown'), /不支持/);
  assert.throws(() => rules.assertLowerUpdateManifest({ platform: 'linux-arm64', channel: 'ci' }, 'linux-x64', 'ci'), /架构/);
  assert.throws(() => rules.assertLowerUpdateManifest({ platform: 'linux-x64', channel: 'stable' }, 'linux-x64', 'stable'), /通道/);
  rules.assertLowerUpdateManifest({ platform: 'linux-x64', channel: 'ci' }, 'linux-x64', 'ci');
});

// 实际渲染更多页：保留本地数据和配置导入导出，不再显示软件平台及地址。
test('settings retain local data and config actions without software platform details', () => {
  const require = createRequire(import.meta.url);
  const load = (file) => {
    const code = ts.transpileModule(source(file), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    const imports = (name) => {
      if (name === '../../adapters') return { api: {} };
      if (name === '../../utils/config-export') return {
        getConfigImportModeOptions: () => [],
        getConfigSectionOptions: () => [],
      };
      if (name === '../../offline/use-capability.ts') return { useCapability: () => false };
      if (name === '../../offline/ui/CapabilityGate.tsx') return { default: () => null, __esModule: true };
      if (name === './components/ConfigSectionPickerModal') return { default: () => null, __esModule: true };
      assert.ok(['react', 'react/jsx-runtime', 'antd', '@ant-design/icons'].includes(name), `未预期的设置页依赖：${name}`);
      return require(name);
    };
    new Function('require', 'module', 'exports', code)(imports, module, module.exports);
    return module.exports;
  };
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const Settings = load('src/pages/Settings/index.tsx').default;
  const html = renderToStaticMarkup(React.createElement(Settings));
  assert.match(html, /本地数据/);
  assert.match(html, /配置导入/);
  assert.doesNotMatch(html, /软件平台|60\.208\.15\.90|安装包均从此平台获取/);
});

function providerHarness(api, version = '0.8.0-ci.1') {
  api = { getAppVersion: async () => version, ...api };
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

// 历史 Beta 版本仍能运行更新协调器，但不再请求或下载退役通道。
test('legacy beta client only checks active stable and ci channels', async () => {
  const checks = [];
  const downloads = [];
  const render = providerHarness({
    checkLowerUpdate: async (channel, platform) => { checks.push(channel); return manifestFor(platform, channel); },
    listCachedLowerUpdates: async () => [],
    downloadLowerUpdate: async (manifest) => { downloads.push(manifest.channel); return { package_name: manifest.asset.name, package_path: '/active', downloaded_bytes: 1, sha256: 'abc' }; },
  }, '0.8.0-beta.1');
  render(); await settle();
  const value = render(); await settle();
  assert.deepEqual(checks, ['stable', 'ci']);
  assert.deepEqual(downloads, ['stable', 'ci']);
  assert.throws(() => value.ensureDownloaded(manifestFor('linux-arm64', 'beta')), /通道/);
});

// 实际执行后台协调器，Stable 启动后只检查和下载 Stable，版本未知时不请求目录。
test('stable auto downloads wait for client version and never request beta or ci', async () => {
  const checks = [];
  const downloads = [];
  let resolveVersion;
  const render = providerHarness({
    getAppVersion: () => new Promise((resolve) => { resolveVersion = resolve; }),
    checkLowerUpdate: async (channel, platform) => { checks.push(channel); return manifestFor(platform, channel); },
    listCachedLowerUpdates: async () => [],
    downloadLowerUpdate: async (manifest) => { downloads.push(manifest.channel); return { package_name: manifest.asset.name, package_path: '/stable', downloaded_bytes: 1, sha256: 'abc' }; },
  });
  let value = render(); await settle();
  assert.deepEqual(checks, []);
  resolveVersion('0.8.0'); await settle();
  value = render(); await settle();
  assert.deepEqual(checks, ['stable']);
  assert.deepEqual(downloads, ['stable']);
  assert.throws(() => value.ensureDownloaded(manifestFor('linux-arm64', 'ci')), /通道/);
  value.setPlatform('linux-x64'); render(); await settle();
  assert.deepEqual(checks, ['stable']);
});

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
  await settle(); value = render(); await settle();
  assert.deepEqual(checks, [['linux-arm64', 'stable'], ['linux-arm64', 'ci']]);
  const armPromise = value.ensureDownloaded(manifestFor('linux-arm64', 'ci'));
  value.setPlatform('linux-x64');
  value = render(); await settle();
  assert.deepEqual(checks.at(-1), ['linux-x64', 'ci']);
  assert.equal(downloads.length, 3, 'ARM CI 下载锁不能阻止 x64 CI');
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
