/**
 * 离线工作区的本地连接编号注册表。
 *
 * 下位机的 conn_id 由 DataCenter 分配且换设备会重排（见设计文档 §4.6），
 * 因此离线侧只维护一份本地编号：稳定键不变则编号不变，删除后不回收，
 * 导出 `.mskcfg` 时统一剥离 conn_id。
 *
 * 所有函数都是纯函数：不就地修改传入的注册表。
 */

import type { WorkspaceConnIdRegistry } from './types.ts';

/** 稳定键分隔符：模块名与连接名都可能含任意字符，必须用不可能出现的分隔符。 */
export const CONNECTION_KEY_SEPARATOR = '\u0000';

export const DEFAULT_FIRST_CONN_ID = 1;

export interface WorkspaceConnection {
  module_name: string;
  conn_name: string;
  conn_id: number;
}

export function connectionKey(moduleName: string, connName: string): string {
  return `${moduleName}${CONNECTION_KEY_SEPARATOR}${connName}`;
}

export function createConnIdRegistry(firstConnId: number = DEFAULT_FIRST_CONN_ID): WorkspaceConnIdRegistry {
  return { map: {}, next_conn_id: firstConnId };
}

export function findConnectionId(
  registry: WorkspaceConnIdRegistry,
  moduleName: string,
  connName: string,
): number | null {
  const value = registry.map[connectionKey(moduleName, connName)];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * 确保稳定键已分配本地 conn_id。
 *
 * 已存在时原样返回同一个注册表对象与编号；新分配时返回新的注册表对象，
 * 保证跨会话稳定且删除后不复用编号。
 */
export function ensureConnectionId(
  registry: WorkspaceConnIdRegistry,
  moduleName: string,
  connName: string,
): { registry: WorkspaceConnIdRegistry; connId: number; created: boolean } {
  const existing = findConnectionId(registry, moduleName, connName);

  if (existing !== null) {
    return { registry, connId: existing, created: false };
  }

  const connId = nextAvailableConnId(registry);

  return {
    registry: {
      map: { ...registry.map, [connectionKey(moduleName, connName)]: connId },
      next_conn_id: connId + 1,
    },
    connId,
    created: true,
  };
}

/** 删除连接登记，但保留自增号：回收编号会让历史路由指向新连接。 */
export function removeConnectionId(
  registry: WorkspaceConnIdRegistry,
  moduleName: string,
  connName: string,
): WorkspaceConnIdRegistry {
  const key = connectionKey(moduleName, connName);

  if (!(key in registry.map)) {
    return registry;
  }

  const map = { ...registry.map };
  delete map[key];

  return { map, next_conn_id: registry.next_conn_id };
}

/** 列出已注册连接，按 conn_id 升序，供数据总线与路由页面使用。 */
export function listConnections(registry: WorkspaceConnIdRegistry): WorkspaceConnection[] {
  return Object.entries(registry.map)
    .filter(([key, value]) => key.includes(CONNECTION_KEY_SEPARATOR) && Number.isInteger(value))
    .map(([key, value]) => {
      const separatorIndex = key.indexOf(CONNECTION_KEY_SEPARATOR);

      return {
        module_name: key.slice(0, separatorIndex),
        conn_name: key.slice(separatorIndex + CONNECTION_KEY_SEPARATOR.length),
        conn_id: value,
      };
    })
    .sort((left, right) => left.conn_id - right.conn_id);
}

/** 兼容手工编辑过的注册表：自增号落后于已用编号时从最大编号之后继续。 */
function nextAvailableConnId(registry: WorkspaceConnIdRegistry): number {
  const used = Object.values(registry.map).filter((value) => Number.isInteger(value));
  const maxUsed = used.length > 0 ? Math.max(...used) : 0;
  const candidate = Number.isInteger(registry.next_conn_id) ? registry.next_conn_id : DEFAULT_FIRST_CONN_ID;

  return Math.max(candidate, maxUsed + 1);
}
