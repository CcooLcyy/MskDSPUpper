import test from 'node:test';
import assert from 'node:assert/strict';

import {
  replaceCargoPackageVersion,
  replaceJsonVersion,
} from '../../scripts/workflow/lib/manifests.mjs';

// 验证 Cargo.toml 只修改 [package] 段版本，不影响其他依赖声明。
test('replaceCargoPackageVersion only updates package version', () => {
  const source = [
    '[package]',
    'name = "mskdsp-upper"',
    'version = "0.1.0"',
    '',
    '[dependencies]',
    'tauri = { version = "2", features = [] }',
  ].join('\n');

  const updated = replaceCargoPackageVersion(source, '0.1.0-nightly.20260408t010203+sha.abcdef1');
  assert.match(updated, /version = "0\.1\.0-nightly\.20260408t010203\+sha\.abcdef1"/);
  assert.match(updated, /\[dependencies\][\s\S]*tauri = \{ version = "2"/);
});

// 验证 JSON manifest 版本替换不会丢失其他字段。
test('replaceJsonVersion keeps existing json fields', () => {
  const updated = replaceJsonVersion(
    { name: 'upper', version: '0.1.0', private: true },
    '0.1.0-ci.20260408t010203+sha.abcdef1',
  );

  assert.deepEqual(updated, {
    name: 'upper',
    version: '0.1.0-ci.20260408t010203+sha.abcdef1',
    private: true,
  });
});
