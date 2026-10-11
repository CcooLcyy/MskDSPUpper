import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// 验证远端清理脚本在本地临时目录中的真实 Linux 文件系统边界。
test('lower update remote cleanup keeps the current package and refuses unsafe deletion', (context) => {
  const scriptPath = fileURLToPath(new URL('./lower_update_cleanup_test.py', import.meta.url));
  if (process.platform === 'win32') {
    const inventory = spawnSync('wsl.exe', ['--list', '--quiet'], {
      encoding: 'utf16le', timeout: 20_000,
    });
    if (inventory.error?.code === 'ENOENT' || (!inventory.error && (inventory.status !== 0 || !inventory.stdout.trim()))) {
      context.skip('Windows 未提供可用的 WSL Linux 发行版，真实目录描述符测试需在 Linux 执行');
      return;
    }
    assert.ifError(inventory.error);
  }
  const command = process.platform === 'win32' ? 'wsl.exe' : 'python3';
  const args = process.platform === 'win32'
    ? ['--exec', 'python3', '-B', scriptPath.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)]
    : ['-B', scriptPath];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
