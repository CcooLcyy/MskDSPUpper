import type { VerticalSecurityOperatorKind as Kind, VerticalSecurityOperatorRow as Row, VerticalSecurityOperatorRequest, VerticalSecurityOperatorResult as Result } from '../adapters/types';

export type AutoConfigAddresses = {
  device: string;
  localRtuAddress: string;
  localSecurityAddress: string;
  localGatewayAddress: string;
  remoteRtuAddress: string;
  remoteSecurityAddress: string;
  remoteGatewayAddress: string;
};
const storageKey = 'mskdsp.vertical-security.applied-network.v1';
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
export function getAppliedSecurityNetwork(): AutoConfigAddresses | null {
  try {
    const record = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    return record?.version === 1 ? normalize(record.addresses) : null;
  } catch { return null; }
}
export function clearAppliedSecurityNetwork(): void { localStorage.removeItem(storageKey); }
export function rememberAppliedSecurityNetwork(value: AutoConfigAddresses): void {
  const addresses = normalize(value);
  if (!addresses) throw new Error('DSP 网络配置地址不完整，未记录自动配置前置条件。');
  localStorage.setItem(storageKey, JSON.stringify({ version: 1, addresses }));
  console.info('[纵密自动配置] 已记录成功应用的 DSP 业务地址');
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
