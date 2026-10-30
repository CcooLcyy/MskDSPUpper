import type { DcConnectionInfo, DcRoute } from '../../adapters';

export type RouteBatchMode = 'ordered' | 'custom';
export type CustomMapping = { id: number; sourceTag?: string; destinationTag?: string };
export type RouteDirectionDraft = {
  id: number;
  mode: RouteBatchMode;
  sourceConnId: number | null;
  destinationConnId: number | null;
  sourceTags: string[];
  destinationTags: string[];
  customMappings: CustomMapping[];
};
export type DraftPair = CustomMapping & { kind: RouteBatchMode };
export type RouteDraftStatus = 'ready' | 'existing' | 'duplicate' | 'bidirectional' | 'self';
export type ClassifiedDraftRoute = {
  route: DcRoute;
  status: RouteDraftStatus;
  directionId: number;
  kind: RouteBatchMode;
  id: number;
};

export const createRouteDirectionDraft = (
  id: number, sourceConnId: number | null, destinationConnId: number | null,
): RouteDirectionDraft => ({
  id, mode: 'ordered', sourceConnId, destinationConnId,
  sourceTags: [], destinationTags: [], customMappings: [{ id: 0 }],
});

export const hasDraftSelection = (draft: RouteDirectionDraft): boolean =>
  draft.sourceTags.length > 0 || draft.destinationTags.length > 0
  || draft.customMappings.some((mapping) => Boolean(mapping.sourceTag || mapping.destinationTag));

// 只校验包含点位的组；连接失效时整批停止，不能静默漏掉该组。
export function findInvalidConnectionGroups(drafts: RouteDirectionDraft[], connections: DcConnectionInfo[]): RouteDirectionDraft[] {
  const ids = new Set(connections.map((connection) => connection.conn_id));
  return drafts.filter((draft) => hasDraftSelection(draft)
    && (draft.sourceConnId === null || draft.destinationConnId === null
      || !ids.has(draft.sourceConnId) || !ids.has(draft.destinationConnId)));
}

// 更换连接只清空失去身份依据的一侧，另一侧及映射行保持原顺序。
export function changeDraftConnection(
  draft: RouteDirectionDraft, side: 'source' | 'destination', connId: number,
): RouteDirectionDraft {
  if ((side === 'source' ? draft.sourceConnId : draft.destinationConnId) === connId) return draft;
  return {
    ...draft,
    ...(side === 'source' ? { sourceConnId: connId, sourceTags: [] } : { destinationConnId: connId, destinationTags: [] }),
    customMappings: draft.customMappings.map((mapping) => {
      const next = { ...mapping };
      if (side === 'source') delete next.sourceTag;
      else delete next.destinationTag;
      return next;
    }),
  };
}

// 两种模式都属于本组草稿，预览与提交始终使用相同配对集合。
export function getDraftPairs(draft: RouteDirectionDraft): DraftPair[] {
  const ordered: DraftPair[] = Array.from(
    { length: Math.max(draft.sourceTags.length, draft.destinationTags.length) },
    (_, id) => ({ kind: 'ordered', id, sourceTag: draft.sourceTags[id], destinationTag: draft.destinationTags[id] }),
  );
  return [...ordered, ...draft.customMappings
    .filter((mapping) => mapping.sourceTag || mapping.destinationTag)
    .map((mapping): DraftPair => ({ ...mapping, kind: 'custom' }))];
}

export function removeDraftPair(draft: RouteDirectionDraft, kind: RouteBatchMode, id: number): RouteDirectionDraft {
  if (kind === 'ordered') {
    return { ...draft, sourceTags: draft.sourceTags.filter((_, index) => index !== id), destinationTags: draft.destinationTags.filter((_, index) => index !== id) };
  }
  const remaining = draft.customMappings.filter((mapping) => mapping.id !== id);
  return { ...draft, customMappings: remaining.length ? remaining : [{ id: 0 }] };
}

const endpointKey = (endpoint: DcRoute['src']): string =>
  JSON.stringify([endpoint.module_name, endpoint.conn_name, endpoint.tag]);
const routeKey = (route: DcRoute): string => JSON.stringify([endpointKey(route.src), endpointKey(route.dst)]);

function pairRoute(draft: RouteDirectionDraft, pair: DraftPair, connections: DcConnectionInfo[]): DcRoute | null {
  const src = connections.find((connection) => connection.conn_id === draft.sourceConnId);
  const dst = connections.find((connection) => connection.conn_id === draft.destinationConnId);
  if (!src || !dst || !pair.sourceTag || !pair.destinationTag) return null;
  return {
    src: { module_name: src.module_name, conn_name: src.conn_name, conn_id: src.conn_id, tag: pair.sourceTag },
    dst: { module_name: dst.module_name, conn_name: dst.conn_name, conn_id: dst.conn_id, tag: pair.destinationTag },
  };
}

export function buildDirectionRoutes(draft: RouteDirectionDraft, connections: DcConnectionInfo[]): DcRoute[] {
  return getDraftPairs(draft).flatMap((pair) => {
    const route = pairRoute(draft, pair, connections);
    return route ? [route] : [];
  });
}

// 使用所有组及完整现有路由检查冲突，不能只检查当前可见组。
export function classifyDraftRoutes(
  drafts: RouteDirectionDraft[], connections: DcConnectionInfo[], existing: DcRoute[],
): ClassifiedDraftRoute[] {
  const entries = drafts.flatMap((draft) => getDraftPairs(draft).flatMap((pair) => {
    const route = pairRoute(draft, pair, connections);
    return route ? [{ route, directionId: draft.id, kind: pair.kind, id: pair.id }] : [];
  }));
  const existingKeys = new Set(existing.map(routeKey));
  const draftKeys = new Set(entries.map(({ route }) => routeKey(route)));
  const seen = new Set<string>();
  return entries.map((entry) => {
    const { route } = entry;
    const key = routeKey(route);
    const reverseKey = routeKey({ src: route.dst, dst: route.src });
    const status: RouteDraftStatus = endpointKey(route.src) === endpointKey(route.dst) ? 'self'
      : existingKeys.has(reverseKey) || draftKeys.has(reverseKey) ? 'bidirectional'
        : existingKeys.has(key) ? 'existing'
          : seen.has(key) ? 'duplicate' : 'ready';
    seen.add(key);
    return { ...entry, status };
  });
}

export function filterTags(tags: string[], search: string): string[] {
  const query = search.trim().toLowerCase();
  return tags.filter((tag) => tag.toLowerCase().includes(query));
}

export const selectFilteredTags = (selected: string[], filtered: string[]): string[] => [...new Set([...selected, ...filtered])];

export function matchSameNameTags(sourceTags: string[], destinationTags: string[]): { sourceTags: string[]; destinationTags: string[] } {
  const targets = new Set(destinationTags);
  const matches = [...new Set(sourceTags)].filter((tag) => targets.has(tag));
  return { sourceTags: matches, destinationTags: [...matches] };
}
