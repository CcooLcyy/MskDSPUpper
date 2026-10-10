import type { DcEndpoint, DcRoute } from '../adapters';

export type ControlRouteDirection = 'input' | 'output';

export type ControlDataBusBinding = {
  direction: ControlRouteDirection;
  groupTag: string;
  external: DcEndpoint;
};

export class ControlGroupRoutesError extends Error {
  readonly groupSaved = true;
  readonly routeError: unknown;
  readonly routes: DcRoute[];
  readonly removedRoutes: DcRoute[];
  readonly phase: 'upsert' | 'delete';

  constructor(routeError: unknown, routes: DcRoute[] = [], removedRoutes: DcRoute[] = [], phase: 'upsert' | 'delete' = 'upsert') {
    super('控制组已保存，路由创建失败');
    this.name = 'ControlGroupRoutesError';
    this.routeError = routeError;
    this.routes = routes.map((route) => ({ src: { ...route.src }, dst: { ...route.dst } }));
    this.removedRoutes = removedRoutes.map((route) => ({ src: { ...route.src }, dst: { ...route.dst } }));
    this.phase = phase;
  }
}

const toStableEndpoint = (endpoint: DcEndpoint): DcEndpoint => ({
  module_name: endpoint.module_name.trim(),
  conn_name: endpoint.conn_name.trim(),
  tag: endpoint.tag.trim(),
});

const isCompleteEndpoint = (endpoint: DcEndpoint): boolean =>
  Boolean(endpoint.module_name && endpoint.conn_name && endpoint.tag);

const routeKey = (route: DcRoute): string =>
  JSON.stringify({
    src: route.src,
    dst: route.dst,
  });

const isSameConnection = (left: DcEndpoint, right: DcEndpoint): boolean =>
  left.module_name === right.module_name && left.conn_name === right.conn_name;

export const buildControlDataBusRoutes = ({
  moduleName,
  groupName,
  bindings,
}: {
  moduleName: string;
  groupName: string;
  bindings: ControlDataBusBinding[];
}): DcRoute[] => {
  const stableModuleName = moduleName.trim();
  const stableGroupName = groupName.trim();
  const uniqueRoutes = new Map<string, DcRoute>();

  for (const binding of bindings) {
    const external = toStableEndpoint(binding.external);
    const group = toStableEndpoint({
      module_name: stableModuleName,
      conn_name: stableGroupName,
      tag: binding.groupTag,
    });
    if (!isCompleteEndpoint(external) || !isCompleteEndpoint(group)) {
      continue;
    }
    if (isSameConnection(external, group)) {
      throw new Error('不能将当前控制组连接作为自动路由的外部端点');
    }

    const route = binding.direction === 'input'
      ? { src: external, dst: group }
      : { src: group, dst: external };
    uniqueRoutes.set(routeKey(route), route);
  }

  return [...uniqueRoutes.values()];
};

export const saveControlGroupWithOptionalRoutes = async (options: {
  createRoutes: boolean;
  routes: DcRoute[];
  saveGroup: () => Promise<unknown>;
  saveRoutes: (routes: DcRoute[]) => Promise<unknown>;
  removedRoutes?: DcRoute[];
  deleteRoutes?: (routes: DcRoute[]) => Promise<unknown>;
}): Promise<{ routesSubmitted: number }> => {
  await options.saveGroup();

  if (!options.createRoutes || (options.routes.length === 0 && !options.removedRoutes?.length)) {
    return { routesSubmitted: 0 };
  }

  await applyControlRoutePlan(options.routes, options.removedRoutes ?? [], options);

  return { routesSubmitted: options.routes.length };
};

type ControlRouteWriter = {
  saveRoutes: (routes: DcRoute[]) => Promise<unknown>;
  deleteRoutes?: (routes: DcRoute[]) => Promise<unknown>;
};

/** 先新增后解除旧绑定；失败时保存完整计划，重试使用幂等路由接口。 */
async function applyControlRoutePlan(routes: DcRoute[], removedRoutes: DcRoute[], writer: ControlRouteWriter): Promise<void> {
  let phase: ControlGroupRoutesError['phase'] = 'upsert';
  try {
    if (routes.length > 0) await writer.saveRoutes(routes);
    phase = 'delete';
    if (removedRoutes.length > 0) {
      if (!writer.deleteRoutes) throw new Error('缺少旧路由清理接口');
      await writer.deleteRoutes(removedRoutes);
    }
    console.info('控制组映射同步完成', { 新增数量: routes.length, 解除数量: removedRoutes.length });
  } catch (error) {
    console.error('控制组映射同步失败，保留待重试计划', { 阶段: phase, 错误: error });
    throw new ControlGroupRoutesError(error, routes, removedRoutes, phase);
  }
}

/** 仅重试路由同步，不重复创建或更新已经保存的控制组。 */
export async function retryControlRoutes(error: ControlGroupRoutesError, writer: ControlRouteWriter): Promise<void> {
  await applyControlRoutePlan(error.routes, error.removedRoutes, writer);
}
