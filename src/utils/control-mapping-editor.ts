import type { DcEndpoint, DcRoute } from '../adapters';
import { buildControlDataBusRoutes } from './control-auto-routing.ts';
import type { ControlDataBusBinding, ControlRouteDirection } from './control-auto-routing.ts';

export type ControlMappingField = { label: string; tag: string; direction: ControlRouteDirection };
export type ControlMappingPlan = { routes: DcRoute[]; removedRoutes: DcRoute[] };

export const controlEndpointKey = (endpoint: DcEndpoint): string =>
  JSON.stringify([endpoint.module_name.trim(), endpoint.conn_name.trim(), endpoint.tag.trim()]);

export const controlMappingFieldKey = (field: ControlMappingField): string =>
  JSON.stringify([field.direction, field.tag.trim()]);

const stableEndpoint = (endpoint: DcEndpoint): DcEndpoint => ({
  module_name: endpoint.module_name.trim(), conn_name: endpoint.conn_name.trim(), tag: endpoint.tag.trim(),
});

const routeKey = (route: DcRoute): string => JSON.stringify([controlEndpointKey(route.src), controlEndpointKey(route.dst)]);

const isFieldRoute = (route: DcRoute, moduleName: string, groupName: string, field: ControlMappingField): boolean => {
  const local = field.direction === 'input' ? route.dst : route.src;
  return local.module_name === moduleName && local.conn_name === groupName && local.tag === field.tag.trim();
};

/** 查询本地字段已经关联的全部外部端点，保留一对多语义。 */
export function getControlMappingEndpoints(routes: DcRoute[], moduleName: string, groupName: string, field: ControlMappingField): DcEndpoint[] {
  const endpoints = new Map<string, DcEndpoint>();
  routes.filter((route) => isFieldRoute(route, moduleName, groupName, field)).forEach((route) => {
    const endpoint = stableEndpoint(field.direction === 'input' ? route.src : route.dst);
    endpoints.set(controlEndpointKey(endpoint), endpoint);
  });
  return [...endpoints.values()];
}

/** 仅为用户明确编辑的字段计算路由差异，保留其他字段和连接的路由。 */
export function buildControlMappingPlan(options: {
  moduleName: string; groupName: string; fields: ControlMappingField[]; baselineRoutes: DcRoute[];
  edited: Record<string, DcEndpoint[]>; bindings?: ControlDataBusBinding[];
}): ControlMappingPlan {
  const { moduleName, groupName, baselineRoutes } = options;
  const edited = { ...options.edited };
  // 成员快速选点保持增量兼容；统一映射区的明确更改优先。
  const legacy = new Map<string, DcEndpoint[]>();
  for (const binding of options.bindings ?? []) {
    const key = controlMappingFieldKey({ direction: binding.direction, tag: binding.groupTag, label: '' });
    legacy.set(key, [...(legacy.get(key) ?? []), binding.external]);
  }
  for (const field of options.fields) {
    const key = controlMappingFieldKey(field);
    if (!Object.hasOwn(edited, key) && legacy.has(key)) {
      edited[key] = [...getControlMappingEndpoints(baselineRoutes, moduleName, groupName, field), ...legacy.get(key)!];
    }
  }
  const desired = new Map<string, DcRoute>();
  const removed = new Map<string, DcRoute>();
  for (const field of options.fields) {
    const key = controlMappingFieldKey(field);
    if (!field.tag.trim() || !Object.hasOwn(edited, key)) continue;
    const routes = buildControlDataBusRoutes({ moduleName, groupName, bindings: edited[key].map((external) => ({
      direction: field.direction, groupTag: field.tag.trim(), external,
    })) });
    const nextKeys = new Set(routes.map(routeKey));
    routes.forEach((route) => desired.set(routeKey(route), route));
    baselineRoutes.filter((route) => isFieldRoute(route, moduleName, groupName, field)).forEach((route) => {
      if (!nextKeys.has(routeKey(route))) removed.set(routeKey(route), { src: stableEndpoint(route.src), dst: stableEndpoint(route.dst) });
    });
  }
  return { routes: [...desired.values()], removedRoutes: [...removed.values()] };
}
