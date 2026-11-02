import type { DcEndpoint } from '../adapters';
import { controlEndpointKey } from './control-mapping-editor.ts';

export type ConnectionPointOption = { value: string; label: string; endpoint: DcEndpoint };

/** 模块与连接名称共同标识连接，避免不同协议的同名连接混在一起。 */
export const pointConnectionKey = (endpoint: DcEndpoint): string =>
  JSON.stringify([endpoint.module_name.trim(), endpoint.conn_name.trim()]);

/** 刷新后仍回显历史绑定，筛选只影响候选列表，不修改绑定。 */
export function buildConnectionPointOptions(options: ConnectionPointOption[], selected: DcEndpoint[]) {
  const all = new Map(options.map((option) => [option.value, option]));
  for (const endpoint of selected) {
    const value = controlEndpointKey(endpoint);
    if (!all.has(value)) all.set(value, {
      value, endpoint, label: `${endpoint.module_name} / ${endpoint.conn_name} / ${endpoint.tag}（已有绑定）`,
    });
  }
  const connections = new Map<string, { value: string; label: string }>();
  for (const { endpoint } of all.values()) {
    const value = pointConnectionKey(endpoint);
    connections.set(value, { value, label: `${endpoint.module_name} / ${endpoint.conn_name}` });
  }
  return { all, connections: [...connections.values()] };
}

export function filterConnectionPoints(options: ConnectionPointOption[], connection: string | undefined) {
  return options.filter(({ endpoint }) => pointConnectionKey(endpoint) === connection);
}
