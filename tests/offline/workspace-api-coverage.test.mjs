import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const tauriSource = fs.readFileSync(path.join(repoRoot, 'src/adapters/tauri.ts'), 'utf8');
const adapterSource = fs.readFileSync(path.join(repoRoot, 'src/offline/adapter/workspace-api.ts'), 'utf8');

/** 从 tauri.ts 的 api 对象里提取全部接口名（含 `name,` 简写形式）。 */
function extractTauriApiMethods(source) {
  const declarationIndex = source.indexOf('export const api');

  assert.ok(declarationIndex >= 0, '未找到 tauri api 定义');

  // api 对象是该文件最后一段，声明之后的两个空格缩进成员即为接口名。
  const body = source.slice(declarationIndex);
  const names = new Set();

  for (const match of body.matchAll(/^ {2}([a-zA-Z0-9_]+)\s*[,:]/gm)) {
    names.add(match[1]);
  }

  return names;
}

/** 提取适配器导出的接口名清单（按方括号配对，避免被 `as const` 之类后缀误导）。 */
function extractStringArray(source, exportName) {
  const declarationIndex = source.indexOf(`export const ${exportName}`);

  assert.ok(declarationIndex >= 0, `未找到导出的接口清单: ${exportName}`);

  const openIndex = source.indexOf('[', declarationIndex);

  assert.ok(openIndex >= 0, `未找到 ${exportName} 的数组起始位置`);

  let depth = 0;
  let closeIndex = -1;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;

      if (depth === 0) {
        closeIndex = index;
        break;
      }
    }
  }

  assert.ok(closeIndex > openIndex, `未找到 ${exportName} 的数组结束位置`);

  const body = source.slice(openIndex + 1, closeIndex);

  return new Set([...body.matchAll(/'([^']+)'|"([^"]+)"/g)].map((item) => item[1] ?? item[2]));
}

// 离线适配器必须覆盖或显式转发每一个 tauri 接口，漏掉的接口在离线模式下会直接打到设备。
test('workspace adapter covers every tauri api method', () => {
  const methods = extractTauriApiMethods(tauriSource);
  const overrides = extractStringArray(adapterSource, 'WORKSPACE_OVERRIDE_METHODS');
  const delegated = extractStringArray(adapterSource, 'DELEGATED_API_METHODS');

  assert.ok(methods.size > 100, `tauri 接口数量异常: ${methods.size}`);

  const missing = [...methods].filter((method) => !overrides.has(method) && !delegated.has(method));

  assert.deepEqual(missing, [], `以下接口既未覆盖也未转发：${missing.join('、')}`);
});

// 覆盖与转发必须互斥，避免同一接口同时存在两套语义。
test('workspace adapter override and delegated lists are disjoint', () => {
  const overrides = extractStringArray(adapterSource, 'WORKSPACE_OVERRIDE_METHODS');
  const delegated = extractStringArray(adapterSource, 'DELEGATED_API_METHODS');
  const both = [...overrides].filter((method) => delegated.has(method));

  assert.deepEqual(both, [], `以下接口同时出现在两个清单里：${both.join('、')}`);
});

// 清单里不得出现 tauri 不存在的接口名（拼错会静默失效）。
test('workspace adapter lists only known tauri api methods', () => {
  const methods = extractTauriApiMethods(tauriSource);
  const overrides = extractStringArray(adapterSource, 'WORKSPACE_OVERRIDE_METHODS');
  const delegated = extractStringArray(adapterSource, 'DELEGATED_API_METHODS');
  const unknown = [...overrides, ...delegated].filter((method) => !methods.has(method));

  assert.deepEqual(unknown, [], `以下接口在 tauri api 中不存在：${unknown.join('、')}`);
});

// 运行态控制与明确不支持的接口必须由离线适配器覆盖，不能被转发到设备。
test('runtime control and unsupported methods are overridden', () => {
  const overrides = extractStringArray(adapterSource, 'WORKSPACE_OVERRIDE_METHODS');
  const required = [
    'startModule',
    'stopModule',
    'iec104StartLink',
    'iec104StopLink',
    'iec104SendTimeSync',
    'modbusRtuStartLink',
    'modbusRtuStopLink',
    'dlt645StartLink',
    'dlt645StopLink',
    'agcStartGroup',
    'agcStopGroup',
    'iec61850ListModels',
    'controlOrchestratorListSequences',
  ];

  for (const method of required) {
    assert.ok(overrides.has(method), `${method} 必须由离线适配器覆盖`);
  }
});

// 本地能力（设置、更新、纵密、.mskcfg 文件读写）必须转发真实实现，离线也要能用。
test('local capability methods are delegated to the real api', () => {
  const delegated = extractStringArray(adapterSource, 'DELEGATED_API_METHODS');
  const required = [
    'loadAppSettings',
    'saveAppSetting',
    'getRuntimePaths',
    'openRuntimeDirectory',
    'checkLowerUpdate',
    'downloadLowerUpdate',
    'getVerticalSecurityStatus',
    'saveFullConfigExport',
    'loadFullConfigExport',
  ];

  for (const method of required) {
    assert.ok(delegated.has(method), `${method} 必须转发真实实现`);
  }
});
