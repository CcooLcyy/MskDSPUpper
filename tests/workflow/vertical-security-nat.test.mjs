import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/utils/vertical-security-script.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace(/^import \{ save \} from ['"]@tauri-apps\/plugin-dialog['"];?$/m, 'const save = async () => null;')
  .replace(/^import \{ api \} from ['"]\.\.\/adapters['"];?$/m, 'const api = {};');
const generator = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const script = generator.buildVerticalSecurityScript({
  device: '命令桩设备', localRtuAddress: '10.10.1.10', localSecurityAddress: '10.10.1.20',
  localGatewayAddress: '10.10.1.1', remoteRtuAddress: '10.20.1.10', remoteSecurityAddress: '10.20.1.20',
  remoteGatewayAddress: '10.20.1.1',
});
const fixture = fileURLToPath(new URL('./vertical_security_nat_test.py', import.meta.url));
const inventory = process.platform === 'win32'
  ? spawnSync('wsl.exe', ['--list', '--quiet'], { encoding: 'utf16le', timeout: 20_000 }) : null;
const unavailable = inventory && (inventory.error?.code === 'ENOENT' || inventory.status !== 0 || !inventory.stdout.trim());

for (const [scenario, description] of [
  ['fresh', '动态 PPP 地址生成不限协议精准双向 NAT'],
  ['initial_wait', 'PPP 初始不可用时等待后再生成当前地址规则'],
  ['migrate', '旧地址和协议253规则精确迁移且保留维护规则'],
  ['repeated', '重复应用不叠加 NAT 规则'],
  ['watch', 'PPP 换地址和同地址重连同步恢复业务规则'],
  ['error', '连接刷新错误退出恢复600秒超时'],
  ['terminate', '连接刷新收到TERM恢复600秒超时'],
  ['interrupted_migration', '换卡地址迁移中断后重跑不残留中间NAT规则'],
]) {
  // 实际执行生成的 Bash；所有网络命令通过临时命令桩，绝不访问设备或真实网络。
  test(description, (context) => {
    if (unavailable) { context.skip('需要 Linux 或 WSL 执行业务脚本命令桩'); return; }
    const linuxPath = fixture.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
    const result = spawnSync(process.platform === 'win32' ? 'wsl.exe' : 'python3',
      process.platform === 'win32' ? ['--exec', 'python3', '-B', linuxPath] : ['-B', fixture],
      { input: JSON.stringify({ script, scenario }), encoding: 'utf8', timeout: 45_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
