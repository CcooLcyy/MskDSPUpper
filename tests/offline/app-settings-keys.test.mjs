import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const coreSource = fs.readFileSync(path.join(repoRoot, 'src/utils/app-settings-core.ts'), 'utf8');
const storageSource = fs.readFileSync(
  path.join(repoRoot, 'src-tauri/src/commands/app_storage.rs'),
  'utf8',
);

/** 前端声明的设置键：常量名 → 键值。 */
function extractFrontendKeys(source) {
  const keys = new Map();

  for (const match of source.matchAll(/export const ([A-Z0-9_]+_SETTING_KEY)\s*=\s*'([^']+)'/g)) {
    keys.set(match[1], match[2]);
  }

  return keys;
}

/** Rust 侧声明的设置键常量：常量名 → 键值。 */
function extractRustKeyConstants(source) {
  const keys = new Map();

  for (const match of source.matchAll(/pub const ([A-Z0-9_]+_KEY)\s*:\s*&str\s*=\s*"([^"]+)"/g)) {
    keys.set(match[1], match[2]);
  }

  return keys;
}

/** `validate_setting_key` 白名单里允许的常量名。 */
function extractRustWhitelist(source) {
  const match = source.match(/fn validate_setting_key[\s\S]*?match key \{([\s\S]*?)\n {4}\}/);

  assert.ok(match, '未找到 Rust 侧 validate_setting_key 白名单');

  return new Set([...match[1].matchAll(/([A-Z0-9_]+_KEY)/g)].map((item) => item[1]));
}

// 前端使用的每个设置键都必须被 Rust 白名单接受，否则保存时会返回“不支持的上位机设置项”。
test('every frontend setting key is whitelisted by the tauri settings store', () => {
  const frontendKeys = extractFrontendKeys(coreSource);
  const rustConstants = extractRustKeyConstants(storageSource);
  const whitelist = extractRustWhitelist(storageSource);
  const allowedValues = new Set([...whitelist].map((name) => rustConstants.get(name)).filter(Boolean));

  assert.ok(frontendKeys.size >= 5, `前端设置键数量异常: ${frontendKeys.size}`);

  for (const [name, value] of frontendKeys) {
    assert.ok(allowedValues.has(value), `设置键 ${name}（${value}）未出现在 Rust 白名单中`);
  }
});

// 白名单里的常量都必须能解析到具体键值，避免写出无法识别的常量名。
test('rust whitelist entries resolve to concrete key names', () => {
  const rustConstants = extractRustKeyConstants(storageSource);
  const whitelist = extractRustWhitelist(storageSource);
  const unresolved = [...whitelist].filter((name) => !rustConstants.has(name));

  assert.deepEqual(unresolved, []);
});
