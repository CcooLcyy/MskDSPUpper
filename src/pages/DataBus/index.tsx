import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  App as AntApp,
  Button,
  Card,
  Input,
  List,
  message,
  Modal,
  Popconfirm,
  Select,
  Segmented,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  HolderOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../../adapters';
import type { DcConnectionInfo, DcPointUpdate, DcRoute } from '../../adapters';
import { formatAutoRealtimeNumber } from '../../utils/realtime-value';
import { DATA_BUS_VIEW_QUERY_KEY, normalizeDataBusView } from '../../components/data-bus/data-bus-view';
import ResizableSplit from '../../components/layout/ResizableSplit';
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

type RouteBatchMode = 'ordered' | 'custom';

type CustomMapping = {
  id: number;
  sourceTag?: string;
  destinationTag?: string;
};

type RouteDirectionDraft = {
  id: number;
  mode: RouteBatchMode;
  sourceConnId: number | null;
  destinationConnId: number | null;
  sourceTags: string[];
  destinationTags: string[];
  customMappings: CustomMapping[];
};

type RouteDraftStatus = 'ready' | 'existing' | 'duplicate' | 'manyToOne' | 'bidirectional' | 'self';

type RouteTagDrag = {
  side: 'source' | 'destination';
  index: number;
};

const ROUTE_TAG_DRAG_PREFIX = 'mskdsp-route-tag:';

const serializeRouteTagDrag = ({ side, index }: RouteTagDrag): string =>
  `${ROUTE_TAG_DRAG_PREFIX}${side}:${index}`;

const parseRouteTagDrag = (value: string): RouteTagDrag | null => {
  const match = new RegExp(`^${ROUTE_TAG_DRAG_PREFIX}(source|destination):(\\d+)$`).exec(value);
  if (!match) return null;
  return { side: match[1] as RouteTagDrag['side'], index: Number(match[2]) };
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
    case 'String': return value.value;
    case 'Bytes': return `[${value.value.length} 字节]`;
    default: return '-';
  }
};

const createRouteDirectionDraft = (
  id: number,
  sourceConnId: number | null,
  destinationConnId: number | null,
): RouteDirectionDraft => ({
  id,
  mode: 'ordered',
  sourceConnId,
  destinationConnId,
  sourceTags: [],
  destinationTags: [],
  customMappings: [{ id: id + 1 }],
});

const DataBus: React.FC = () => {
  const { modal } = AntApp.useApp();
  const [searchParams] = useSearchParams();
  const [connections, setConnections] = useState<DcConnectionInfo[]>([]);
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [connTags, setConnTags] = useState<string[]>([]);
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
  const [selectedRouteKeys, setSelectedRouteKeys] = useState<string[]>([]);
  const [routeDeleting, setRouteDeleting] = useState(false);
  const [routeSourceFilter, setRouteSourceFilter] = useState<number | 'all'>('all');
  const [routeDestinationFilter, setRouteDestinationFilter] = useState<number | 'all'>('all');
  const [routeSearch, setRouteSearch] = useState('');

  const refreshConnections = useCallback(async () => {
    setLoading(true);
    try {
      const conns = await api.dcListConnections();
      setConnections(conns);
      setSelectedConnId((current) => current === null && conns.length > 0 ? conns[0].conn_id : current);
    } catch (e) {
      messageApi.error(`刷新连接列表失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  const refreshRoutes = useCallback(async () => {
    try {
      setRoutes(await api.dcListRoutes(0, '', 0, ''));
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

  const loadConnTags = useCallback(async (connId: number) => {
    try { setConnTags((await api.dcGetConnTags(connId)).tags); } catch { setConnTags([]); }
  }, []);

  useEffect(() => { void refreshConnections(); void refreshRoutes(); }, [refreshConnections, refreshRoutes]);

  useEffect(() => {
    if (selectedConnId !== null) void loadConnTags(selectedConnId);
    else setConnTags([]);
  }, [selectedConnId, loadConnTags]);

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
  const routeSourceConn = connections.find((conn) => conn.conn_id === routeSourceConnId) ?? null;
  const routeDestinationConn = connections.find((conn) => conn.conn_id === routeDestinationConnId) ?? null;
  const routeSourceTags = routeSourceConnId === null ? [] : (allConnTags.get(routeSourceConnId) ?? []);
  const routeDestinationTags = routeDestinationConnId === null ? [] : (allConnTags.get(routeDestinationConnId) ?? []);
  const occupiedDestinationTags = useMemo(() => {
    if (!routeDestinationConn) return new Set<string>();
    return new Set(
      routes
        .filter((route) => route.dst.module_name === routeDestinationConn.module_name && route.dst.conn_name === routeDestinationConn.conn_name)
        .map((route) => route.dst.tag),
    );
  }, [routeDestinationConn, routes]);

  const openCreateRoute = useCallback(() => {
    const directionId = Date.now();
    setRouteDirections([createRouteDirectionDraft(directionId, selectedConnId ?? connections[0]?.conn_id ?? null, null)]);
    setActiveRouteDirectionId(directionId);
    setRouteDrag(null);
    setRouteModalOpen(true);
  }, [connections, selectedConnId]);

  const updateActiveDirection = useCallback((patch: Partial<RouteDirectionDraft>) => {
    if (activeRouteDirectionId === null) return;
    setRouteDirections((current) => current.map((direction) => (
      direction.id === activeRouteDirectionId ? { ...direction, ...patch } : direction
    )));
  }, [activeRouteDirectionId]);

  const addReverseDirection = useCallback(() => {
    if (!activeRouteDirection || routeDirections.length >= 2) return;
    const directionId = Date.now();
    const nextDirection = createRouteDirectionDraft(
      directionId,
      activeRouteDirection.destinationConnId,
      activeRouteDirection.sourceConnId,
    );
    setRouteDirections((current) => [...current, nextDirection]);
    setActiveRouteDirectionId(directionId);
    setRouteDrag(null);
  }, [activeRouteDirection, routeDirections.length]);

  const removeActiveDirection = useCallback(() => {
    if (activeRouteDirectionId === null || routeDirections.length <= 1) return;
    const activeIndex = routeDirections.findIndex((direction) => direction.id === activeRouteDirectionId);
    const remainingDirections = routeDirections.filter((direction) => direction.id !== activeRouteDirectionId);
    const nextActiveIndex = Math.min(Math.max(activeIndex, 0), remainingDirections.length - 1);
    setRouteDirections(remainingDirections);
    setActiveRouteDirectionId(remainingDirections[nextActiveIndex]?.id ?? null);
    setRouteDrag(null);
  }, [activeRouteDirectionId, routeDirections]);

  const buildEndpoint = useCallback((conn: DcConnectionInfo | null, tag: string): DcRoute['src'] => ({
    module_name: conn?.module_name ?? '',
    conn_name: conn?.conn_name ?? '',
    conn_id: conn?.conn_id,
    tag,
  }), []);

  const buildDirectionRoutes = useCallback((direction: RouteDirectionDraft): DcRoute[] => {
    const sourceConn = connections.find((conn) => conn.conn_id === direction.sourceConnId) ?? null;
    const destinationConn = connections.find((conn) => conn.conn_id === direction.destinationConnId) ?? null;
    const orderedRoutes = direction.sourceTags
      .map((sourceTag, index) => ({ sourceTag, destinationTag: direction.destinationTags[index] }))
      .filter((pair): pair is { sourceTag: string; destinationTag: string } => Boolean(pair.sourceTag && pair.destinationTag))
      .map(({ sourceTag, destinationTag }) => ({
        src: buildEndpoint(sourceConn, sourceTag),
        dst: buildEndpoint(destinationConn, destinationTag),
      }));
    const customRoutes = direction.customMappings
      .map((mapping) => ({ sourceTag: mapping.sourceTag, destinationTag: mapping.destinationTag }))
      .filter((pair): pair is { sourceTag: string; destinationTag: string } => Boolean(pair.sourceTag && pair.destinationTag))
      .map(({ sourceTag, destinationTag }) => ({
        src: buildEndpoint(sourceConn, sourceTag),
        dst: buildEndpoint(destinationConn, destinationTag),
      }));
    return [...orderedRoutes, ...customRoutes];
  }, [buildEndpoint, connections]);

  const draftRoutes = useMemo(
    () => routeDirections.flatMap((direction) => buildDirectionRoutes(direction)),
    [buildDirectionRoutes, routeDirections],
  );

  const getDraftStatus = useCallback((route: DcRoute): RouteDraftStatus => {
    if (endpointKey(route.src) === endpointKey(route.dst)) return 'self';
    if (routes.some((item) => routeKey(item) === routeKey(route))) return 'existing';
    return 'ready';
  }, [routes]);

  const draftRouteStatuses = useMemo(
    () => {
      const seen = new Set<string>();
      const draftRouteKeys = new Set(draftRoutes.map(routeKey));
      const existingRouteKeys = new Set(routes.map(routeKey));
      const sourcesByDestination = new Map<string, Set<string>>();
      for (const route of draftRoutes) {
        const destinationKey = endpointKey(route.dst);
        const sourceKeys = sourcesByDestination.get(destinationKey) ?? new Set<string>();
        sourceKeys.add(endpointKey(route.src));
        sourcesByDestination.set(destinationKey, sourceKeys);
      }
      return draftRoutes.map((route) => {
        const key = routeKey(route);
        const status = getDraftStatus(route);
        const reverseKey = `${endpointKey(route.dst)}->${endpointKey(route.src)}`;
        const nextStatus = status === 'ready' && (existingRouteKeys.has(reverseKey) || draftRouteKeys.has(reverseKey))
          ? 'bidirectional'
          : status === 'ready' && seen.has(key)
            ? 'duplicate'
            : status === 'ready' && (sourcesByDestination.get(endpointKey(route.dst))?.size ?? 0) > 1
              ? 'manyToOne'
              : status;
        seen.add(key);
        return { route, status: nextStatus as RouteDraftStatus };
      });
    },
    [draftRoutes, getDraftStatus, routes],
  );
  const readyRoutes = useMemo(
    () => draftRouteStatuses.filter((item) => item.status === 'ready').map((item) => item.route),
    [draftRouteStatuses],
  );
  const existingRouteCount = draftRouteStatuses.filter((item) => item.status === 'existing').length;
  const duplicateRouteCount = draftRouteStatuses.filter((item) => item.status === 'duplicate').length;
  const manyToOneRouteCount = draftRouteStatuses.filter((item) => item.status === 'manyToOne').length;
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
    if (routesToSubmit.length === 0) {
      messageApi.info('没有新的路由需要创建');
      return;
    }
    setRouteSubmitting(true);
    try {
      console.info('DataBus 批量创建路由', {
        routeCount: routesToSubmit.length,
        skippedExisting: existingRouteCount,
        skippedDuplicate: duplicateRouteCount,
        blockedManyToOne: manyToOneRouteCount,
        blockedBidirectional: bidirectionalRouteCount,
        incompletePairCount,
      });
      await api.dcUpsertRoutes(routesToSubmit, false);
      messageApi.success(`已创建 ${routesToSubmit.length} 条路由`);
      setRouteModalOpen(false);
      await refreshRoutes();
    } catch (e) {
      messageApi.error(`批量添加路由失败: ${e}`);
    } finally {
      setRouteSubmitting(false);
    }
  }, [bidirectionalRouteCount, duplicateRouteCount, existingRouteCount, incompletePairCount, manyToOneRouteCount, messageApi, refreshRoutes]);

  const handleRouteSubmit = useCallback(async () => {
    const hasDraftSelection = routeDirections.some((direction) => direction.sourceTags.length > 0
      || direction.destinationTags.length > 0
      || direction.customMappings.some((mapping) => Boolean(mapping.sourceTag || mapping.destinationTag)));
    if (!hasDraftSelection) {
      messageApi.error('请先配置至少一条路由');
      return;
    }
    const incompleteDirectionCount = routeDirections.filter((direction) => {
      const hasDirectionSelection = direction.sourceTags.length > 0
        || direction.destinationTags.length > 0
        || direction.customMappings.some((mapping) => Boolean(mapping.sourceTag || mapping.destinationTag));
      return hasDirectionSelection && (direction.sourceConnId === null || direction.destinationConnId === null);
    }).length;
    if (incompleteDirectionCount > 0) {
      messageApi.error(`还有 ${incompleteDirectionCount} 个方向没有完整选择源连接和目标连接`);
      return;
    }
    if (selfRouteCount > 0) {
      messageApi.error('请先处理预览中标记为自环的映射');
      return;
    }
    if (manyToOneRouteCount > 0) {
      messageApi.error('当前存在多对一映射：一个目标点不能被多个源点使用');
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
        title: '左右点位数量不一致',
        content: `当前有 ${readyRoutes.length + existingRouteCount + duplicateRouteCount} 条完整配对，将创建其中 ${readyRoutes.length} 条新路由；已存在或本次重复的 ${existingRouteCount + duplicateRouteCount} 条会跳过，另有 ${incompletePairCount} 个点位未配对。请确认当前顺序是否正确。`,
        okText: `仅创建 ${readyRoutes.length} 条已配对路由`,
        cancelText: '返回调整',
        onOk: () => submitRouteBatch(readyRoutes),
      });
      return;
    }
    await submitRouteBatch(readyRoutes);
  }, [bidirectionalRouteCount, duplicateRouteCount, existingRouteCount, incompletePairCount, manyToOneRouteCount, messageApi, modal, readyRoutes, routeDirections, selfRouteCount, submitRouteBatch]);

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
    const selectedRoutes = routes.filter((route) => selectedRouteKeys.includes(routeKey(route)));
    modal.confirm({
      title: '确认删除选中的路由？',
      content: `将删除 ${selectedRoutes.length} 条路由，此操作不可撤销。`,
      okText: '删除选中',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => deleteRouteBatch(selectedRoutes, `已删除 ${selectedRoutes.length} 条路由`),
    });
  }, [deleteRouteBatch, modal, routes, selectedRouteKeys]);

  const handleDeleteAllRoutes = useCallback(() => {
    modal.confirm({
      title: '确认删除全部路由？',
      content: `当前共 ${routes.length} 条路由，将全部删除，此操作不可撤销。`,
      okText: '全部删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => deleteRouteBatch(routes, `已删除全部 ${routes.length} 条路由`),
    });
  }, [deleteRouteBatch, modal, routes]);

  const connTagColumns: ColumnsType<{ tag: string; key: string }> = [
    { title: '标签', dataIndex: 'tag', key: 'tag', ellipsis: true, render: (tag: string) => <Text strong>{tag}</Text> },
    { title: '来源', key: 'source', width: 86, render: () => <Tag color="blue">自动同步</Tag> },
  ];

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
    { title: '状态', key: 'status', width: 100, render: () => <Tag color="green" icon={<CheckCircleOutlined />}>已配置</Tag> },
    {
      title: '操作', key: 'action', width: 74,
      render: (_, route) => <Popconfirm title="确认删除该路由？" description={`${endpointLabel(route.src)} → ${endpointLabel(route.dst)}`} onConfirm={() => void handleDeleteRoute(route)}><Button danger type="text" size="small">删除</Button></Popconfirm>,
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

    return routes.filter((route) => {
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
  }, [connections, routeDestinationFilter, routeSearch, routeSourceFilter, routes]);

  const routeData = filteredRoutes.map((route) => ({ ...route, key: routeKey(route) }));
  const connTagData = connTags.map((tag) => ({ tag, key: tag }));

  const connectionPanel = (
    <Card
      title={<Space size={8}><span>连接与标签</span><Tag>{connections.length}</Tag></Space>}
      size="small"
      extra={<Button type="text" size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void refreshConnections()} />}
      styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } }}
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ padding: '10px 12px 6px' }}><Text type="secondary" style={{ fontSize: 12 }}>连接由协议/控制页面自动注册，本页只用于选择端点和诊断。</Text></div>
      <div style={{ flex: 1, minHeight: 150, overflow: 'auto' }}>
        <List dataSource={connections} locale={{ emptyText: '暂无已注册连接' }} renderItem={(item) => {
          const active = item.conn_id === selectedConnId;
          const tagCount = allConnTags.get(item.conn_id)?.length ?? 0;
          return <List.Item onClick={() => setSelectedConnId(item.conn_id)} style={{ cursor: 'pointer', padding: '10px 14px', background: active ? '#37373d' : undefined, borderInlineStart: active ? '3px solid #1677ff' : '3px solid transparent' }}>
            <div style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><Text strong>{item.conn_name}</Text><Tag color="blue">{item.module_name}</Tag></div>
              <Text type="secondary" style={{ fontSize: 12 }}>conn_id {item.conn_id} · {tagCount} 个标签</Text>
            </div>
          </List.Item>;
        }} />
      </div>
      <div style={{ borderTop: '1px solid #3e3e42', padding: '12px 14px', minHeight: 180 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}><Text strong>{selectedConn ? selectedConn.conn_name : '标签目录'}</Text>{selectedConn && <Tag color="blue">{connTags.length} 个标签</Tag>}</div>
        <Table rowKey="key" columns={connTagColumns} dataSource={connTagData} pagination={false} size="small" scroll={{ y: 190 }} locale={{ emptyText: selectedConn ? '该连接暂无已同步标签' : '请选择一个连接' }} />
      </div>
    </Card>
  );

  return <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    {contextHolder}
    {view === 'config' ? <ResizableSplit
      className="data-bus-config-grid"
      defaultSize={400}
      minSize={280}
      maxSize={560}
      storageKey="mskdsp.layout.data-bus.config"
    >
      <div style={{ minHeight: 0 }}>{connectionPanel}</div>
      <Card title={<Space size={8}><span>路由配置</span><Tag color="blue">{routes.length}</Tag></Space>} size="small" extra={<Space><Button danger icon={<DeleteOutlined />} disabled={selectedRouteKeys.length === 0} loading={routeDeleting} onClick={handleDeleteSelectedRoutes}>删除选中</Button><Button danger type="text" disabled={routes.length === 0} loading={routeDeleting} onClick={handleDeleteAllRoutes}>全部删除</Button><Button icon={<ReloadOutlined />} onClick={() => void refreshRoutes()}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={openCreateRoute}>新增路由</Button></Space>} styles={{ body: { padding: 0, minHeight: 0, height: '100%' } }} style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #3e3e42' }}><Text type="secondary">单向转发绑定。源端点的最新值会转发到目标端点；同一对点位不允许同时配置两个方向。</Text></div>
        <div className="route-filter-toolbar">
          <Select<number | 'all'>
            value={routeSourceFilter}
            onChange={(value) => setRouteSourceFilter(value ?? 'all')}
            options={[{ value: 'all', label: '全部源连接' }, ...connections.map((connection) => ({ value: connection.conn_id, label: `${connection.module_name}/${connection.conn_name}` }))]}
            showSearch
            optionFilterProp="label"
            style={{ width: 190 }}
          />
          <Select<number | 'all'>
            value={routeDestinationFilter}
            onChange={(value) => setRouteDestinationFilter(value ?? 'all')}
            options={[{ value: 'all', label: '全部目标连接' }, ...connections.map((connection) => ({ value: connection.conn_id, label: `${connection.module_name}/${connection.conn_name}` }))]}
            showSearch
            optionFilterProp="label"
            style={{ width: 190 }}
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="筛选端点、标签或连接编号"
            value={routeSearch}
            onChange={(event) => setRouteSearch(event.target.value)}
            className="route-filter-search"
          />
          <Button
            type="text"
            onClick={() => { setRouteSourceFilter('all'); setRouteDestinationFilter('all'); setRouteSearch(''); }}
            disabled={routeSourceFilter === 'all' && routeDestinationFilter === 'all' && routeSearch.trim() === ''}
          >
            清空筛选
          </Button>
          <Text type="secondary" className="route-filter-count">显示 {filteredRoutes.length} / 共 {routes.length} 条</Text>
        </div>
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
          locale={{ emptyText: routes.length > 0 ? '没有符合条件的路由' : '暂无路由配置，点击右上角新增第一条路由' }}
        />
      </Card>
    </ResizableSplit> : <Card title={<Space size={8}><span>实时值</span><Tag color={autoRefresh ? 'green' : 'default'} icon={autoRefresh ? <SyncOutlined spin /> : undefined}>{autoRefresh ? '自动刷新 3 秒' : '已暂停'}</Tag></Space>} size="small" extra={<Space><Text type="secondary" style={{ fontSize: 12 }}>{lastRealtimeAt ? `上次更新 ${formatTimestamp(lastRealtimeAt)}` : '尚未更新'}</Text><Switch checked={autoRefresh} checkedChildren="自动" unCheckedChildren="暂停" onChange={setAutoRefresh} /><Button icon={<ReloadOutlined />} loading={realtimeLoading} onClick={() => void refreshRealtime()}>刷新</Button></Space>} styles={{ body: { padding: 0, minHeight: 0 } }} style={{ flex: 1, minHeight: 0 }}>
      <div style={{ padding: '12px 16px', display: 'flex', gap: 12, borderBottom: '1px solid #3e3e42' }}><Select value={monitorConnId} onChange={setMonitorConnId} style={{ width: 220 }} options={[{ value: 'all', label: '全部连接' }, ...connections.map((conn) => ({ value: conn.conn_id, label: `${conn.module_name}/${conn.conn_name}` }))]} /><Input allowClear prefix={<SearchOutlined />} placeholder="筛选标签或连接编号" value={monitorSearch} onChange={(event) => setMonitorSearch(event.target.value)} style={{ maxWidth: 320 }} /><Text type="secondary" style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 12 }}>共 {filteredRealtimeData.length} 条快照</Text></div>
      <Table rowKey="key" columns={realtimeColumns} dataSource={filteredRealtimeData} pagination={false} size="middle" scroll={{ x: 1100, y: 'calc(100vh - 290px)' }} locale={{ emptyText: connections.length ? '暂无最新值，请确认目标连接已启动并产生数据' : '暂无已注册连接' }} />
    </Card>}
    <Modal
      title="批量新增路由"
      open={routeModalOpen}
      onOk={() => void handleRouteSubmit()}
      okText={readyRoutes.length > 0 ? `创建 ${readyRoutes.length} 条新路由` : '创建路由'}
      confirmLoading={routeSubmitting}
      onCancel={() => setRouteModalOpen(false)}
      width={1080}
      destroyOnClose
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary">一对一模式按顺序匹配且两侧数量需一致；自定义映射允许一对多，但同一目标点不能被多个源点使用，也不能配置反向路由。方向最多保留正向和反向两个。</Text>
          <Segmented<RouteBatchMode>
            value={routeBatchMode}
            onChange={(value) => updateActiveDirection({ mode: value })}
            options={[{ label: '一对一批量配对', value: 'ordered' }, { label: '自定义映射', value: 'custom' }]}
          />
        </div>

        <div className="route-direction-toolbar">
          <Tabs
            className="app-view-tabs route-direction-tabs"
            activeKey={activeRouteDirectionId === null ? undefined : String(activeRouteDirectionId)}
            onChange={(key) => { setActiveRouteDirectionId(Number(key)); setRouteDrag(null); }}
            items={routeDirections.map((direction, index) => {
              const source = connections.find((conn) => conn.conn_id === direction.sourceConnId);
              const destination = connections.find((conn) => conn.conn_id === direction.destinationConnId);
              return {
                key: String(direction.id),
                label: source && destination ? `${source.conn_name} → ${destination.conn_name}` : `方向 ${index + 1}`,
              };
            })}
          />
          <Space size={8}>
            <Button icon={<PlusOutlined />} onClick={addReverseDirection} disabled={!activeRouteDirection || routeDirections.length >= 2}>添加反向配置</Button>
            <Button danger icon={<DeleteOutlined />} onClick={removeActiveDirection} disabled={!activeRouteDirection || routeDirections.length <= 1}>删除当前方向</Button>
          </Space>
        </div>

        <div className="route-connection-pickers">
          <div>
            <Text strong>源连接</Text>
            <Select
              showSearch
              value={routeSourceConnId ?? undefined}
              placeholder="选择源连接"
              options={connections.map((conn) => ({ value: conn.conn_id, label: `${conn.module_name}/${conn.conn_name}` }))}
              onChange={(value) => updateActiveDirection({ sourceConnId: value, sourceTags: [], customMappings: [{ id: Date.now() }] })}
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
              options={connections.map((conn) => ({ value: conn.conn_id, label: `${conn.module_name}/${conn.conn_name}` }))}
              onChange={(value) => updateActiveDirection({ destinationConnId: value, destinationTags: [], customMappings: [{ id: Date.now() }] })}
              style={{ width: '100%', marginTop: 8 }}
              optionFilterProp="label"
            />
          </div>
        </div>

        {routeBatchMode === 'ordered' ? (
          <div className="route-builder-grid">
            <div className="route-builder-panel">
              <Text strong>源点位</Text>
              <Text type="secondary" className="route-builder-caption">点选标签，按点击顺序编号</Text>
              <Select
                mode="multiple"
                showSearch
                allowClear
                value={selectedSourceTags}
                placeholder={routeSourceConnId ? '选择源标签' : '请先选择源连接'}
                options={routeSourceTags.map((tag) => ({ value: tag, label: tag }))}
                disabled={!routeSourceConnId || routeSourceTags.length === 0}
                onChange={(value) => updateActiveDirection({ sourceTags: value })}
                optionFilterProp="label"
                maxTagCount={0}
                maxTagPlaceholder={() => selectedSourceTags.length > 0 ? `${selectedSourceTags.length} 个点位已选` : '选择源标签'}
                notFoundContent={routeSourceConnId ? '该连接暂无标签' : '请先选择源连接'}
                style={{ width: '100%' }}
              />
              <div className="route-selected-list">
                <Text type="secondary">已选 {selectedSourceTags.length} 个</Text>
                {selectedSourceTags.map((tag, index) => <div key={tag} className="route-selected-item" draggable onDragStart={(event) => handleRouteTagDragStart(event, 'source', index)} onDragOver={handleRouteTagDragOver} onDrop={(event) => handleRouteTagDrop(event, 'source', index)} onDragEnd={() => setRouteDrag(null)}><HolderOutlined /><span className="route-selected-index">{index + 1}</span><span>{tag}</span><Button type="text" size="small" icon={<DeleteOutlined />} onClick={() => toggleRouteTag('source', tag)} /></div>)}
              </div>
            </div>
            <div className="route-builder-panel">
              <Text strong>目标点位</Text>
              <Text type="secondary" className="route-builder-caption">点选标签，按点击顺序编号；已有入站路由的目标点不可再次选择</Text>
              <Select
                mode="multiple"
                showSearch
                allowClear
                value={selectedDestinationTags}
                placeholder={routeDestinationConnId ? '选择目标标签' : '请先选择目标连接'}
                options={routeDestinationTags.map((tag) => ({
                  value: tag,
                  label: tag,
                  disabled: occupiedDestinationTags.has(tag) && !selectedDestinationTags.includes(tag),
                }))}
                disabled={!routeDestinationConnId || routeDestinationTags.length === 0}
                onChange={(value) => updateActiveDirection({ destinationTags: value })}
                optionFilterProp="label"
                maxTagCount={0}
                maxTagPlaceholder={() => selectedDestinationTags.length > 0 ? `${selectedDestinationTags.length} 个点位已选` : '选择目标标签'}
                notFoundContent={routeDestinationConnId ? '该连接暂无标签' : '请先选择目标连接'}
                style={{ width: '100%' }}
              />
              <div className="route-selected-list">
                <Text type="secondary">已选 {selectedDestinationTags.length} 个</Text>
                {selectedDestinationTags.map((tag, index) => <div key={tag} className="route-selected-item" draggable onDragStart={(event) => handleRouteTagDragStart(event, 'destination', index)} onDragOver={handleRouteTagDragOver} onDrop={(event) => handleRouteTagDrop(event, 'destination', index)} onDragEnd={() => setRouteDrag(null)}><HolderOutlined /><span className="route-selected-index">{index + 1}</span><span>{tag}</span><Button type="text" size="small" icon={<DeleteOutlined />} onClick={() => toggleRouteTag('destination', tag)} /></div>)}
              </div>
            </div>
            <div className="route-pair-preview">
              <Text type="secondary">配对预览</Text>
              {Array.from({ length: Math.max(selectedSourceTags.length, selectedDestinationTags.length) }).map((_, index) => {
                const sourceTag = selectedSourceTags.length === 1 && selectedDestinationTags.length > 1
                  ? selectedSourceTags[0]
                  : selectedSourceTags[index];
                const destinationTag = selectedDestinationTags.length === 1 && selectedSourceTags.length > 1
                  ? selectedDestinationTags[0]
                  : selectedDestinationTags[index];
                const route = sourceTag && destinationTag ? { src: buildEndpoint(routeSourceConn, sourceTag), dst: buildEndpoint(routeDestinationConn, destinationTag) } : null;
                const status = route
                  ? draftRouteStatuses.find(({ route: draftRoute }) => routeKey(draftRoute) === routeKey(route))?.status ?? getDraftStatus(route)
                  : null;
                return <div className="route-pair-row" key={index}><span className="route-pair-index">{index + 1}</span><span>{sourceTag ?? '待选择'}</span><span className="route-pair-arrow">→</span><span>{destinationTag ?? '待选择'}</span>{status === 'existing' ? <Tag color="orange">已存在</Tag> : status === 'duplicate' ? <Tag color="orange">本次重复</Tag> : status === 'manyToOne' ? <Tag color="red">多对一不允许</Tag> : status === 'bidirectional' ? <Tag color="red">双向不允许</Tag> : status === 'self' ? <Tag color="red">自环</Tag> : null}</div>;
              })}
              {selectedSourceTags.length === 0 && selectedDestinationTags.length === 0 ? <Text type="secondary">左右选择点位后将在这里显示匹配关系</Text> : null}
            </div>
          </div>
        ) : (
          <div className="route-custom-builder">
            <div className="route-custom-header"><Text strong>源点位</Text><span className="route-pair-arrow">→</span><Text strong>目标点位</Text><span /></div>
            {customMappings.map((mapping) => {
              const usedByOtherMapping = new Set(customMappings.filter((item) => item.id !== mapping.id).map((item) => item.destinationTag).filter((tag): tag is string => Boolean(tag)));
              return <div className="route-custom-row" key={mapping.id}>
              <Select showSearch allowClear value={mapping.sourceTag} placeholder="选择源标签" options={routeSourceTags.map((tag) => ({ value: tag, label: tag }))} onChange={(value) => updateCustomMapping(mapping.id, 'sourceTag', value)} disabled={!routeSourceConnId} optionFilterProp="label" />
              <span className="route-pair-arrow">→</span>
              <Select showSearch allowClear value={mapping.destinationTag} placeholder="选择目标标签" options={routeDestinationTags.map((tag) => ({ value: tag, label: tag, disabled: (occupiedDestinationTags.has(tag) || usedByOtherMapping.has(tag)) && tag !== mapping.destinationTag }))} onChange={(value) => updateCustomMapping(mapping.id, 'destinationTag', value)} disabled={!routeDestinationConnId} optionFilterProp="label" />
              <Button type="text" danger icon={<DeleteOutlined />} onClick={() => removeCustomMapping(mapping.id)} />
            </div>;
            })}
            <Button type="dashed" icon={<PlusOutlined />} onClick={addCustomMapping}>添加映射行</Button>
            <Text type="secondary">同一个源点可以重复使用来实现一对多；目标点已被其他源点使用或已有入站路由时不可再次选择。</Text>
          </div>
        )}

        <div className="route-submit-summary">
          <Text strong>提交预览</Text>
          <Text type="secondary">已配置 {draftRoutes.length} 条，其中 {readyRoutes.length} 条可创建{incompletePairCount > 0 ? `，${incompletePairCount} 个点位未配对` : ''}</Text>
          {draftRouteStatuses.map(({ route, status }, index) => <div key={`${routeKey(route)}-${index}`} className="route-summary-row"><span>{index + 1}</span><span>{route.src.tag}</span><span className="route-pair-arrow">→</span><span>{route.dst.tag}</span><Tag color={status === 'ready' ? 'green' : status === 'self' || status === 'manyToOne' || status === 'bidirectional' ? 'red' : 'orange'}>{status === 'ready' ? '可创建' : status === 'existing' ? '已存在' : status === 'duplicate' ? '本次重复' : status === 'manyToOne' ? '多对一不允许' : status === 'bidirectional' ? '双向不允许' : '自环'}</Tag></div>)}
        </div>
      </Space>
    </Modal>
  </div>;
};

export default DataBus;
