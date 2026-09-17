/**
 * 离线导出自检。
 *
 * 导出的 `.mskcfg` 会被现场导入流程真实写入设备：点表、ConnTags 与路由
 * 都会以目标态覆盖，标签少了会静默剪除相关路由（见设计文档 §4.7/§4.9）。
 * 因此导出前必须跑一遍纯函数自检，把"会改坏现场"的问题拦在本地。
 */

import type { FullConfigExportSnapshot, StableDataBusConnTags } from '../../adapters/types.ts';
import { deriveConnTags } from './derive-tags.ts';
import { connectionKey } from './registry.ts';

export type SelfCheckLevel = 'error' | 'warning';

export interface SelfCheckIssue {
  level: SelfCheckLevel;
  code: string;
  message: string;
}

export interface SelfCheckOptions {
  /** 打底快照的标签注册表；用于检测"标签变少"这类会剪除路由的改动。 */
  baselineConnTags?: readonly StableDataBusConnTags[];
}

const MODULE_IEC104 = 'IEC104';
const MODULE_MODBUS_RTU = 'ModbusRTU';
const MODULE_MODBUS_TCP = 'ModbusTCP';
const MODULE_DLT645 = 'DLT645';
const MODULE_AGC = 'AGC';
const MODULE_AVC = 'AVC';
const MODULE_CALC = 'Calc';

interface DerivedEntry {
  key: string;
  label: string;
  tags: string[];
  pointTags: string[];
  /** 需要做重复地址检查的键；分组对象与 DLT645 不参与。 */
  addressKeys: string[];
  pointChecks: boolean;
}

export function selfCheckSnapshot(
  snapshot: FullConfigExportSnapshot,
  options: SelfCheckOptions = {},
): SelfCheckIssue[] {
  const issues: SelfCheckIssue[] = [];
  const connections = snapshot.config.data_bus.connections ?? [];
  const connTags = snapshot.config.data_bus.conn_tags ?? [];
  const routes = snapshot.config.data_bus.routes?.items ?? [];

  const labels = new Map<string, string>();
  const declaredConnections = new Set<string>();
  const declaredTags = new Map<string, string[]>();

  for (const connection of connections) {
    const key = connectionKey(connection.module_name, connection.conn_name);

    labels.set(key, `${connection.module_name}/${connection.conn_name}`);
    declaredConnections.add(key);
  }

  for (const entry of connTags) {
    const key = connectionKey(entry.module_name, entry.conn_name);
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    const duplicates = findDuplicates(tags);

    labels.set(key, `${entry.module_name}/${entry.conn_name}`);
    declaredTags.set(key, tags);

    if (duplicates.length > 0) {
      issues.push({
        level: 'error',
        code: 'duplicate-conn-tag',
        message: `连接 ${labels.get(key)} 的标签注册表存在重复标签：${duplicates.join('、')}`,
      });
    }
  }

  for (const entry of collectDerivedEntries(snapshot)) {
    if (entry.pointChecks) {
      const duplicateTags = findDuplicates(entry.pointTags);

      if (duplicateTags.length > 0) {
        issues.push({
          level: 'error',
          code: 'duplicate-point-tag',
          message: `连接 ${entry.label} 的点表存在重复标签：${duplicateTags.join('、')}`,
        });
      }

      const duplicateAddresses = findDuplicates(entry.addressKeys);

      if (duplicateAddresses.length > 0) {
        issues.push({
          level: 'error',
          code: 'duplicate-point-address',
          message: `连接 ${entry.label} 的点表存在重复地址：${duplicateAddresses.join('、')}`,
        });
      }

      if (entry.pointTags.length === 0) {
        issues.push({
          level: 'warning',
          code: 'link-without-points',
          message: `连接 ${entry.label} 的点表为空`,
        });
      }
    }

    const declared = declaredTags.get(entry.key);

    if (!declared) {
      continue;
    }

    const missing = entry.tags.filter((tag) => !declared.includes(tag));

    if (missing.length > 0) {
      issues.push({
        level: 'error',
        code: 'tags-missing',
        message: `连接 ${entry.label} 的标签注册表缺少模块会注册的标签：${missing.join('、')}`,
      });
    }

    const extra = declared.filter((tag) => !entry.tags.includes(tag));

    if (extra.length > 0) {
      issues.push({
        level: 'warning',
        code: 'tags-extra',
        message: `连接 ${entry.label} 的标签注册表包含模块不会注册的标签：${extra.join('、')}`,
      });
    }
  }

  for (const route of routes) {
    for (const endpoint of [route.src, route.dst]) {
      const key = connectionKey(endpoint.module_name, endpoint.conn_name);
      const label = `${endpoint.module_name}/${endpoint.conn_name}`;

      if (!declaredConnections.has(key)) {
        issues.push({
          level: 'error',
          code: 'route-connection-missing',
          message: `路由端点 ${label}:${endpoint.tag} 对应的连接未在连接注册表中声明`,
        });
        continue;
      }

      const tags = declaredTags.get(key);

      if (tags && !tags.includes(endpoint.tag)) {
        issues.push({
          level: 'error',
          code: 'route-tag-missing',
          message: `路由端点 ${label}:${endpoint.tag} 未在该连接的标签注册表中声明`,
        });
      }
    }

    if (
      connectionKey(route.src.module_name, route.src.conn_name) === connectionKey(route.dst.module_name, route.dst.conn_name)
      && route.src.tag === route.dst.tag
    ) {
      issues.push({
        level: 'warning',
        code: 'route-self-loop',
        message: `路由存在自环（源与目标相同）：${route.src.module_name}/${route.src.conn_name}:${route.src.tag}`,
      });
    }
  }

  for (const connection of connections) {
    const key = connectionKey(connection.module_name, connection.conn_name);

    if (!declaredTags.has(key)) {
      issues.push({
        level: 'warning',
        code: 'connection-without-tags',
        message: `连接 ${connection.module_name}/${connection.conn_name} 没有标签注册表条目，导入后该连接的路由校验会被放行`,
      });
    }
  }

  for (const entry of options.baselineConnTags ?? []) {
    const key = connectionKey(entry.module_name, entry.conn_name);
    const current = declaredTags.get(key);

    if (!current) {
      continue;
    }

    const baselineTags = Array.isArray(entry.tags) ? entry.tags : [];
    const removed = baselineTags.filter((tag) => !current.includes(tag));

    if (new Set(baselineTags).size > new Set(current).size && removed.length > 0) {
      issues.push({
        level: 'warning',
        code: 'tags-shrunk',
        message: `连接 ${entry.module_name}/${entry.conn_name} 的标签数量比打底快照减少，导入后会剪除引用被移除标签的路由：${removed.join('、')}`,
      });
    }
  }

  if (hasMqttPassword(snapshot.config.modbus_rtu?.mqtt) || hasMqttPassword(snapshot.config.dlt645?.mqtt)) {
    issues.push({
      level: 'warning',
      code: 'mqtt-password-in-export',
      message: '导出文件包含明文 MQTT 密码，请确认交付方式安全',
    });
  }

  return issues;
}

/** 收集工作区/快照里所有会注册标签的对象的派生结果。 */
function collectDerivedEntries(snapshot: FullConfigExportSnapshot): DerivedEntry[] {
  const entries: DerivedEntry[] = [];
  const config = snapshot.config;

  for (const task of config.iec104?.links ?? []) {
    const connName = task.point_table?.conn_name ?? task.link?.config?.conn_name ?? '';
    const points = task.point_table?.points ?? [];

    entries.push({
      key: connectionKey(MODULE_IEC104, connName),
      label: `${MODULE_IEC104}/${connName}`,
      pointTags: points.map((point) => point.tag),
      addressKeys: points.map((point) => `ioa:${point.ioa}`),
      pointChecks: true,
      tags: safeDerive({
        module: 'IEC104',
        points,
        timeSyncTag: task.link?.config?.time_sync_tag,
      }),
    });
  }

  for (const [moduleName, section] of [
    [MODULE_MODBUS_RTU, config.modbus_rtu],
    [MODULE_MODBUS_TCP, config.modbus_tcp],
  ] as const) {
    for (const task of section?.links ?? []) {
      const connName = task.point_table?.conn_name ?? task.link?.config?.conn_name ?? '';
      const points = task.point_table?.points ?? [];
      const module = moduleName === MODULE_MODBUS_RTU ? 'ModbusRTU' : 'ModbusTCP';

      entries.push({
        key: connectionKey(moduleName, connName),
        label: `${moduleName}/${connName}`,
        pointTags: points.map((point) => point.tag),
        addressKeys: points.map((point) => `${point.function}:${point.address}`),
        pointChecks: true,
        tags: safeDerive({ module, points }),
      });
    }
  }

  for (const task of config.dlt645?.links ?? []) {
    const connName = task.point_table?.conn_name ?? task.link?.config?.conn_name ?? '';
    const points = task.point_table?.points ?? [];
    // DLT645 允许同一 DI 上的多个 bit 点，因此不做重复地址检查。
    entries.push({
      key: connectionKey(MODULE_DLT645, connName),
      label: `${MODULE_DLT645}/${connName}`,
      pointTags: points.map((point) => point.tag),
      addressKeys: [],
      pointChecks: true,
      tags: safeDerive({ module: 'DLT645', points, blocks: task.point_table?.blocks }),
    });
  }

  for (const task of config.agc?.groups ?? []) {
    const groupName = task.upsert?.config?.group_name ?? '';

    entries.push(groupEntry(MODULE_AGC, groupName, () => safeDerive({ module: 'AGC', config: task.upsert.config })));
  }

  for (const task of config.avc?.groups ?? []) {
    const groupName = task.upsert?.config?.group_name ?? '';

    entries.push(groupEntry(MODULE_AVC, groupName, () => safeDerive({ module: 'AVC', config: task.upsert.config })));
  }

  for (const task of config.calc?.groups ?? []) {
    const groupName = task.upsert?.config?.group_name ?? '';

    entries.push(groupEntry(MODULE_CALC, groupName, () => safeDerive({ module: 'Calc', config: task.upsert.config })));
  }

  return entries;
}

function groupEntry(moduleName: string, groupName: string, derive: () => string[]): DerivedEntry {
  return {
    key: connectionKey(moduleName, groupName),
    label: `${moduleName}/${groupName}`,
    tags: derive(),
    pointTags: [],
    addressKeys: [],
    pointChecks: false,
  };
}

function safeDerive(input: Parameters<typeof deriveConnTags>[0]): string[] {
  try {
    return deriveConnTags(input);
  } catch (error) {
    console.warn('[离线自检] 标签派生失败，已跳过该对象', { input, error });

    return [];
  }
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }

    seen.add(value);
  }

  return Array.from(duplicates);
}

function hasMqttPassword(mqtt: { password?: string } | null | undefined): boolean {
  return typeof mqtt?.password === 'string' && mqtt.password.length > 0;
}
