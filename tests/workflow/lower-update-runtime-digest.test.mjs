import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// 验证镜像摘要解析使用真实 tar 流和 Docker 导出失败/超时替身。
test('lower update normalizes runtime manifest references to verified config digests', () => {
  const scriptPath = fileURLToPath(new URL('./lower_update_runtime_digest_test.py', import.meta.url));
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [scriptPath], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
