import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { UNSAFE_DataRouterContext, useBlocker, useSearchParams } from 'react-router-dom';
import {
  App as AntApp,
  Button,
  Card,
  ConfigProvider,
  Dropdown,
  Empty,
  Input,
  message,
  Modal,
  Popconfirm,
  Select,
  Segmented,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleFilled,
  DeleteOutlined,
  EllipsisOutlined,
  HolderOutlined,
  InfoCircleOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../../adapters';
import type { DcConnectionInfo, DcPointUpdate, DcRoute } from '../../adapters';
import { formatAutoRealtimeNumber, formatDecimalDisplay } from '../../utils/realtime-value';
import { DATA_BUS_VIEW_QUERY_KEY, normalizeDataBusView } from '../../components/data-bus/data-bus-view';
import ResizableSplit from '../../components/layout/ResizableSplit';
import { usePointerReorder } from '../../components/interaction/use-pointer-reorder';
import { useAppMode } from '../../offline/app-mode-context';
import { useConfigDraft, useHasConfigDraft } from '../../drafts/config-drafts';
import { createRouteDirectionDraft, hasDraftSelection, changeDraftConnection, getDraftPairs, removeDraftPair, classifyDraftRoutes, filterTags, selectFilteredTags, matchSameNameTags, findInvalidConnectionGroups } from './route-draft';
import type { RouteBatchMode, RouteDirectionDraft } from './route-draft';
import './index.css';

const { Text } = Typography;

const QUALITY_MAP: Record<number, { label: string; color: string }> = {
  0: { label: '未指定', color: 'default' },
  1: { label: '正常', color: 'green' },
  2: { label: '异常', color: 'red' },
  3: { label: '不确定', color: 'orange' },
};

const endpointKey = (endpoint: DcRoute['src']): string =>
  `${endpoint.module_name}\u0000${endpoint.conn_name}\u0000${endpoint.tag}`;

const routeKey = (route: DcRoute): string => `${endpointKey(route.src)}->${endpointKey(route.dst)}`;

const endpointLabel = (endpoint: DcRoute['src']): string =>
  `${endpoint.module_name}/${endpoint.conn_name} : ${endpoint.tag}`;

const isControlOrchestratorConnection = (connection: { module_name: string; conn_name: string } | null): boolean =>
  connection?.module_name === 'ControlOrchestrator' && connection.conn_name === 'control-orchestrator';

const isControlOrchestratorRoute = (route: DcRoute): boolean =>
  isControlOrchestratorConnection(route.src) || isControlOrchestratorConnection(route.dst);

type RouteTagDrag = {
  side: 'source' | 'destination';
  index: number;
};
type RouteDraftSnapshot = {
  directions: RouteDirectionDraft[];
  activeId: number | null;
  initial: string;
  connections: DcConnectionInfo[];
};
const routeDraftKey = 'routes';

function RouteSubmitGuard({ submitting }: { submitting: boolean }) {
  const blocker = useBlocker(submitting);
  const { message: messages } = AntApp.useApp();
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    blocker.reset();
    messages.warning('正在创建路由，请等待本次操作完成后切页');
  }, [blocker, messages]);
  return null;
}

const ROUTE_TAG_DRAG_PREFIX = 'mskdsp-route-tag:';
const ROUTE_TAG_POINTER_SEPARATOR = '\u0000';

const serializeRouteTagDrag = ({ side, index }: RouteTagDrag): string =>
  `${ROUTE_TAG_DRAG_PREFIX}${side}:${index}`;

const parseRouteTagDrag = (value: string): RouteTagDrag | null => {
  const match = new RegExp(`^${ROUTE_TAG_DRAG_PREFIX}(source|destination):(\\d+)$`).exec(value);
  if (!match) return null;
  return { side: match[1] as RouteTagDrag['side'], index: Number(match[2]) };
};

const serializeRouteTagPointerKey = (side: RouteTagDrag['side'], tag: string): string =>
  `${side}${ROUTE_TAG_POINTER_SEPARATOR}${tag}`;

const parseRouteTagPointerKey = (value: string): { side: RouteTagDrag['side']; tag: string } | null => {
  const separatorIndex = value.indexOf(ROUTE_TAG_POINTER_SEPARATOR);
  if (separatorIndex < 0) return null;
  const side = value.slice(0, separatorIndex);
  if (side !== 'source' && side !== 'destination') return null;
  return { side, tag: value.slice(separatorIndex + ROUTE_TAG_POINTER_SEPARATOR.length) };
};

const formatTimestamp = (tsMs: number): string => {
  if (tsMs <= 0) return '-';
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

const formatAge = (tsMs: number): string => {
  if (tsMs <= 0) return '-';
  const age = Math.max(0, Date.now() - tsMs);
  if (age < 1000) return '刚刚';
  if (age < 60000) return `${Math.floor(age / 1000)} 秒前`;
  return `${Math.floor(age / 60000)} 分钟前`;
};

const formatPointValue = (value: DcPointUpdate['value']): string => {
  if (!value) return '-';
  switch (value.type) {
    case 'Bool': return value.value ? '是' : '否';
    case 'Int': return String(value.value);
    case 'Double': return formatAutoRealtimeNumber(value.value);
    case 'Decimal': return formatDecimalDisplay(value.value);
    case 'String': return value.value;
    case 'Bytes': return `[${value.value.length} 字节]`;
    default: return '-';
  }
};

const DataBus: React.FC = () => {
  const { modal } = AntApp.useApp();
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const [searchParams, setSearchParams] = useSearchParams();
  const { can, workspace } = useAppMode();
  const { read, write, clear } = useConfigDraft<RouteDraftSnapshot>('/data-bus');
  const retainedRoute = useHasConfigDraft('/data-bus');
  const [catalogCollapsed, setCatalogCollapsed] = useState(false);
  const [connectionSearch, setConnectionSearch] = useState('');
  const [catalogTagSearch, setCatalogTagSearch] = useState('');
  const [connections, setConnections] = useState<DcConnectionInfo[]>([]);
  const [connectionsReady, setConnectionsReady] = useState(false);
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [allConnTags, setAllConnTags] = useState<Map<number, string[]>>(new Map());
  const [routes, setRoutes] = useState<DcRoute[]>([]);
  const [realtimeUpdates, setRealtimeUpdates] = useState<DcPointUpdate[]>([]);
  const [loading, setLoading] = useState(false);
  const [realtimeLoading, setRealtimeLoading] = useState(false);
  const [routeModalOpen, setRouteModalOpen] = useState(false);
  const view = normalizeDataBusView(searchParams.get(DATA_BUS_VIEW_QUERY_KEY));
  const [monitorConnId, setMonitorConnId] = useState<number | 'all'>('all');
  const [monitorSearch, setMonitorSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRealtimeAt, setLastRealtimeAt] = useState(0);
  const [messageApi, contextHolder] = message.useMessage();
  const [routeDirections, setRouteDirections] = useState<RouteDirectionDraft[]>([]);
  const [activeRouteDirectionId, setActiveRouteDirectionId] = useState<number | null>(null);
  const [routeDrag, setRouteDrag] = useState<RouteTagDrag | null>(null);
  const [routeSubmitting, setRouteSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const nextDraftId = useRef(0);
  const [routeInitial, setRouteInitial] = useState('');
  const routeConnections = useRef<DcConnectionInfo[]>([]);
  const routeDirty = routeDirections.length > 0 && JSON.stringify(routeDirections) !== routeInitial;
  const activeGroupButtonRef = useRef<HTMLButtonElement | null>(null);
  const groupEditorRef = useRef<HTMLElement | null>(null);
  const [connectionChange, setConnectionChange] = useState<{ draftId: number; side: 'source' | 'destination'; connId: number } | null>(null);
  const [sourceTagSearch, setSourceTagSearch] = useState('');
  const [destinationTagSearch, setDestinationTagSearch] = useState('');
  const [selectedRouteKeys, setSelectedRouteKeys] = useState<string[]>([]);
  const [routeDeleting, setRouteDeleting] = useState(false);
  const [routeSourceFilter, setRouteSourceFilter] = useState<number | 'all'>('all');
  const [routeDestinationFilter, setRouteDestinationFilter] = useState<number | 'all'>('all');
  const [routeSearch, setRouteSearch] = useState('');
  const visibleRoutes = useMemo(
    () => routes.filter((route) => !isControlOrchestratorRoute(route)),
    [routes],
  );

  const refreshConnections = useCallback(async () => {
    setLoading(true);
    try {
      const conns = await api.dcListConnections();
      setConnections(conns);
      setConnectionsReady(true);
      setSelectedConnId((current) => conns.some((connection) => connection.conn_id === current) ? current : conns[0]?.conn_id ?? null);
    } catch (e) {
      setConnectionsReady(false);
      messageApi.error(`刷新连接列表失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  const refreshRoutes = useCallback(async () => {
    try {
      const nextRoutes = await api.dcListRoutes(0, '', 0, '');
      setRoutes(nextRoutes);
      console.info('DataBus 路由列表已刷新，控制编排自动路由仅保留在内部', {
        routeCount: nextRoutes.length,
        hiddenRouteCount: nextRoutes.filter(isControlOrchestratorRoute).length,
      });
    } catch (e) {
      messageApi.error(`刷新路由列表失败: ${e}`);
    }
  }, [messageApi]);

  const refreshRealtime = useCallback(async () => {
    if (connections.length === 0) return;
    setRealtimeLoading(true);
    try {
      const updates = await Promise.all(
        connections.map(async (conn) => {
          try { return await api.dcGetLatest(conn.conn_id, []); } catch { return []; }
        }),
      );
      setRealtimeUpdates(updates.flat());
      setLastRealtimeAt(Date.now());
    } catch (e) {
      messageApi.error(`刷新最新值失败: ${e}`);
    } finally {
      setRealtimeLoading(false);
    }
  }, [connections, messageApi]);

  useEffect(() => { void refreshConnections(); void refreshRoutes(); }, [refreshConnections, refreshRoutes]);

  useEffect(() => {
    if (connections.length === 0) return;
    const loadAll = async () => {
      const entries = await Promise.all(connections.map(async (conn) => {
        try { return [conn.conn_id, (await api.dcGetConnTags(conn.conn_id)).tags] as [number, string[]]; }
        catch { return [conn.conn_id, [] as string[]] as [number, string[]]; }
      }));
      setAllConnTags(new Map(entries));
    };
    void loadAll();
  }, [connections]);

  useEffect(() => {
    if (view !== 'monitor' || !autoRefresh) return undefined;
    void refreshRealtime();
    const timer = window.setInterval(() => void refreshRealtime(), 3000);
    return () => window.clearInterval(timer);
  }, [view, autoRefresh, refreshRealtime]);

  useEffect(() => {
    setSelectedRouteKeys([]);
  }, [routeSourceFilter, routeDestinationFilter, routeSearch]);

  const activeRouteDirection = routeDirections.find((direction) => direction.id === activeRouteDirectionId) ?? null;
  const routeBatchMode = activeRouteDirection?.mode ?? 'ordered';
  const routeSourceConnId = activeRouteDirection?.sourceConnId ?? null;
  const routeDestinationConnId = activeRouteDirection?.destinationConnId ?? null;
  const selectedSourceTags = useMemo(() => activeRouteDirection?.sourceTags ?? [], [activeRouteDirection]);
  const selectedDestinationTags = useMemo(() => activeRouteDirection?.destinationTags ?? [], [activeRouteDirection]);
  const customMappings = useMemo(() => activeRouteDirection?.customMappings ?? [], [activeRouteDirection]);
  const selectedConn = connections.find((conn) => conn.conn_id === selectedConnId) ?? null;
  const connTags = selectedConnId === null ? [] : allConnTags.get(selectedConnId) ?? [];
  const routeSourceConn = connections.find((conn) => conn.conn_id === routeSourceConnId) ?? null;
  const routeDestinationConn = connections.find((conn) => conn.conn_id === routeDestinationConnId) ?? null;
  const routeSourceTags = routeSourceConnId === null || isControlOrchestratorConnection(routeSourceConn)
    ? [] : (allConnTags.get(routeSourceConnId) ?? []);
  const routeDestinationTags = routeDestinationConnId === null || isControlOrchestratorConnection(routeDestinationConn)
    ? [] : (allConnTags.get(routeDestinationConnId) ?? []);
  const routeConnectionOptions = connections
    .filter((connection) => !isControlOrchestratorConnection(connection))
    .map((connection) => ({ value: connection.conn_id, label: `${connection.module_name}/${connection.conn_name}` }));
  const openCreateRoute = useCallback((sourceTag?: string) => {
    if (loading) return;
    const stored = read(routeDraftKey);
    if (stored) {
      if (!connectionsReady) {
        messageApi.warning('请先刷新连接目录，再恢复路由草稿');
        return;
      }
      // 连接 ID 可能在设备重启或重建连接后被复用，以模块名和连接名恢复。
      const missing = new Map<number, DcConnectionInfo>();
      const restoreId = (id: number | null) => {
        const previous = stored.connections.find((connection) => connection.conn_id === id);
        if (!previous) return null;
        const current = connections.find((connection) => connection.module_name === previous.module_name && connection.conn_name === previous.conn_name);
        if (current) return current.conn_id;
        const retained = missing.get(previous.conn_id);
        if (retained) return retained.conn_id;
        // 缺失的连接使用独立占位 ID，保留旧身份和标签供下一次恢复。
        const placeholder = { ...previous, conn_id: -1 - missing.size };
        missing.set(previous.conn_id, placeholder);
        return placeholder.conn_id;
      };
      const restored = stored.directions.map((direction) => ({ ...direction, sourceConnId: restoreId(direction.sourceConnId), destinationConnId: restoreId(direction.destinationConnId) }));
      setRouteInitial(stored.initial);
      routeConnections.current = [...connections, ...missing.values()];
      nextDraftId.current = Math.max(0, ...restored.map((direction) => direction.id));
      setRouteDirections(restored);
      setActiveRouteDirectionId(stored.activeId);
      setRouteDrag(null);
      setRouteModalOpen(true);
      return;
    }
    const directionId = ++nextDraftId.current;
    setSourceTagSearch('');
    setDestinationTagSearch('');
    const selectedConnection = connections.find((connection) => connection.conn_id === selectedConnId) ?? null;
    const defaultSourceConnId = isControlOrchestratorConnection(selectedConnection)
      ? connections.find((connection) => !isControlOrchestratorConnection(connection))?.conn_id ?? null
      : selectedConnection?.conn_id ?? connections.find((connection) => !isControlOrchestratorConnection(connection))?.conn_id ?? null;
    const draft = createRouteDirectionDraft(directionId, defaultSourceConnId, null);
    setRouteInitial(JSON.stringify([draft]));
    routeConnections.current = connections;
    if (sourceTag && selectedConnection && !isControlOrchestratorConnection(selectedConnection)) draft.sourceTags = [sourceTag];
    setRouteDirections([draft]);
    setActiveRouteDirectionId(directionId);
    setRouteDrag(null);
    setRouteModalOpen(true);
    console.info('数据总线打开新增路由草稿', { sourceConnId: defaultSourceConnId, sourceTag: draft.sourceTags[0] });
  }, [connections, connectionsReady, loading, messageApi, read, selectedConnId]);

  useLayoutEffect(() => {
    if (!routeModalOpen) return;
    if (routeDirty) {
      write(routeDraftKey, { directions: routeDirections, activeId: activeRouteDirectionId, initial: routeInitial, connections: routeConnections.current });
    } else clear(routeDraftKey);
  }, [activeRouteDirectionId, clear, routeDirections, routeDirty, routeInitial, routeModalOpen, write]);

  const updateActiveDirection = useCallback((patch: Partial<RouteDirectionDraft>) => {
    if (activeRouteDirectionId === null || submittingRef.current) return;
    setRouteDirections((current) => current.map((direction) => (
      direction.id === activeRouteDirectionId ? { ...direction, ...patch } : direction
    )));
  }, [activeRouteDirectionId]);

  const focusGroup = useCallback((id: number) => {
    if (submittingRef.current) return;
    setActiveRouteDirectionId(id);
    setRouteDrag(null);
    setSourceTagSearch('');
    setDestinationTagSearch('');
    groupEditorRef.current?.scrollTo({ top: 0 });
    console.info('数据总线切换映射组，保留各组草稿', { id });
  }, []);

  useEffect(() => {
    if (routeModalOpen) activeGroupButtonRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeRouteDirectionId, routeModalOpen]);

  const addMappingGroup = useCallback(() => {
    if (submittingRef.current) return;
    const id = ++nextDraftId.current;
    setRouteDirections((current) => [...current, createRouteDirectionDraft(id, null, null)]);
    focusGroup(id);
    console.info('数据总线已添加映射组', { id });
  }, [focusGroup]);

  const removeActiveDirection = useCallback(() => {
    if (!activeRouteDirection || routeDirections.length <= 1 || submittingRef.current) return;
    const remove = () => {
      const remaining = routeDirections.filter((direction) => direction.id !== activeRouteDirection.id);
      setRouteDirections(remaining);
      focusGroup(remaining[0].id);
      console.info('数据总线已删除映射组', { id: activeRouteDirection.id });
    };
    if (hasDraftSelection(activeRouteDirection)) {
      modal.confirm({ title: '删除当前映射组？', content: '该组已选点位和配对草稿将被删除。其他组保留。', okText: '删除映射组', cancelText: '保留', okButtonProps: { danger: true }, onOk: remove });
    } else remove();
  }, [activeRouteDirection, routeDirections, focusGroup, modal]);

  const requestConnectionChange = (side: 'source' | 'destination', connId: number) => {
    if (!activeRouteDirection || submittingRef.current) return;
    const next = changeDraftConnection(activeRouteDirection, side, connId);
    if (next === activeRouteDirection) return;
    const affected = side === 'source'
      ? activeRouteDirection.sourceTags.length + activeRouteDirection.customMappings.filter((row) => row.sourceTag).length
      : activeRouteDirection.destinationTags.length + activeRouteDirection.customMappings.filter((row) => row.destinationTag).length;
    if (affected > 0) { console.info('数据总线已保护连接切换前的草稿', { side, affected }); setConnectionChange({ draftId: activeRouteDirection.id, side, connId }); }
    else updateActiveDirection(next);
  };

  const applyConnectionChange = (newGroup: boolean) => {
    if (!connectionChange || submittingRef.current) return;
    const current = routeDirections.find((draft) => draft.id === connectionChange.draftId);
    if (!current) return;
    const next = changeDraftConnection(current, connectionChange.side, connectionChange.connId);
    if (newGroup) {
      const id = ++nextDraftId.current;
      setRouteDirections((drafts) => [...drafts, { ...next, id }]);
      focusGroup(id);
    } else {
      setRouteDirections((drafts) => drafts.map((draft) => draft.id === current.id ? next : draft));
    }
    setConnectionChange(null);
    console.info('数据总线已更换映射连接', { side: connectionChange.side, newGroup });
  };

  const closeRouteModal = () => {
    if (submittingRef.current) return;
    const discard = () => {
      clear(routeDraftKey);
      setRouteModalOpen(false);
    };
    if (routeDirty) {
      modal.confirm({ title: '放弃本次路由草稿？', content: '关闭后，所有映射组中尚未创建的点位配对将被丢弃。', okText: '放弃草稿', cancelText: '继续配置', okButtonProps: { danger: true }, onOk: discard });
    } else discard();
  };

  const draftRouteStatuses = useMemo(
    () => classifyDraftRoutes(routeDirections, connections, routes),
    [routeDirections, connections, routes],
  );
  const draftRoutes = draftRouteStatuses.map((item) => item.route);
  const readyRoutes = useMemo(
    () => draftRouteStatuses.filter((item) => item.status === 'ready').map((item) => item.route),
    [draftRouteStatuses],
  );
  const existingRouteCount = draftRouteStatuses.filter((item) => item.status === 'existing').length;
  const duplicateRouteCount = draftRouteStatuses.filter((item) => item.status === 'duplicate').length;
  const bidirectionalRouteCount = draftRouteStatuses.filter((item) => item.status === 'bidirectional').length;
  const selfRouteCount = draftRouteStatuses.filter((item) => item.status === 'self').length;
  const incompletePairCount = useMemo(() => routeDirections.reduce((total, direction) => {
    const orderedIncomplete = Math.abs(direction.sourceTags.length - direction.destinationTags.length);
    const customIncomplete = direction.customMappings.filter((mapping) => {
      const hasSource = Boolean(mapping.sourceTag);
      const hasDestination = Boolean(mapping.destinationTag);
      return (hasSource || hasDestination) && !(hasSource && hasDestination);
    }).length;
    return total + orderedIncomplete + customIncomplete;
  }, 0), [routeDirections]);

  const submitRouteBatch = useCallback(async (routesToSubmit: DcRoute[]) => {
    if (submittingRef.current) return;
    if (routesToSubmit.length === 0) {
      messageApi.info('没有新的路由需要创建');
      return;
    }
    submittingRef.current = true;
    setRouteSubmitting(true);
    try {
      console.info('DataBus 批量创建路由', {
        routeCount: routesToSubmit.length,
        skippedExisting: existingRouteCount,
        skippedDuplicate: duplicateRouteCount,
        blockedBidirectional: bidirectionalRouteCount,
        incompletePairCount,
      });
      await api.dcUpsertRoutes(routesToSubmit, false);
      messageApi.success(`已创建 ${routesToSubmit.length} 条路由`);
      clear(routeDraftKey);
      setRouteModalOpen(false);
      await refreshRoutes();
    } catch (e) {
      messageApi.error(`批量添加路由失败: ${e}`);
    } finally {
      submittingRef.current = false;
      setRouteSubmitting(false);
    }
  }, [bidirectionalRouteCount, clear, duplicateRouteCount, existingRouteCount, incompletePairCount, messageApi, refreshRoutes]);

  const handleRouteSubmit = useCallback(async () => {
    if (submittingRef.current) return;
    if (!routeDirections.some(hasDraftSelection)) {
      messageApi.error('请先配置至少一条路由');
      return;
    }
    const incompleteDirectionCount = findInvalidConnectionGroups(routeDirections, connections).length;
    if (incompleteDirectionCount > 0) {
      console.warn('数据总线提交被连接校验阻止', { incompleteDirectionCount });
      messageApi.error(`还有 ${incompleteDirectionCount} 个映射组未选择有效的源连接和目标连接，请重新选择`);
      return;
    }
    const connectionChanged = routeDirections.filter(hasDraftSelection).some((direction) =>
      [direction.sourceConnId, direction.destinationConnId].some((id) => {
        const before = routeConnections.current.find((connection) => connection.conn_id === id);
        const current = connections.find((connection) => connection.conn_id === id);
        return before?.module_name !== current?.module_name || before?.conn_name !== current?.conn_name;
      }));
    if (connectionChanged) {
      messageApi.error('点位连接已变化，请暂存后重新打开草稿核对');
      return;
    }
    if (selfRouteCount > 0) {
      messageApi.error('请先处理预览中标记为自环的映射');
      return;
    }
    if (bidirectionalRouteCount > 0) {
      messageApi.error('当前存在双向路由：同一对点位不能同时配置两个方向');
      return;
    }
    if (readyRoutes.length === 0) {
      messageApi.info(existingRouteCount > 0 || duplicateRouteCount > 0 ? '完整配对的路由都已存在或重复' : '当前没有完整的路由配对');
      return;
    }
    if (incompletePairCount > 0) {
      modal.confirm({
        title: '存在未配对点位',
        content: `当前有 ${readyRoutes.length + existingRouteCount + duplicateRouteCount} 条完整配对，将创建其中 ${readyRoutes.length} 条新路由；已存在或本次重复的 ${existingRouteCount + duplicateRouteCount} 条会跳过，另有 ${incompletePairCount} 个点位未配对。请确认当前顺序是否正确。`,
        okText: `仅创建 ${readyRoutes.length} 条已配对路由`,
        cancelText: '返回调整',
        onOk: () => submitRouteBatch(readyRoutes),
      });
      return;
    }
    await submitRouteBatch(readyRoutes);
  }, [bidirectionalRouteCount, connections, duplicateRouteCount, existingRouteCount, incompletePairCount, messageApi, modal, readyRoutes, routeDirections, selfRouteCount, submitRouteBatch]);

  const toggleRouteTag = useCallback((side: 'source' | 'destination', tag: string) => {
    const current = side === 'source' ? selectedSourceTags : selectedDestinationTags;
    const next = current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag];
    updateActiveDirection(side === 'source' ? { sourceTags: next } : { destinationTags: next });
  }, [selectedDestinationTags, selectedSourceTags, updateActiveDirection]);

  const reorderRouteTags = useCallback((side: 'source' | 'destination', from: number, to: number) => {
    const current = side === 'source' ? selectedSourceTags : selectedDestinationTags;
    if (from === to || from < 0 || to < 0 || from >= current.length || to >= current.length) return;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateActiveDirection(side === 'source' ? { sourceTags: next } : { destinationTags: next });
  }, [selectedDestinationTags, selectedSourceTags, updateActiveDirection]);

  const reorderRouteTagsByPointerKey = useCallback((fromKey: string, toKey: string) => {
    const from = parseRouteTagPointerKey(fromKey);
    const to = parseRouteTagPointerKey(toKey);
    if (!from || !to || from.side !== to.side) return;
    const current = from.side === 'source' ? selectedSourceTags : selectedDestinationTags;
    reorderRouteTags(from.side, current.indexOf(from.tag), current.indexOf(to.tag));
  }, [reorderRouteTags, selectedDestinationTags, selectedSourceTags]);

  const routePointerReorder = usePointerReorder({
    disabled: routeSubmitting || !routeModalOpen || routeBatchMode !== 'ordered',
    onReorder: reorderRouteTagsByPointerKey,
  });

  const handleRouteTagDragStart = useCallback((event: React.DragEvent<HTMLDivElement>, side: RouteTagDrag['side'], index: number) => {
    const drag = { side, index };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', serializeRouteTagDrag(drag));
    setRouteDrag(drag);
  }, []);

  const handleRouteTagDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleRouteTagDrop = useCallback((event: React.DragEvent<HTMLDivElement>, side: RouteTagDrag['side'], index: number) => {
    event.preventDefault();
    const drag = parseRouteTagDrag(event.dataTransfer.getData('text/plain')) ?? routeDrag;
    if (drag?.side === side) reorderRouteTags(side, drag.index, index);
    setRouteDrag(null);
  }, [reorderRouteTags, routeDrag]);

  const addCustomMapping = useCallback(() => {
    if (!activeRouteDirection) return;
    const nextId = Math.max(...activeRouteDirection.customMappings.map((mapping) => mapping.id), activeRouteDirection.id) + 1;
    updateActiveDirection({ customMappings: [...activeRouteDirection.customMappings, { id: nextId }] });
  }, [activeRouteDirection, updateActiveDirection]);

  const updateCustomMapping = useCallback((id: number, side: 'sourceTag' | 'destinationTag', value: string) => {
    updateActiveDirection({
      customMappings: customMappings.map((mapping) => mapping.id === id ? { ...mapping, [side]: value || undefined } : mapping),
    });
  }, [customMappings, updateActiveDirection]);

  const removeCustomMapping = useCallback((id: number) => {
    updateActiveDirection({ customMappings: customMappings.filter((mapping) => mapping.id !== id) });
  }, [customMappings, updateActiveDirection]);

  const filteredSourceTags = filterTags(routeSourceTags, sourceTagSearch);
  const filteredDestinationTags = filterTags(routeDestinationTags, destinationTagSearch);
  const groupLabel = (draft: RouteDirectionDraft) => {
    const source = connections.find((conn) => conn.conn_id === draft.sourceConnId);
    const destination = connections.find((conn) => conn.conn_id === draft.destinationConnId);
    return `${source ? `${source.module_name}/${source.conn_name}` : '待选源连接'} → ${destination ? `${destination.module_name}/${destination.conn_name}` : '待选目标连接'}`;
  };
  const pairStatusLabel = (status?: string) => status === 'ready' ? '可创建' : status === 'existing' ? '已存在' : status === 'duplicate' ? '本次重复' : status === 'bidirectional' ? '双向不允许' : status === 'self' ? '自环' : '未配对';
  const pairStatusTag = (status?: string) => <Tag color={status === 'ready' ? 'green' : status === 'self' || status === 'bidirectional' ? 'red' : 'orange'}>{pairStatusLabel(status)}</Tag>;
  const previewSameNameMatch = () => {
    if (!activeRouteDirection || submittingRef.current) return;
    const matches = matchSameNameTags(routeSourceTags, routeDestinationTags);
    if (matches.sourceTags.length === 0) { messageApi.info('两侧暂无完全同名的标签'); return; }
    modal.confirm({
      title: `同名匹配预览（${matches.sourceTags.length} 对）`,
      width: 680,
      content: <div className="route-match-preview"><Text type="secondary">采用后将替换当前组的一对一选择，自定义映射保留。请核对以下配对。</Text>{matches.sourceTags.map((tag) => <div key={tag}>{tag} → {tag}</div>)}</div>,
      okText: '采用这些配对', cancelText: '返回配置',
      onOk: () => { updateActiveDirection(matches); console.info('数据总线已采用同名标签配对', { count: matches.sourceTags.length }); },
    });
  };
  const currentPairs = activeRouteDirection ? getDraftPairs(activeRouteDirection).filter((pair) => pair.kind === routeBatchMode) : [];
  const pairColumns: ColumnsType<(typeof currentPairs)[number]> = [
    { title: '序号', width: 60, render: (_, __, index) => index + 1 },
    { title: '源点位', dataIndex: 'sourceTag', render: (tag?: string) => tag || <Text type="secondary">待选择</Text> },
    { title: '目标点位', dataIndex: 'destinationTag', render: (tag?: string) => tag || <Text type="secondary">待选择</Text> },
    { title: '校验结果', width: 120, render: (_, pair) => pairStatusTag(draftRouteStatuses.find((row) => row.directionId === activeRouteDirectionId && row.kind === pair.kind && row.id === pair.id)?.status) },
    { title: '操作', width: 70, render: (_, pair) => <Button type="text" danger size="small" onClick={() => { if (activeRouteDirection) updateActiveDirection(removeDraftPair(activeRouteDirection, pair.kind, pair.id)); }}>移除</Button> },
  ];

  const deleteRouteBatch = useCallback(async (routesToDelete: DcRoute[], successText: string) => {
    if (routesToDelete.length === 0) {
      messageApi.info('没有可删除的路由');
      return;
    }
    setRouteDeleting(true);
    try {
      await api.dcDeleteRoutes(routesToDelete);
      messageApi.success(successText);
      setSelectedRouteKeys([]);
      await refreshRoutes();
    } catch (e) {
      messageApi.error(`删除路由失败: ${e}`);
    } finally {
      setRouteDeleting(false);
    }
  }, [messageApi, refreshRoutes]);

  const handleDeleteRoute = useCallback(async (route: DcRoute) => {
    await deleteRouteBatch([route], '路由已删除');
  }, [deleteRouteBatch]);

  const handleDeleteSelectedRoutes = useCallback(() => {
    const selectedRoutes = visibleRoutes.filter((route) => selectedRouteKeys.includes(routeKey(route)));
    modal.confirm({
      title: '确认删除选中的路由？',
      content: `将删除 ${selectedRoutes.length} 条路由，此操作不可撤销。`,
      okText: '删除选中',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => deleteRouteBatch(selectedRoutes, `已删除 ${selectedRoutes.length} 条路由`),
    });
  }, [deleteRouteBatch, modal, selectedRouteKeys, visibleRoutes]);

  const handleDeleteAllRoutes = useCallback(() => {
    modal.confirm({
      title: '确认删除全部路由？',
      content: `当前共 ${visibleRoutes.length} 条可管理路由，将全部删除，此操作不可撤销。`,
      okText: '全部删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => deleteRouteBatch(visibleRoutes, `已删除全部 ${visibleRoutes.length} 条路由`),
    });
  }, [deleteRouteBatch, modal, visibleRoutes]);

  const routeColumns: ColumnsType<DcRoute & { key: string }> = [
    {
      title: '源端点', key: 'source', width: 300,
      render: (_, route) => <div><Text strong>{endpointLabel(route.src)}</Text><Text type="secondary" style={{ display: 'block', fontSize: 12 }}>conn_id {route.src.conn_id ?? '-'}</Text></div>,
    },
    { title: '', key: 'direction', width: 54, align: 'center', render: () => <Text type="secondary" style={{ fontSize: 18 }}>→</Text> },
    {
      title: '目标端点', key: 'destination', width: 300,
      render: (_, route) => <div><Text strong>{endpointLabel(route.dst)}</Text><Text type="secondary" style={{ display: 'block', fontSize: 12 }}>conn_id {route.dst.conn_id ?? '-'}</Text></div>,
    },
    { title: '配置状态', key: 'status', width: 110, render: () => <Tooltip title="路由配置已存在，实际数据请查看运行监视"><Tag color="blue" icon={<CheckCircleOutlined />}>已配置</Tag></Tooltip> },
    {
      title: '操作', key: 'action', width: 74,
      render: (_, route) => <Popconfirm title="确认删除该路由？" okText="删除" cancelText="取消" description={`${endpointLabel(route.src)} → ${endpointLabel(route.dst)}`} onConfirm={() => void handleDeleteRoute(route)}><Button danger type="text" size="small">删除</Button></Popconfirm>,
    },
  ];

  const realtimeColumns: ColumnsType<DcPointUpdate & { key: string }> = [
    { title: '来源', key: 'source', width: 270, render: (_, item) => { const conn = connections.find((c) => c.conn_id === item.src_conn_id); return <Text>{conn ? `${conn.module_name}/${conn.conn_name}` : `连接_${item.src_conn_id}`} : {item.src_tag}</Text>; } },
    { title: '', key: 'direction', width: 42, align: 'center', render: () => <Text type="secondary">→</Text> },
    { title: '目标', key: 'destination', width: 270, render: (_, item) => { const conn = connections.find((c) => c.conn_id === item.dst_conn_id); return <Text>{conn ? `${conn.module_name}/${conn.conn_name}` : `连接_${item.dst_conn_id}`} : {item.dst_tag}</Text>; } },
    { title: '当前值', key: 'value', width: 120, render: (_, item) => formatPointValue(item.value) },
    { title: '数据时间', key: 'timestamp', width: 150, render: (_, item) => <Text style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>{formatTimestamp(item.ts_ms)}</Text> },
    { title: '新鲜度', key: 'age', width: 96, render: (_, item) => formatAge(item.ts_ms) },
    { title: '质量', key: 'quality', width: 90, render: (_, item) => { const quality = QUALITY_MAP[item.quality] ?? QUALITY_MAP[0]; return <Tag color={quality.color}>{quality.label}</Tag>; } },
  ];

  const filteredRealtimeData = useMemo(() => realtimeUpdates
    .filter((item) => monitorConnId === 'all' || item.dst_conn_id === monitorConnId || item.src_conn_id === monitorConnId)
    .filter((item) => {
      const query = monitorSearch.trim().toLowerCase();
      if (!query) return true;
      return `${item.src_tag} ${item.dst_tag} ${item.src_conn_id} ${item.dst_conn_id}`.toLowerCase().includes(query);
    })
    .map((item, index) => ({ ...item, key: `${item.src_conn_id}:${item.src_tag}->${item.dst_conn_id}:${item.dst_tag}-${index}` })),
  [monitorConnId, monitorSearch, realtimeUpdates]);

  const filteredRoutes = useMemo(() => {
    const query = routeSearch.trim().toLowerCase();
    const sourceConnection = routeSourceFilter === 'all'
      ? null
      : connections.find((connection) => connection.conn_id === routeSourceFilter) ?? null;
    const destinationConnection = routeDestinationFilter === 'all'
      ? null
      : connections.find((connection) => connection.conn_id === routeDestinationFilter) ?? null;
    const matchesConnection = (
      endpoint: DcRoute['src'],
      connection: DcConnectionInfo | null,
    ): boolean => {
      if (!connection) return true;
      return endpoint.conn_id === connection.conn_id
        || (endpoint.module_name === connection.module_name && endpoint.conn_name === connection.conn_name);
    };

    return visibleRoutes.filter((route) => {
      if (!matchesConnection(route.src, sourceConnection) || !matchesConnection(route.dst, destinationConnection)) {
        return false;
      }
      if (!query) return true;
      const searchable = [
        route.src.module_name,
        route.src.conn_name,
        route.src.tag,
        route.src.conn_id,
        route.dst.module_name,
        route.dst.conn_name,
        route.dst.tag,
        route.dst.conn_id,
      ].map(String).join(' ').toLowerCase();
      return searchable.includes(query);
    });
  }, [connections, routeDestinationFilter, routeSearch, routeSourceFilter, visibleRoutes]);

  const routeData = filteredRoutes.map((route) => ({ ...route, key: routeKey(route) }));
  const filteredConnections = connections.filter((connection) =>
    `${connection.module_name} ${connection.conn_name} ${connection.conn_id}`.toLowerCase().includes(connectionSearch.trim().toLowerCase()));
  const catalogTags = filterTags(connTags, catalogTagSearch);
  const canCreateFromConnection = Boolean(selectedConn && !isControlOrchestratorConnection(selectedConn));
  const clearRouteFilters = () => { setRouteSourceFilter('all'); setRouteDestinationFilter('all'); setRouteSearch(''); };
  const toggleCatalog = () => {
    setCatalogCollapsed((current) => !current);
    console.info('数据总线切换连接目录显示', { collapsed: !catalogCollapsed });
  };

  const connectionPanel = (
    <Card
      className="data-bus-connection-card"
      title={<Space size={8}><span>连接与标签</span><Tag>{connections.length}</Tag></Space>}
      size="small"
      extra={<Space size={0}><Button type="text" size="small" title="刷新连接列表" aria-label="刷新连接列表" icon={<ReloadOutlined aria-hidden />} loading={loading} onClick={() => void refreshConnections()} /><Button type="text" size="small" title="收起连接目录" aria-label="收起连接目录" icon={<MenuFoldOutlined />} onClick={toggleCatalog} /></Space>}
      styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } }}
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <div className="data-bus-catalog-hint"><Text type="secondary">连接与标签由协议/控制页面自动同步，选择后可作为路由源。</Text></div>
      <div className="data-bus-connection-search"><Input aria-label="搜索连接" placeholder="搜索连接名称、模块或编号" prefix={<SearchOutlined />} allowClear value={connectionSearch} onChange={(event) => setConnectionSearch(event.target.value)} /></div>
      <div className="data-bus-connection-list" aria-label="连接列表" aria-busy={loading}>
        {filteredConnections.map((item) => {
          const active = item.conn_id === selectedConnId;
          const tagCount = allConnTags.get(item.conn_id)?.length ?? 0;
          return <button key={item.conn_id} type="button" className={`data-bus-connection-item${active ? ' is-active' : ''}`} aria-pressed={active} onClick={() => { setSelectedConnId(item.conn_id); setCatalogTagSearch(''); }}>
            <span className="data-bus-connection-heading"><Text strong>{item.conn_name}</Text><Tag color="blue">{item.module_name}</Tag></span>
            <Text type="secondary" style={{ fontSize: 12 }}>编号 {item.conn_id} · {tagCount} 个标签</Text>
          </button>;
        })}
        {filteredConnections.length === 0 && <div className="data-bus-catalog-empty"><Text type="secondary">{loading ? '正在加载连接…' : connections.length ? '没有匹配的连接' : '暂无已注册连接，请先在协议页面配置连接'}</Text>{connectionSearch && <Button type="link" size="small" onClick={() => setConnectionSearch('')}>清空搜索</Button>}</div>}
      </div>
      <div className="data-bus-tag-directory">
        <div className="data-bus-tag-header"><Text strong>{selectedConn ? selectedConn.conn_name : '标签目录'}</Text>{selectedConn && <Tag>{catalogTags.length} / {connTags.length} 个标签</Tag>}</div>
        <div className="data-bus-tag-actions"><Button block icon={<PlusOutlined />} disabled={!canCreateFromConnection} onClick={() => openCreateRoute()}>以此连接为源新增</Button></div>
        <div className="data-bus-tag-search"><Input aria-label="搜索当前连接标签" placeholder="搜索当前连接标签" prefix={<SearchOutlined />} allowClear value={catalogTagSearch} onChange={(event) => setCatalogTagSearch(event.target.value)} /></div>
        <ul className="data-bus-tag-list" aria-label="标签目录">
          {catalogTags.map((tag) => <li key={tag} className="data-bus-tag-row"><Text className="data-bus-tag-name" title={tag} copyable={{ text: tag, tooltips: ['复制标签', '已复制'] }}>{tag}</Text><Tooltip title="以此点为源新增路由"><Button type="text" size="small" icon={<PlusOutlined />} aria-label={`以 ${tag} 为源新增路由`} disabled={!canCreateFromConnection} onClick={() => openCreateRoute(tag)} /></Tooltip></li>)}
          {catalogTags.length === 0 && <li className="data-bus-catalog-empty"><Text type="secondary">{catalogTagSearch ? '没有匹配的标签' : selectedConn ? '该连接暂无已同步标签' : '请选择一个连接'}</Text>{catalogTagSearch && <Button type="link" size="small" onClick={() => setCatalogTagSearch('')}>清空搜索</Button>}</li>}
        </ul>
      </div>
    </Card>
  );

  return <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    {contextHolder}
    {dataRouter && <RouteSubmitGuard submitting={routeSubmitting} />}
    {view === 'config' ? <ResizableSplit
      className={`data-bus-config-grid${catalogCollapsed ? ' is-catalog-collapsed' : ''}`}
      defaultSize={400}
      minSize={340}
      maxSize={560}
      storageKey="mskdsp.layout.data-bus.config"
    >
      <div style={{ minHeight: 0 }}>{connectionPanel}</div>
      <Card className="data-bus-route-card" title={<Space size={8}>{catalogCollapsed && <Button type="text" size="small" title="展开连接目录" aria-label="展开连接目录" icon={<MenuUnfoldOutlined />} onClick={toggleCatalog} />}<span>路由配置</span><Tag color="blue">{visibleRoutes.length}</Tag>{retainedRoute && <Tag color="warning">未保存 · 草稿已暂存</Tag>}</Space>} size="small" extra={<div className="data-bus-route-actions"><Button icon={<ReloadOutlined aria-hidden />} onClick={() => { void refreshConnections(); void refreshRoutes(); }}>刷新</Button><Button type="primary" disabled={loading} icon={<PlusOutlined aria-hidden />} onClick={() => openCreateRoute()}>{retainedRoute ? '继续编辑路由草稿' : '新增路由'}</Button>{visibleRoutes.length > 0 && <Dropdown menu={{ items: [{ key: 'delete-all', label: '全部删除', danger: true, disabled: routeDeleting }], onClick: ({ key }) => { if (key === 'delete-all') handleDeleteAllRoutes(); } }} trigger={['click']}><Button aria-label="更多路由操作" title="更多路由操作" icon={<EllipsisOutlined />} /></Dropdown>}</div>} styles={{ body: { padding: 0 } }}>
        <div className="data-bus-route-hint"><Text type="secondary">源点最新值 → 目标点</Text><Tooltip title="同一对点位不允许同时配置两个方向。控制编排自动维护的内部路由不在本页显示。已配置不代表正在转发。"><Button type="text" size="small" aria-label="路由规则说明" icon={<InfoCircleOutlined />} /></Tooltip>{can('realtime') && <Button type="link" size="small" onClick={() => { const next = new URLSearchParams(searchParams); next.set(DATA_BUS_VIEW_QUERY_KEY, 'monitor'); setSearchParams(next, { replace: true }); }}>查看运行数据</Button>}</div>
        {can('workspace.manage') && <div className="data-bus-route-hint"><Tag color="gold">离线工作区</Tag><Text>{workspace?.workspace_name ?? '未命名工作区'}</Text><Text type="secondary">仅修改本地工作区，不会自动下发到设备；可从顶部导出配置。</Text></div>}
        {visibleRoutes.length > 0 ? <><div className="route-filter-toolbar">
          <Select<number | 'all'>
            value={routeSourceFilter}
            onChange={(value) => setRouteSourceFilter(value ?? 'all')}
            options={[{ value: 'all', label: '全部源连接' }, ...routeConnectionOptions]}
            showSearch
            optionFilterProp="label"
            style={{ width: 190 }}
          />
          <Select<number | 'all'>
            value={routeDestinationFilter}
            onChange={(value) => setRouteDestinationFilter(value ?? 'all')}
            options={[{ value: 'all', label: '全部目标连接' }, ...routeConnectionOptions]}
            showSearch
            optionFilterProp="label"
            style={{ width: 190 }}
          />
          <Input
            allowClear={{ clearIcon: <CloseCircleFilled aria-label="清空" /> }}
            prefix={<SearchOutlined />}
            placeholder="筛选端点、标签或连接编号"
            value={routeSearch}
            onChange={(event) => setRouteSearch(event.target.value)}
            className="route-filter-search"
          />
          <Button
            type="text"
            onClick={clearRouteFilters}
            disabled={routeSourceFilter === 'all' && routeDestinationFilter === 'all' && routeSearch.trim() === ''}
          >
            清空筛选
          </Button>
          <Text type="secondary" className="route-filter-count">显示 {filteredRoutes.length} / 共 {visibleRoutes.length} 条</Text>
        </div>
        {selectedRouteKeys.length > 0 && <div className="data-bus-route-selection"><Text>已选 {selectedRouteKeys.length} 条</Text><Button danger size="small" icon={<DeleteOutlined />} loading={routeDeleting} onClick={handleDeleteSelectedRoutes}>删除选中</Button><Button type="text" size="small" onClick={() => setSelectedRouteKeys([])}>取消选择</Button></div>}
        <Table
          rowKey="key"
          rowSelection={{
            selectedRowKeys: selectedRouteKeys,
            onChange: (keys) => setSelectedRouteKeys(keys.map(String)),
          }}
          columns={routeColumns}
          dataSource={routeData}
          pagination={false}
          size="middle"
          scroll={{ x: 880, y: 'calc(100vh - 330px)' }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的路由"><Button onClick={clearRouteFilters}>清空筛选</Button></Empty> }}
        />
        </> : <div className="data-bus-route-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Space orientation="vertical" size={8}><Text strong>尚未配置路由</Text><Text type="secondary">将源点位的数据转发到目标点位</Text><Text type="secondary">从左侧选择连接或点位，或直接新增批量映射。</Text></Space>}><Button type="primary" icon={<PlusOutlined />} onClick={() => openCreateRoute()}>新增第一条路由</Button></Empty></div>}
      </Card>
    </ResizableSplit> : <Card title={<Space size={8}><span>实时值</span><Tag color={autoRefresh ? 'green' : 'default'} icon={autoRefresh ? <SyncOutlined spin /> : undefined}>{autoRefresh ? '自动刷新 3 秒' : '已暂停'}</Tag></Space>} size="small" extra={<Space><Text type="secondary" style={{ fontSize: 12 }}>{lastRealtimeAt ? `上次更新 ${formatTimestamp(lastRealtimeAt)}` : '尚未更新'}</Text><Switch checked={autoRefresh} checkedChildren="自动" unCheckedChildren="暂停" onChange={setAutoRefresh} /><Button icon={<ReloadOutlined aria-hidden />} loading={realtimeLoading} onClick={() => void refreshRealtime()}>刷新</Button></Space>} styles={{ body: { padding: 0, minHeight: 0 } }} style={{ flex: 1, minHeight: 0 }}>
      <div style={{ padding: '12px 16px', display: 'flex', gap: 12, borderBottom: '1px solid #3e3e42' }}><Select value={monitorConnId} onChange={setMonitorConnId} style={{ width: 220 }} options={[{ value: 'all', label: '全部连接' }, ...connections.map((conn) => ({ value: conn.conn_id, label: `${conn.module_name}/${conn.conn_name}` }))]} /><Input allowClear={{ clearIcon: <CloseCircleFilled aria-label="清空" /> }} prefix={<SearchOutlined />} placeholder="筛选标签或连接编号" value={monitorSearch} onChange={(event) => setMonitorSearch(event.target.value)} style={{ maxWidth: 320 }} /><Text type="secondary" style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 12 }}>共 {filteredRealtimeData.length} 条快照</Text></div>
      <Table rowKey="key" columns={realtimeColumns} dataSource={filteredRealtimeData} pagination={false} size="middle" scroll={{ x: 1100, y: 'calc(100vh - 290px)' }} locale={{ emptyText: connections.length ? '暂无最新值，请确认目标连接已启动并产生数据' : '暂无已注册连接' }} />
    </Card>}
    <Modal
      title={<Space>批量新增路由{routeDirty && <Tag color="warning">未保存 · 草稿已暂存</Tag>}</Space>}
      className="route-mapping-modal"
      open={routeModalOpen}
      onOk={() => void handleRouteSubmit()}
      okText={readyRoutes.length > 0 ? `创建 ${readyRoutes.length} 条新路由` : '创建路由'}
      cancelText="取消"
      confirmLoading={routeSubmitting}
      onCancel={closeRouteModal}
      closable={{ disabled: routeSubmitting, 'aria-label': '关闭' }}
      maskClosable={!routeSubmitting}
      keyboard={!routeSubmitting}
      cancelButtonProps={{ disabled: routeSubmitting, autoInsertSpace: false }}
      okButtonProps={{ disabled: routeSubmitting }}
      styles={{ body: { padding: 0 } }}
      style={{ top: 24 }}
      width={1280}
      destroyOnClose
      footer={(_, { OkBtn, CancelBtn }) => <div className="route-modal-footer">
        <div className="route-total-summary" aria-live="polite">
          <Text>共 {routeDirections.length} 组 · 可创建 <Text strong>{readyRoutes.length}</Text> 条路由</Text>
          {existingRouteCount + duplicateRouteCount > 0 && <Tag color="orange">重复 {existingRouteCount + duplicateRouteCount} 条</Tag>}
          {bidirectionalRouteCount + selfRouteCount > 0 && <Tag color="red">冲突 {bidirectionalRouteCount + selfRouteCount} 条</Tag>}
          {incompletePairCount > 0 && <Tag color="orange">未配对 {incompletePairCount} 个</Tag>}
        </div>
        <Space>{routeDirty && <Button disabled={routeSubmitting} onClick={() => setRouteModalOpen(false)}>暂存并收起</Button>}<CancelBtn /><OkBtn /></Space>
      </div>}
    >
      <ConfigProvider componentDisabled={routeSubmitting}>
      <div className={`route-mapping-workspace${routeSubmitting ? ' route-editor-submitting' : ''}`}>
        <nav className="route-group-sidebar" aria-label="映射组列表">
          <div className="route-group-sidebar-header"><Text strong>映射组</Text><Tag>{routeDirections.length} 组</Tag></div>
          <Button block icon={<PlusOutlined aria-hidden />} onClick={addMappingGroup} disabled={routeSubmitting}>添加映射组</Button>
          <div className="route-group-list">
            {routeDirections.map((direction, index) => {
              const source = connections.find((conn) => conn.conn_id === direction.sourceConnId);
              const destination = connections.find((conn) => conn.conn_id === direction.destinationConnId);
              const rows = draftRouteStatuses.filter((row) => row.directionId === direction.id);
              const conflict = rows.some((row) => row.status === 'self' || row.status === 'bidirectional');
              const incomplete = getDraftPairs(direction).some((pair) => !pair.sourceTag || !pair.destinationTag);
              const pending = !source || !destination || incomplete || !hasDraftSelection(direction);
              const active = direction.id === activeRouteDirectionId;
              return <button key={direction.id} type="button"
                ref={active ? activeGroupButtonRef : undefined}
                className={`route-group-card${active ? ' is-active' : ''}`}
                aria-current={active ? 'true' : undefined}
                aria-label={`映射组 ${index + 1}：${groupLabel(direction)}，${rows.length} 条路由，${conflict ? '有冲突' : pending ? '待完善' : '已配对'}`}
                disabled={routeSubmitting} onClick={() => focusGroup(direction.id)}>
                <span className="route-group-card-heading"><strong>映射组 {index + 1}</strong><Tag color={conflict ? 'red' : pending ? 'orange' : 'green'}>{conflict ? '有冲突' : pending ? '待完善' : '已配对'}</Tag></span>
                <span className="route-group-endpoint" title={source ? `${source.module_name}/${source.conn_name}` : undefined}><span>源</span><span>{source ? `${source.module_name}/${source.conn_name}` : '待选择源连接'}</span></span>
                <span className="route-group-endpoint" title={destination ? `${destination.module_name}/${destination.conn_name}` : undefined}><span>目标</span><span>{destination ? `${destination.module_name}/${destination.conn_name}` : '待选择目标连接'}</span></span>
                <span className="route-group-card-count">{rows.length} 条完整映射</span>
              </button>;
            })}
          </div>
          <Text type="secondary" className="route-group-sidebar-hint">各组草稿独立保留，创建时统一提交。</Text>
        </nav>
        <section ref={groupEditorRef} className="route-group-editor" aria-label="当前映射组配置">
        <div className="route-group-editor-heading">
          <div><Text strong>配置映射组 {routeDirections.findIndex((group) => group.id === activeRouteDirectionId) + 1}</Text><Text type="secondary">选择连接和点位，完成本组映射。</Text></div>
          <Button danger icon={<DeleteOutlined aria-hidden />} onClick={removeActiveDirection} disabled={routeSubmitting || !activeRouteDirection || routeDirections.length <= 1}>删除当前组</Button>
        </div>
        <div className="route-mode-toolbar">
          <Segmented<RouteBatchMode>
            value={routeBatchMode}
            onChange={(value) => { updateActiveDirection({ mode: value }); console.info('数据总线切换配对模式，保留两种模式草稿', { mode: value }); }}
            options={[{ label: '一对一批量配对', value: 'ordered' }, { label: '自定义映射', value: 'custom' }]}
          />
          <Text type="secondary">{routeBatchMode === 'ordered' ? '两侧点位按顺序一对一配对。' : '逐行选择点位，可重复使用源点或目标点。'}</Text>
        </div>

        <div className="route-connection-pickers">
          <div>
            <Text strong>源连接</Text>
            <Select
              showSearch
              value={routeSourceConnId ?? undefined}
              placeholder="选择源连接"
              options={routeConnectionOptions}
              onChange={(value) => requestConnectionChange('source', value)}
              style={{ width: '100%', marginTop: 8 }}
              optionFilterProp="label"
            />
          </div>
          <div className="route-connection-arrow">→</div>
          <div>
            <Text strong>目标连接</Text>
            <Select
              showSearch
              value={routeDestinationConnId ?? undefined}
              placeholder="选择目标连接"
              options={routeConnectionOptions}
              onChange={(value) => requestConnectionChange('destination', value)}
              style={{ width: '100%', marginTop: 8 }}
              optionFilterProp="label"
            />
          </div>
        </div>

        {routeBatchMode === 'ordered' ? (
          <div className="route-builder-grid">
            <div className="route-builder-panel route-builder-panel-source">
              <Text strong>源点位</Text>
              <div className="route-tag-tools"><Input allowClear={{ clearIcon: <CloseCircleFilled aria-label="清空" /> }} placeholder="搜索源标签" value={sourceTagSearch} onChange={(event) => setSourceTagSearch(event.target.value)} /><Button size="small" disabled={routeSubmitting || filteredSourceTags.length === 0} onClick={() => updateActiveDirection({ sourceTags: selectFilteredTags(selectedSourceTags, filteredSourceTags) })}>全选筛选结果</Button></div>
              <Text type="secondary" className="route-builder-caption">点选标签，按点击顺序编号</Text>
              <Select
                mode="multiple"
                showSearch
                allowClear={{ clearIcon: <CloseCircleFilled aria-label="清空" /> }}
                value={selectedSourceTags}
                placeholder={routeSourceConnId ? '选择源标签' : '请先选择源连接'}
                options={filteredSourceTags.map((tag) => ({ value: tag, label: tag }))}
                disabled={routeSubmitting || !routeSourceConnId || routeSourceTags.length === 0}
                onChange={(value) => updateActiveDirection({ sourceTags: value })}
                optionFilterProp="label"
                maxTagCount={0}
                maxTagPlaceholder={() => selectedSourceTags.length > 0 ? `${selectedSourceTags.length} 个点位已选` : '选择源标签'}
                notFoundContent={routeSourceConnId ? '该连接暂无标签' : '请先选择源连接'}
                style={{ width: '100%' }}
              />
              <div className="route-selected-list">
                <Text type="secondary">已选 {selectedSourceTags.length} 个</Text>
                {selectedSourceTags.map((tag, index) => {
                  const pointerKey = serializeRouteTagPointerKey('source', tag);
                  return (
                    <div
                      key={tag}
                      className={`route-selected-item${routePointerReorder.activeKey === pointerKey ? ' is-dragging' : ''}`}
                      draggable
                      onPointerDown={(event) => routePointerReorder.onPointerDown(event, pointerKey)}
                      onPointerEnter={(event) => routePointerReorder.onPointerEnter(event, pointerKey)}
                      onDragStart={(event) => handleRouteTagDragStart(event, 'source', index)}
                      onDragOver={handleRouteTagDragOver}
                      onDrop={(event) => handleRouteTagDrop(event, 'source', index)}
                      onDragEnd={() => setRouteDrag(null)}
                    >
                      <HolderOutlined />
                      <span className="route-selected-index">{index + 1}</span>
                      <span className="route-selected-label">{tag}</span>
                      <Button type="text" size="small" title="移除源点位" aria-label={`移除源点位：${tag}`} icon={<DeleteOutlined aria-hidden />} onClick={() => toggleRouteTag('source', tag)} />
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="route-builder-panel route-builder-panel-destination">
              <Text strong>目标点位</Text>
              <div className="route-tag-tools"><Input allowClear={{ clearIcon: <CloseCircleFilled aria-label="清空" /> }} placeholder="搜索目标标签" value={destinationTagSearch} onChange={(event) => setDestinationTagSearch(event.target.value)} /><Button size="small" disabled={routeSubmitting || filteredDestinationTags.length === 0} onClick={() => updateActiveDirection({ destinationTags: selectFilteredTags(selectedDestinationTags, filteredDestinationTags) })}>全选筛选结果</Button></div>
              <Text type="secondary" className="route-builder-caption">点选标签，按点击顺序编号</Text>
              <Select
                mode="multiple"
                showSearch
                allowClear={{ clearIcon: <CloseCircleFilled aria-label="清空" /> }}
                value={selectedDestinationTags}
                placeholder={routeDestinationConnId ? '选择目标标签' : '请先选择目标连接'}
                options={filteredDestinationTags.map((tag) => ({
                  value: tag,
                  label: tag,
                }))}
                disabled={routeSubmitting || !routeDestinationConnId || routeDestinationTags.length === 0}
                onChange={(value) => updateActiveDirection({ destinationTags: value })}
                optionFilterProp="label"
                maxTagCount={0}
                maxTagPlaceholder={() => selectedDestinationTags.length > 0 ? `${selectedDestinationTags.length} 个点位已选` : '选择目标标签'}
                notFoundContent={routeDestinationConnId ? '该连接暂无标签' : '请先选择目标连接'}
                style={{ width: '100%' }}
              />
              <div className="route-selected-list">
                <Text type="secondary">已选 {selectedDestinationTags.length} 个</Text>
                {selectedDestinationTags.map((tag, index) => {
                  const pointerKey = serializeRouteTagPointerKey('destination', tag);
                  return (
                    <div
                      key={tag}
                      className={`route-selected-item${routePointerReorder.activeKey === pointerKey ? ' is-dragging' : ''}`}
                      draggable
                      onPointerDown={(event) => routePointerReorder.onPointerDown(event, pointerKey)}
                      onPointerEnter={(event) => routePointerReorder.onPointerEnter(event, pointerKey)}
                      onDragStart={(event) => handleRouteTagDragStart(event, 'destination', index)}
                      onDragOver={handleRouteTagDragOver}
                      onDrop={(event) => handleRouteTagDrop(event, 'destination', index)}
                      onDragEnd={() => setRouteDrag(null)}
                    >
                      <HolderOutlined />
                      <span className="route-selected-index">{index + 1}</span>
                      <span className="route-selected-label">{tag}</span>
                      <Button type="text" size="small" title="移除目标点位" aria-label={`移除目标点位：${tag}`} icon={<DeleteOutlined aria-hidden />} onClick={() => toggleRouteTag('destination', tag)} />
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="route-pair-preview">
              <Space wrap><Text strong>配对预览</Text><Button size="small" onClick={previewSameNameMatch} disabled={routeSubmitting || !routeSourceConnId || !routeDestinationConnId}>按同名标签匹配</Button><Text type="secondary">调整上方两侧顺序后，按序号配对。</Text></Space>
              <Table size="small" rowKey={(pair) => `${pair.kind}-${pair.id}`} columns={pairColumns} dataSource={currentPairs} pagination={false} scroll={{ y: 240, x: 560 }} locale={{ emptyText: '左右选择点位后显示配对关系' }} />
            </div>
          </div>
        ) : (
          <div className="route-custom-builder">
            <div className="route-custom-header"><Text strong>源点位</Text><span className="route-pair-arrow">→</span><Text strong>目标点位</Text><span /></div>
            {customMappings.map((mapping) => {
              return <div className="route-custom-row" key={mapping.id}>
              <Select showSearch allowClear={{ clearIcon: <CloseCircleFilled aria-label="清空" /> }} value={mapping.sourceTag} placeholder="选择源标签" options={routeSourceTags.map((tag) => ({ value: tag, label: tag }))} onChange={(value) => updateCustomMapping(mapping.id, 'sourceTag', value)} disabled={routeSubmitting || !routeSourceConnId} optionFilterProp="label" />
              <span className="route-pair-arrow">→</span>
              <Select showSearch allowClear={{ clearIcon: <CloseCircleFilled aria-label="清空" /> }} value={mapping.destinationTag} placeholder="选择目标标签" options={routeDestinationTags.map((tag) => ({ value: tag, label: tag }))} onChange={(value) => updateCustomMapping(mapping.id, 'destinationTag', value)} disabled={routeSubmitting || !routeDestinationConnId} optionFilterProp="label" />
              <Button type="text" danger title="删除映射行" aria-label="删除映射行" icon={<DeleteOutlined aria-hidden />} onClick={() => removeCustomMapping(mapping.id)} />
            </div>;
            })}
            <Button type="dashed" icon={<PlusOutlined aria-hidden />} onClick={addCustomMapping}>添加映射行</Button>
            <Text type="secondary">源点和目标点均可重复使用；多对一时后到值覆盖，不做求和或平均；同一对点位不能双向。</Text>
          </div>
        )}

        <details className="route-all-preview">
          <summary>全部映射明细（{draftRoutes.length} 条）</summary>
          <div className="route-submit-summary">
          <Text type="secondary">两种模式的配对均纳入提交。同一对点位不能双向转发。点击组名返回调整。</Text>
          {!routeDirections.some(hasDraftSelection) && <Text type="secondary">暂无映射，请先选择连接和点位。</Text>}
          {routeDirections.map((direction, index) => {
            if (!hasDraftSelection(direction)) return null;
            const rows = draftRouteStatuses.filter((row) => row.directionId === direction.id);
            const incomplete = getDraftPairs(direction).filter((pair) => !pair.sourceTag || !pair.destinationTag).length;
            return <div key={direction.id} className="route-group-summary">
              <Button type="link" size="small" onClick={() => focusGroup(direction.id)}>组 {index + 1} · {groupLabel(direction)} · {rows.length} 条{incomplete ? ` · 未配对 ${incomplete} 个` : ''}</Button>
              {rows.map(({ route, status, kind, id }) => <div key={`${kind}-${id}`} className="route-summary-row"><span>{kind === 'ordered' ? '批量' : '自定'}</span><span title={route.src.tag}>{route.src.tag}</span><span className="route-pair-arrow">→</span><span title={route.dst.tag}>{route.dst.tag}</span>{pairStatusTag(status)}</div>)}
            </div>;
          })}
          </div>
        </details>
        </section>
      </div>
      </ConfigProvider>
    </Modal>
    <Modal title="更换连接将影响已选点位" closable={{ 'aria-label': '关闭' }} open={connectionChange !== null} onCancel={() => setConnectionChange(null)} footer={[
      <Button key="cancel" onClick={() => setConnectionChange(null)}>取消</Button>,
      <Button key="replace" danger onClick={() => applyConnectionChange(false)}>更换并清空本侧</Button>,
      <Button key="new" type="primary" onClick={() => applyConnectionChange(true)}>保留当前组并新建</Button>,
    ]}>
      <Text>更换{connectionChange?.side === 'source' ? '源' : '目标'}连接会清空本侧已选标签及自定义映射的本侧点位，另一侧选择保留。新建映射组会完整保留当前组草稿。</Text>
    </Modal>
  </div>;
};

export default DataBus;
