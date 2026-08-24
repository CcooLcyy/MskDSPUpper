import type { DcEndpoint, DcRoute } from '../../adapters';
import {
  POINT_BUSINESS_TYPE_REMOTE_ADJUST,
  POINT_BUSINESS_TYPE_REMOTE_CONTROL,
  POINT_BUSINESS_TYPE_PARAMETER,
  POINT_BUSINESS_TYPE_TELEINDICATION,
  POINT_BUSINESS_TYPE_TELEMETRY,
  POINT_BUSINESS_TYPE_UNSPECIFIED,
} from './ioa-category.ts';

export type ImportedPointStationRole = 'master' | 'slave';
export type ImportedPointRouteDirection = 'source-to-target' | 'target-to-source' | 'skip';

export type ImportedPointRouteDraft = {
  source: DcEndpoint;
  targetTag: string;
  businessType?: number;
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

export const getImportedPointRouteDirection = (
  businessType: number | undefined,
  stationRole: ImportedPointStationRole = 'master',
): ImportedPointRouteDirection => {
  if (stationRole !== 'slave') {
    return 'source-to-target';
  }

  switch (businessType) {
    case POINT_BUSINESS_TYPE_TELEINDICATION:
    case POINT_BUSINESS_TYPE_TELEMETRY:
      return 'source-to-target';
    case POINT_BUSINESS_TYPE_REMOTE_ADJUST:
    case POINT_BUSINESS_TYPE_REMOTE_CONTROL:
      return 'target-to-source';
    case POINT_BUSINESS_TYPE_UNSPECIFIED:
    case POINT_BUSINESS_TYPE_PARAMETER:
    default:
      return 'skip';
  }
};

export const buildImportedPointRoutes = (
  drafts: ImportedPointRouteDraft[],
  target: ImportedPointRouteTarget,
  options?: { stationRole?: ImportedPointStationRole },
): DcRoute[] =>
  drafts.flatMap((draft) => {
    const direction = getImportedPointRouteDirection(draft.businessType, options?.stationRole);
    if (direction === 'skip') {
      return [];
    }

    const currentIec104Point: DcEndpoint = {
      module_name: target.moduleName,
      conn_name: target.connName,
      tag: draft.targetTag,
    };
    const sourcePoint: DcEndpoint = {
      module_name: draft.source.module_name,
      conn_name: draft.source.conn_name,
      tag: draft.source.tag,
    };

    return direction === 'target-to-source'
      ? [{ src: currentIec104Point, dst: sourcePoint }]
      : [{ src: sourcePoint, dst: currentIec104Point }];
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
