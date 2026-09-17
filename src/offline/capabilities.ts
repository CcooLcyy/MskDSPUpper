/**
 * 离线工作区能力矩阵。
 *
 * 这里是"离线模式支持什么"的唯一台账：页面不判断模式，只查询能力，
 * 新增第三种模式（如只读巡检）时只需追加一张矩阵。
 */

export type AppMode = 'online' | 'offline';

/** 全部能力键。两张矩阵必须覆盖同一组键，避免漏配导致门禁失效。 */
export const ALL_CAPABILITIES = [
  'config.read',
  'config.write',
  'config.export',
  'config.push',
  'runtime.read',
  'runtime.control',
  'realtime',
  'soe',
  'module.ops',
  'iec61850',
  'orchestrator',
  'local.settings',
] as const;

export type Capability = (typeof ALL_CAPABILITIES)[number];

export type CapabilityMatrix = Record<Capability, boolean>;

/** 在线模式保持全部能力为真，确保门禁分支与改造前行为等价。 */
const ONLINE_CAPABILITIES: CapabilityMatrix = {
  'config.read': true,
  'config.write': true,
  'config.export': true,
  'config.push': true,
  'runtime.read': true,
  'runtime.control': true,
  realtime: true,
  soe: true,
  'module.ops': true,
  iec61850: true,
  orchestrator: true,
  'local.settings': true,
};

/** 离线工作区只保留配置读写、导出与本地能力，运行态与控制类能力全部关闭。 */
const OFFLINE_CAPABILITIES: CapabilityMatrix = {
  'config.read': true,
  'config.write': true,
  'config.export': true,
  'config.push': false,
  'runtime.read': false,
  'runtime.control': false,
  realtime: false,
  soe: false,
  'module.ops': false,
  iec61850: false,
  orchestrator: false,
  'local.settings': true,
};

const CAPABILITY_MATRICES: Record<AppMode, CapabilityMatrix> = {
  online: ONLINE_CAPABILITIES,
  offline: OFFLINE_CAPABILITIES,
};

/** 返回能力矩阵副本，避免调用方修改后影响其他页面。 */
export function capabilitiesFor(mode: AppMode): CapabilityMatrix {
  return { ...CAPABILITY_MATRICES[mode] };
}

export function isCapabilityEnabled(mode: AppMode, capability: Capability): boolean {
  return CAPABILITY_MATRICES[mode][capability] === true;
}

/** 列出当前模式下被禁用的能力，供日志与调试使用。 */
export function disabledCapabilities(mode: AppMode): Capability[] {
  const matrix = CAPABILITY_MATRICES[mode];
  return ALL_CAPABILITIES.filter((capability) => matrix[capability] !== true);
}
