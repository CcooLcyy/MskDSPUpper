import type { VerticalSecurityOperatorKind as Kind, VerticalSecurityOperatorRow as Row, VerticalSecurityOperatorRequest, VerticalSecurityOperatorResult as Result, VerticalSecurityNetworkRequest, VerticalSecurityNetworkAddresses } from '../adapters/types';

export type AutoConfigAddresses = VerticalSecurityNetworkAddresses;
type DspTarget = { upload_account: string; auth_method: 'password' | 'certificate' };
const connectionStorageKey = 'mskdsp.vertical-security.dsp-target.v1';
let currentConnection: VerticalSecurityNetworkRequest | null = null;
let connectionRevision = 0;
let observedTarget: DspTarget | null = null;
const targetMatches = (left: DspTarget | null, right: DspTarget | null) => left?.upload_account === right?.upload_account && left?.auth_method === right?.auth_method;
const targetOf = (request: VerticalSecurityNetworkRequest): DspTarget => ({ upload_account: request.upload_account, auth_method: request.auth.method });
function normalizeTarget(value: unknown): DspTarget | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.upload_account !== 'string' || !['password', 'certificate'].includes(String(input.auth_method))) return null;
  const account = input.upload_account.trim();
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)@([A-Za-z0-9_.-]+):(\d+)$/.exec(account);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return null;
  return { upload_account: `${match[1]}@${match[2]}:${Number(match[3])}`, auth_method: input.auth_method as DspTarget['auth_method'] };
}
export function getSecurityDspTarget(): DspTarget | null {
  let target: DspTarget | null = null;
  try {
    const record = JSON.parse(localStorage.getItem(connectionStorageKey) ?? 'null');
    target = record?.version === 1 ? normalizeTarget(record.target) : null;
  } catch { /* 未知或损坏目标不能回退至上一次设备。 */ }
  if (!targetMatches(target, observedTarget)) { observedTarget = target; currentConnection = null; connectionRevision += 1; }
  return target;
}
export function getSecurityDspConnectionRevision(): number { getSecurityDspTarget(); return connectionRevision; }
export function clearSecurityDspConnection(): void {
  currentConnection = null; observedTarget = null; connectionRevision += 1;
  localStorage.removeItem(connectionStorageKey);
}
export function rememberSecurityDspConnection(request: VerticalSecurityNetworkRequest): void {
  const target = normalizeTarget(targetOf(request));
  if (!target) { clearSecurityDspConnection(); return; }
  if (!targetMatches(getSecurityDspTarget(), target)) { currentConnection = null; connectionRevision += 1; }
  currentConnection = { upload_account: target.upload_account, auth: request.auth.method === 'password' ? { method: 'password', password: request.auth.password } : { method: 'certificate' } };
  // 目标关联可持久化，SSH 密码仅保留在当前进程内存，不保存业务地址快照。
  localStorage.setItem(connectionStorageKey, JSON.stringify({ version: 1, target }));
  observedTarget = target;
}
export async function resolveSecurityDspConnection(getCredentials: (account: string) => Promise<{ ssh_password: string | null; sudo_password: string | null } | null>): Promise<VerticalSecurityNetworkRequest> {
  const target = getSecurityDspTarget();
  if (!target) throw new Error('请先在“DSP 网络配置”页面配置目标设备和连接认证，再进行自动配置。');
  if (target.auth_method === 'certificate') return { upload_account: target.upload_account, auth: { method: 'certificate' } };
  if (currentConnection?.auth.method === 'password' && currentConnection.auth.password && targetMatches(target, targetOf(currentConnection))) return { upload_account: target.upload_account, auth: { ...currentConnection.auth } };
  const revision = connectionRevision;
  const credentials = await getCredentials(target.upload_account);
  if (revision !== connectionRevision || !targetMatches(getSecurityDspTarget(), target)) throw new Error('DSP 连接目标已变化，请重新点击自动配置。');
  if (currentConnection?.auth.method === 'password' && currentConnection.auth.password) return { upload_account: target.upload_account, auth: { ...currentConnection.auth } };
  if (!credentials?.ssh_password) throw new Error('请先在“DSP 网络配置”页面补齐当前目标的 SSH 认证，再进行自动配置。');
  return { upload_account: target.upload_account, auth: { method: 'password', password: credentials.ssh_password } };
}
const addressKeys = ['localRtuAddress', 'localSecurityAddress', 'localGatewayAddress', 'remoteRtuAddress', 'remoteSecurityAddress', 'remoteGatewayAddress'] as const;
export const autoConfigOrder: Kind[] = ['network', 'routes', 'tunnels', 'policies'];
const validIp = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value) && value.split('.').every(part => Number(part) <= 255);
function normalize(value: unknown): AutoConfigAddresses | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const normalized = Object.fromEntries(addressKeys.map(key => [key, typeof input[key] === 'string' ? input[key].trim() : input[key]]));
  if (input.device !== 'MskDSP' || !addressKeys.every(key => validIp(normalized[key]))) return null;
  return { device: 'MskDSP', ...normalized } as AutoConfigAddresses;
}
export function buildAutoConfig(value: AutoConfigAddresses, certificate: string): Record<Kind, Row[]> {
  const a = normalize(value);
  if (!a) throw new Error('请先完成 DSP 网络配置，再进行自动配置。');
  if (!certificate) throw new Error('请先选择管理员已导入的主站加密网关证书。');
  return {
    network: [
      { description: 'Just', interface: 'eth1', interface_type: 'PRIVATE', ip: '192.168.8.220', netmask: '255.255.255.0', vlan: '0' },
      { description: 'Just', interface: 'eth2', interface_type: 'PUBLIC', ip: a.localSecurityAddress, netmask: '255.255.255.0', vlan: '0' },
    ],
    routes: [
      { name: 'name', interface: 'eth1', vlan: '0', destination: a.localRtuAddress, netmask: '255.255.255.0', gateway: '192.168.8.219', table_id: '', source: '', source_mask: '' },
      { name: 'name', interface: 'eth2', vlan: '0', destination: '0.0.0.0', netmask: '0.0.0.0', gateway: a.localGatewayAddress, table_id: '', source: '', source_mask: '' },
    ],
    // 原厂未启用备用端时仍要求证书哨兵，不代表选择了备用证书。
    tunnels: [{ name: 'test', id: '1', mode: '0', local_ip: a.localSecurityAddress, primary_ip: a.remoteSecurityAddress, primary_certificate: certificate, backup_ip: '0.0.0.0', backup_certificate: 'cert2.pem', lifetime: '10000', capacity: '5000000' }],
    policies: ['1', '2', '3', '4'].map((id, index) => ({
      id, tunnel_id: '1', mode: '0', description: 'desc', source_start: a.localRtuAddress, source_end: a.localRtuAddress,
      destination_start: a.remoteRtuAddress, destination_end: a.remoteRtuAddress,
      protocol: index < 2 ? '1' : '2', direction: index % 2 === 0 ? '1' : '2',
      source_port_start: index < 2 ? '1' : '2404', source_port_end: index < 2 ? '1' : '2404',
      destination_port_start: index < 2 ? '1' : '1024', destination_port_end: index < 2 ? '1' : '65535',
    })),
  };
}
export async function uploadAutoConfig(sessionId: string, rows: Record<Kind, Row[]>, request: (value: VerticalSecurityOperatorRequest) => Promise<Result>, current: () => boolean, progress: (kind: Kind, result: Result) => void): Promise<void> {
  for (const kind of autoConfigOrder) {
    if (!current()) throw new Error('自动配置已中止，未继续上传或重启。');
    const read = await request({ session_id: sessionId, action: 'read', kind });
    if (!current()) throw new Error('自动配置会话已变化，未继续上传或重启。');
    if (read.kind !== kind || !read.revision) throw new Error('读取配置版本失败，已停止自动配置。');
    const result = await request({ session_id: sessionId, action: 'save', kind, revision: read.revision, rows: rows[kind].map(row => ({ ...row })) });
    if (!current()) throw new Error('自动配置会话已变化，请核实已经上传的配置。');
    if (result.kind !== kind || !result.revision || !Array.isArray(result.rows) || !result.verified) throw new Error(result.message || '配置上传未完成回读核对，已停止，不会重启。');
    progress(kind, result);
  }
}
