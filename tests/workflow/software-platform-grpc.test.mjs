import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
function loadAdapter(invoke, listen = async () => () => {}) {
  const code = ts.transpileModule(read('src/adapters/tauri.ts'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  let sequence = 0;
  return new Function('invoke', 'listen', 'getVersion', 'open', 'relaunch', 'crypto', 'check', `${code}\nreturn api;`)(
    invoke, listen, async () => '0.7.1', async () => null, async () => {},
    { randomUUID: () => `task-${++sequence}` }, async () => { throw new Error('禁止 HTTP 更新检查'); },
  );
}

// 实际执行适配器：查目录和安装都交由受校验的 Rust 命令，不再发 HTTP 更新检查。
test('desktop software updates invoke platform commands without HTTP updater checks', async () => {
  const calls = [];
  const info = { currentVersion: '0.7.1', version: '0.7.2', rawJson: { packageId: 'package-1' } };
  const api = loadAdapter(async (name, args) => { calls.push([name, args]); return info; });
  assert.equal(await api.checkAppUpdate(), info);
  assert.equal(await api.installAppUpdate(), info);
  await api.disposePendingAppUpdate();
  await api.checkLowerUpdate('ci', 'linux-x64');
  assert.deepEqual(calls, [
    ['check_app_update', undefined], ['install_app_update', undefined], ['dispose_app_update', undefined],
    ['check_lower_update', { channel: 'ci', platform: 'linux-x64' }],
  ]);
  assert.doesNotMatch(read('src/adapters/tauri.ts'), /@tauri-apps\/plugin-updater|getLowerUpdateStaticBaseUrl/);
});

// 真实监听回调必须只转发本任务进度，并在下载结束后释放监听器。
test('desktop app download correlates progress and releases its listener', async () => {
  let callback;
  let cleanup = 0;
  const events = [];
  const info = { currentVersion: '1', version: '2', rawJson: {} };
  const api = loadAdapter(async (name, args) => {
    assert.equal(name, 'download_app_update');
    assert.equal(args.taskId, 'task-1');
    callback({ payload: { task_id: 'different-task', event: 'Finished' } });
    callback({ payload: { task_id: args.taskId, event: 'Started', data: { contentLength: 4 } } });
    callback({ payload: { task_id: args.taskId, event: 'Progress', data: { chunkLength: 4 } } });
    callback({ payload: { task_id: args.taskId, event: 'Finished' } });
    return info;
  }, async (name, listener) => {
    assert.equal(name, 'app-update-download-progress');
    callback = listener;
    return () => { cleanup++; };
  });
  assert.equal(await api.downloadAppUpdate((event) => events.push(event)), info);
  assert.deepEqual(events.map((event) => event.event), ['Started', 'Progress', 'Finished']);
  assert.equal(cleanup, 1);
});

// 传输失败也必须释放监听器，不能让后续任务收到上一轮回调。
test('desktop app download failure still releases its listener', async () => {
  let cleanup = 0;
  const api = loadAdapter(async () => { throw new Error('平台断流'); }, async () => () => { cleanup++; });
  await assert.rejects(api.downloadAppUpdate(() => {}), /平台断流/);
  assert.equal(cleanup, 1);
});

// 执行真实 Provider：同版本不同包必须重下，失败仍可手动安装旧包。
function appProviderHarness(api) {
  const slots = []; let cursor = 0; let effects = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const React = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (!equal(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (!equal(slots[i]?.deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
    createElement: (_type, props) => props.value,
  };
  const code = ts.transpileModule(read('src/components/app-update/AppUpdateProvider.tsx'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
  }).outputText.replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*$/gm, '').replace(/export /g, '');
  const values = new Map();
  const window = { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }, setInterval: () => 1, clearInterval: () => {} };
  const Provider = new Function('React', 'api', 'AppUpdateContext', 'window',
    'const { useState, useRef, useMemo, useCallback, useEffect } = React;\n' + code + '\nreturn AppUpdateProvider;')(React, api, { Provider: {} }, window);
  return () => { cursor = 0; const value = Provider({ children: null }); const pending = effects; effects = []; pending.forEach((fn) => fn()); return value; };
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('app provider keeps old verified package after same-version replacement fails', async () => {
  const first = { currentVersion: '1', version: '2', rawJson: { packageId: 'first', sha256: 'aaa', channel: 'ci', platform: 'windows-x86_64-nsis' } };
  const second = { ...first, rawJson: { ...first.rawJson, packageId: 'second', sha256: 'bbb' } };
  let candidate = first; let fail = false; let downloads = 0; let installs = 0;
  const api = { getAppVersion: async () => '1', checkAppUpdate: async () => candidate,
    downloadAppUpdate: async () => { downloads++; if (fail) throw new Error('断流'); return candidate; },
    installAppUpdate: async () => { installs++; return first; }, disposePendingAppUpdate: async () => {} };
  const render = appProviderHarness(api);
  render(); await settle(); let value = render();
  assert.equal(value.downloadedUpdate, first); assert.equal(installs, 0);
  await value.checkForUpdate(); value = render(); assert.equal(downloads, 1, '同包复用');
  candidate = second; fail = true;
  await assert.rejects(value.checkForUpdate(), /断流/); value = render();
  assert.equal(downloads, 2); assert.equal(value.downloadedUpdate, first);
  assert.equal((await value.installUpdate()).kind, 'needs-choice'); assert.equal(installs, 0);
  value = render(); assert.equal((await value.installDownloadedUpdate()).update, first); assert.equal(installs, 1);
});
