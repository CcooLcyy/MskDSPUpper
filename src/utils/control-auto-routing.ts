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

  constructor(routeError: unknown) {
    super('控制组已保存，路由创建失败');
    this.name = 'ControlGroupRoutesError';
    this.routeError = routeError;
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
}): Promise<{ routesSubmitted: number }> => {
  await options.saveGroup();

  if (!options.createRoutes || options.routes.length === 0) {
    return { routesSubmitted: 0 };
  }

  try {
    await options.saveRoutes(options.routes);
  } catch (error) {
    throw new ControlGroupRoutesError(error);
  }

  return { routesSubmitted: options.routes.length };
};
