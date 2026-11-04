export const FACTORY_PLATFORM_TARGET = '60.208.15.90:50000';

export interface OrdinaryNetworkConfig {
  interface_name: string;
  gateway: string;
  dns_servers: string[];
}

/** 每次返回独立数组，避免请求被修改后污染后续固定配置。 */
export function ordinaryNetworkPreset(): OrdinaryNetworkConfig {
  return { interface_name: 'eth0.102', gateway: '192.168.2.1', dns_servers: [] };
}

export function isOrdinaryNetworkPresetApplied(status: PlatformAccessStatus | null): boolean {
  return normalizeDeviceArchitecture(status?.device_architecture) === 'arm64' && isOrdinaryNetworkApplied(status);
}

/** 架构由当前下位机报告，不根据上位机架构或连接地址推断。 */
export function normalizeDeviceArchitecture(value?: string): 'arm64' | 'x64' | null {
  const architecture = value?.trim().toLowerCase();
  if (architecture === 'arm64' || architecture === 'aarch64') return 'arm64';
  if (architecture === 'x64' || architecture === 'x86_64' || architecture === 'amd64') return 'x64';
  return null;
}

function architectureIdentity(status: PlatformAccessStatus): string {
  return normalizeDeviceArchitecture(status.device_architecture) ?? status.device_architecture?.trim().toLowerCase() ?? '';
}

function networkForDevice(status: PlatformAccessStatus): OrdinaryNetworkConfig | undefined {
  if (!status.network_config) return undefined;
  const architecture = normalizeDeviceArchitecture(status.device_architecture);
  if (architecture === 'arm64') return ordinaryNetworkPreset();
  if (architecture === 'x64') return { interface_name: '', gateway: '', dns_servers: [] };
  return undefined;
}

export function isOrdinaryNetworkApplied(status: PlatformAccessStatus | null): boolean {
  if (!status) return false;
  const expected = networkForDevice(status);
  const network = status.network_config;
  return Boolean(expected && network && status.network_applied && !status.network_error
    && network.interface_name === expected.interface_name && network.gateway === expected.gateway
    && network.dns_servers.length === 0);
}

export interface PlatformAccessStatus {
  enabled: boolean;
  platform_target: string;
  device_id: string;
  token_configured: boolean;
  ssh_enabled: boolean;
  ssh_port: number;
  revision: string;
  online: boolean;
  last_error: string;
  connection_generation: string;
  manager_address: string;
  device_architecture?: string;
  network_config?: OrdinaryNetworkConfig | null;
  network_applied?: boolean;
  network_error?: string;
  network_source_address?: string;
}
export interface PlatformAccessForm {
  enabled: boolean;
  device_id: string;
  device_token: string;
  clear_device_token: boolean;
  ssh_enabled: boolean;
  ssh_port: number;
}
export interface PlatformAccessRequest extends PlatformAccessForm {
  network_config?: OrdinaryNetworkConfig;
  expected_revision: string;
  connection_generation: string;
  manager_address: string;
}
export interface PlatformAccessApi {
  read(): Promise<PlatformAccessStatus>;
  save(request: PlatformAccessRequest): Promise<PlatformAccessStatus>;
}

export function platformAccessRequest(status: PlatformAccessStatus, form: PlatformAccessForm): PlatformAccessRequest {
  const deviceId = form.device_id.trim();
  if ((deviceId && !/^[A-Za-z0-9._-]{1,128}$/.test(deviceId)) || (form.enabled && !deviceId)) {
    throw new Error('设备 ID 应为 1～128 个字母、数字、点、下划线或连字符');
  }
  if (form.device_token && (!/^[\x21-\x7e]+$/.test(form.device_token) || form.device_token.length > 4096)) {
    throw new Error('设备令牌最多 4096 个可见 ASCII 字符');
  }
  if (form.clear_device_token && form.device_token) throw new Error('不能同时填写新令牌和清除已有令牌');
  if (form.enabled && form.clear_device_token) throw new Error('清除令牌前请先关闭平台接入');
  if (form.enabled && !form.device_token && !status.token_configured) throw new Error('开启平台接入前请填写设备令牌');
  if (status.token_configured && deviceId !== status.device_id && !form.device_token && !form.clear_device_token) {
    throw new Error('更换设备 ID 时请提供新令牌，或关闭接入并显式清除旧令牌');
  }
  const sshPort = form.ssh_port === 0 ? 10022 : form.ssh_port;
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('SSH 端口应为 1～65535');
  const network = networkForDevice(status);
  return { enabled: form.enabled, device_token: form.device_token, clear_device_token: form.clear_device_token,
    ssh_enabled: form.ssh_enabled, ...(network ? { network_config: network } : {}),
    device_id: deviceId, ssh_port: sshPort, expected_revision: status.revision,
    connection_generation: status.connection_generation, manager_address: status.manager_address };
}

const emptyForm = (): PlatformAccessForm => ({ enabled: false, device_id: '', device_token: '', clear_device_token: false, ssh_enabled: true, ssh_port: 10022 });
const formFrom = (status: PlatformAccessStatus): PlatformAccessForm => ({ enabled: status.enabled, device_id: status.device_id,
  device_token: '', clear_device_token: false, ssh_enabled: status.ssh_enabled, ssh_port: status.ssh_port || 10022 });
interface Snapshot {
  status: PlatformAccessStatus | null;
  form: PlatformAccessForm;
  loading: boolean;
  saving: boolean;
  saved: boolean;
  needsReload: boolean;
  error: string | null;
}
const initial = (): Snapshot => ({ status: null, form: emptyForm(), loading: false, saving: false, saved: false, needsReload: false, error: null });
function failure(error: unknown) {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return { message: error.message, kind: 'kind' in error ? error.kind : '' };
  }
  return { message: typeof error === 'string' ? error : '下位机配置请求失败，请检查现场连接', kind: '' };
}

/** 页面生命期内的草稿与异步边界；不写入工作区、应用设置或浏览器存储。 */
export function createPlatformAccessController(api: PlatformAccessApi) {
  let snapshot = initial();
  let epoch = 0;
  let operation = 0;
  let polling = false;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<Snapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); };
  function apply(status: PlatformAccessStatus, saved: boolean) {
    update({ status, form: formFrom(status), saved, needsReload: false, error: null });
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset() { epoch += 1; operation += 1; polling = false; snapshot = initial(); listeners.forEach(fn => fn()); },
    update(patch: Partial<PlatformAccessForm>) { update({ form: { ...snapshot.form, ...patch }, saved: false }); },
    async read() {
      if (snapshot.saving) return;
      const current = epoch; const requestId = ++operation;
      update({ loading: true, error: null });
      try { const status = await api.read(); if (current === epoch && requestId === operation) apply(status, false); }
      catch (error) { if (current === epoch && requestId === operation) update({ error: failure(error).message, needsReload: true }); }
      finally { if (current === epoch && requestId === operation) update({ loading: false }); }
    },
    async save() {
      if (!snapshot.status || snapshot.loading || snapshot.saving || snapshot.needsReload) return;
      let request: PlatformAccessRequest;
      try { request = platformAccessRequest(snapshot.status, snapshot.form); }
      catch (error) { update({ error: failure(error).message }); return; }
      const current = epoch; const requestId = ++operation;
      const architecture = architectureIdentity(snapshot.status);
      update({ saving: true, saved: false, error: null });
      try {
        const status = await api.save(request);
        if (current === epoch && requestId === operation) {
          if (status.connection_generation !== request.connection_generation || status.manager_address !== request.manager_address
            || architectureIdentity(status) !== architecture) {
            update({ status, saved: false, needsReload: true, error: '设备连接或架构已变化，请重新读取当前下位机配置' });
          } else if (request.network_config && !isOrdinaryNetworkApplied(status)) {
            update({ status, saved: false, needsReload: true, error: '设备未确认对应架构的普通外网配置已应用，请重新读取设备状态后再保存' });
          } else apply(status, true);
        }
      }
      catch (error) {
        if (current === epoch && requestId === operation) {
          const problem = failure(error);
          update({ error: problem.message, needsReload: Boolean(request.network_config) || ['revision_conflict', 'connection_changed', 'unsupported', 'network_apply_failed', 'timeout', 'persist_failed'].includes(String(problem.kind)) });
        }
      } finally { if (current === epoch && requestId === operation) update({ saving: false }); }
    },
    async refreshRuntime() {
      if (!snapshot.status || snapshot.loading || snapshot.saving || polling || snapshot.needsReload) return;
      const current = epoch; const requestId = operation;
      polling = true;
      try {
        const status = await api.read();
        if (current !== epoch || requestId !== operation || !snapshot.status) return;
        if (status.connection_generation !== snapshot.status.connection_generation || status.manager_address !== snapshot.status.manager_address) {
          update({ saved: false, needsReload: true, error: '现场连接已切换，请重新读取当前下位机配置' });
        } else if (architectureIdentity(status) !== architectureIdentity(snapshot.status)) {
          update({ status, saved: false, needsReload: true, error: '设备架构已变化，请重新读取后再保存' });
        } else if (status.revision !== snapshot.status.revision) {
          update({ status, saved: false, needsReload: true, error: '下位机配置已变化，请重新读取后再保存' });
        } else update({ status, ...(networkForDevice(snapshot.status) && !isOrdinaryNetworkApplied(status) ? { saved: false } : {}) });
      } catch (error) {
        if (current === epoch && requestId === operation) {
          const problem = failure(error);
          update({ error: problem.message, needsReload: ['revision_conflict', 'connection_changed', 'unsupported', 'direct_only'].includes(String(problem.kind)) });
        }
      }
      finally { if (current === epoch) polling = false; }
    },
  };
}
