import type { DcEndpoint, DcRoute } from '../../adapters';

export type ImportedPointRouteDraft = {
  source: DcEndpoint;
  targetTag: string;
};

export type ImportedPointRouteTarget = {
  moduleName: string;
  connName: string;
};

export class ImportedPointRoutesError extends Error {
  readonly pointTableSaved = true;
  readonly routeError: unknown;

  constructor(routeError: unknown) {
    super('点表已保存，路由创建失败');
    this.name = 'ImportedPointRoutesError';
    this.routeError = routeError;
  }
}

export const buildImportedPointRoutes = (
  drafts: ImportedPointRouteDraft[],
  target: ImportedPointRouteTarget,
): DcRoute[] =>
  drafts.map((draft) => {
    const dst: DcEndpoint = {
      module_name: target.moduleName,
      conn_name: target.connName,
      tag: draft.targetTag,
    };

    return {
      src: {
        module_name: draft.source.module_name,
        conn_name: draft.source.conn_name,
        tag: draft.source.tag,
      },
      dst,
    };
  });

export const saveImportedPointsWithOptionalRoutes = async (options: {
  createRoutes: boolean;
  routes: DcRoute[];
  savePointTable: () => Promise<unknown>;
  saveRoutes: (routes: DcRoute[]) => Promise<unknown>;
}): Promise<{ routesCreated: number }> => {
  await options.savePointTable();

  if (!options.createRoutes || options.routes.length === 0) {
    return { routesCreated: 0 };
  }

  try {
    await options.saveRoutes(options.routes);
  } catch (error) {
    throw new ImportedPointRoutesError(error);
  }

  return { routesCreated: options.routes.length };
};
