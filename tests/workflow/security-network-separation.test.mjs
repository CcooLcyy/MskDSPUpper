import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// 执行实际生成器；仅替换桌面文件对话框与IPC，避免测试写文件或连接设备。
const source = readFileSync(new URL('../../src/utils/vertical-security-script.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const fixtureSource = compiled
  .replace(/^import \{ save \} from ['"]@tauri-apps\/plugin-dialog['"];?$/m, 'const save = async () => null;')
  .replace(/^import \{ api \} from ['"]\.\.\/adapters['"];?$/m, `
const calls = [];
const api = {
  saveVerticalSecurityScript: async (path, content) => { calls.push({ kind: 'save', path, content }); return path; },
  deployVerticalSecurityScript: async request => { calls.push({ kind: 'deploy', ...request }); return { script_path: '/fixture/script.sh' }; },
};
export const takeCalls = () => calls.splice(0);
`);
const generator = await import('data:text/javascript;base64,' + Buffer.from(fixtureSource).toString('base64'));
const values = {
  device: 'fixture', localRtuAddress: '10.10.1.10', localSecurityAddress: '10.10.1.20',
  localGatewayAddress: '10.10.1.1', remoteRtuAddress: '10.20.1.10', remoteSecurityAddress: '10.20.1.20',
  remoteGatewayAddress: '10.20.1.1',
};

// 业务脚本不再拥有维护网段，不删除旧配置，保留业务与共享转发依赖。
test('业务生成器移除维护通路且保留业务链路', () => {
  const script = generator.buildVerticalSecurityScript(values);
  assert.doesNotMatch(script, /11\.22\.33\.|eth0\.101|proxy_arp|fixed_network|POSTROUTING|SNAT/);
  assert.match(script, /sysctl -w net\.ipv4\.ip_forward=1/);
  assert.match(script, /ip addr replace "\$\{LOCAL_GATEWAY_ADDRESS\}\/32" dev eth0\.107/);
  assert.match(script, /ip route replace "\$\{LOCAL_SECURITY_ADDRESS\}\/32" dev eth0\.107/);
  assert.match(script, /ip addr replace "\$\{LOCAL_RTU_ADDRESS\}\/32" dev eth0\.108/);
  assert.match(script, /ip route replace "\$\{REMOTE_RTU_ADDRESS\}\/32" via 192\.168\.8\.220 dev eth0\.108/);
  assert.match(script, /ip route replace "\$\{REMOTE_SECURITY_ADDRESS\}\/32" dev ppp0/);
  assert.match(script, /iptables -t nat -I PREROUTING 1 -i ppp0/);
  assert.match(script, /nf_conntrack_generic_timeout=3/);
  assert.match(script, /nf_conntrack_generic_timeout=600/);
  assert.match(script, /REMOTE_GATEWAY_ADDRESS=\$\{REMOTE_GATEWAY_ADDRESS\}/);
  assert.doesNotMatch(script, /ip(?: address| addr)? (?:del|flush)|iptables -F|ip_forward=0/);
});

// 查看/导出与部署必须使用同一业务脚本，不能在某条路径重新夹带维护逻辑。
test('导出和部署与业务预览生成内容一致', async () => {
  const expected = generator.buildVerticalSecurityScript(values);
  await generator.saveVerticalSecurityScript(values);
  await generator.deployVerticalSecurityScript(values, {
    uploadAccount: 'fixture@192.0.2.5:22', installDir: '/fixture',
    auth: { method: 'certificate' }, sudoPassword: 'fixture-secret',
  });
  const calls = generator.takeCalls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].content, expected);
  assert.equal(calls[1].script_content, expected);
  assert.doesNotMatch(calls[1].script_content, /fixture-secret|11\.22\.33\./);
});

// 拆分不放松业务地址校验，非法输入不能流入脚本。
test('拆分后仍拒绝非法业务地址与空目标', () => {
  for (const value of ['', '10.0.0.999', '10.0.0.1\necho fixture', '$(echo fixture)']) {
    assert.throws(() => generator.buildVerticalSecurityScript({ ...values, localRtuAddress: value }));
  }
  assert.throws(() => generator.buildVerticalSecurityScript({ ...values, device: ' ' }));
});
