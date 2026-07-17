import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  List,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../../adapters';
import type { DcConnectionInfo, DcPointUpdate, DcRoute } from '../../adapters';
import { formatAutoRealtimeNumber } from '../../utils/realtime-value';
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

const encodeEndpoint = (endpoint: DcRoute['src']): string => JSON.stringify(endpoint);
const decodeEndpoint = (value: string): DcRoute['src'] => JSON.parse(value) as DcRoute['src'];

const endpointLabel = (endpoint: DcRoute['src']): string =>
  `${endpoint.module_name}/${endpoint.conn_name} : ${endpoint.tag}`;

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

const DataBus: React.FC = () => {
  const [connections, setConnections] = useState<DcConnectionInfo[]>([]);
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [connTags, setConnTags] = useState<string[]>([]);
  const [allConnTags, setAllConnTags] = useState<Map<number, string[]>>(new Map());
  const [routes, setRoutes] = useState<DcRoute[]>([]);
  const [realtimeUpdates, setRealtimeUpdates] = useState<DcPointUpdate[]>([]);
  const [loading, setLoading] = useState(false);
  const [realtimeLoading, setRealtimeLoading] = useState(false);
  const [routeModalOpen, setRouteModalOpen] = useState(false);
  const [view, setView] = useState<'config' | 'monitor'>('config');
  const [monitorConnId, setMonitorConnId] = useState<number | 'all'>('all');
  const [monitorSearch, setMonitorSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRealtimeAt, setLastRealtimeAt] = useState(0);
  const [messageApi, contextHolder] = message.useMessage();
  const [routeForm] = Form.useForm();

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

  const selectedConn = connections.find((conn) => conn.conn_id === selectedConnId) ?? null;
  const endpointOptions = useMemo(() => connections.flatMap((conn) =>
    (allConnTags.get(conn.conn_id) ?? []).map((tag) => {
      const endpoint = { module_name: conn.module_name, conn_name: conn.conn_name, conn_id: conn.conn_id, tag };
      return { value: encodeEndpoint(endpoint), label: `${endpointLabel(endpoint)}  (conn_id ${conn.conn_id})` };
    })), [connections, allConnTags]);

  const openCreateRoute = useCallback(() => { routeForm.resetFields(); setRouteModalOpen(true); }, [routeForm]);

  const handleRouteSubmit = useCallback(async () => {
    try {
      const values = await routeForm.validateFields();
      const src = decodeEndpoint(values.source as string);
      const dst = decodeEndpoint(values.destination as string);
      if (endpointKey(src) === endpointKey(dst)) throw new Error('源端点与目标端点不能相同');
      const route: DcRoute = { src, dst };
      if (routes.some((item) => routeKey(item) === routeKey(route))) throw new Error('该路由已存在');
      await api.dcUpsertRoutes([route], false);
      messageApi.success('路由已添加');
      setRouteModalOpen(false);
      await refreshRoutes();
    } catch (e) {
      messageApi.error(`添加路由失败: ${e}`);
    }
  }, [messageApi, refreshRoutes, routeForm, routes]);

  const handleDeleteRoute = useCallback(async (route: DcRoute) => {
    try {
      await api.dcDeleteRoutes([route]);
      messageApi.success('路由已删除');
      await refreshRoutes();
    } catch (e) { messageApi.error(`删除路由失败: ${e}`); }
  }, [messageApi, refreshRoutes]);

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

  const routeData = routes.map((route, index) => ({ ...route, key: `${routeKey(route)}-${index}` }));
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
    <Tabs activeKey={view} onChange={(key) => setView(key as 'config' | 'monitor')} items={[{ key: 'config', label: '拓扑配置' }, { key: 'monitor', label: '运行监视' }]} style={{ flex: 'none' }} />
    {view === 'config' ? <div className="data-bus-config-grid" style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(280px, 0.32fr) minmax(0, 1fr)', gap: 16 }}>
      <div style={{ minHeight: 0 }}>{connectionPanel}</div>
      <Card title={<Space size={8}><span>路由配置</span><Tag color="blue">{routes.length}</Tag></Space>} size="small" extra={<Space><Button icon={<ReloadOutlined />} onClick={() => void refreshRoutes()}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={openCreateRoute}>新增路由</Button></Space>} styles={{ body: { padding: 0, minHeight: 0, height: '100%' } }} style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #3e3e42' }}><Text type="secondary">单向转发绑定。源端点的最新值会转发到目标端点；双向链路需要分别配置两条路由。</Text></div>
        <Table rowKey="key" columns={routeColumns} dataSource={routeData} pagination={false} size="middle" scroll={{ x: 880, y: 'calc(100vh - 330px)' }} locale={{ emptyText: '暂无路由配置，点击右上角新增第一条路由' }} />
      </Card>
    </div> : <Card title={<Space size={8}><span>实时值</span><Tag color={autoRefresh ? 'green' : 'default'} icon={autoRefresh ? <SyncOutlined spin /> : undefined}>{autoRefresh ? '自动刷新 3 秒' : '已暂停'}</Tag></Space>} size="small" extra={<Space><Text type="secondary" style={{ fontSize: 12 }}>{lastRealtimeAt ? `上次更新 ${formatTimestamp(lastRealtimeAt)}` : '尚未更新'}</Text><Switch checked={autoRefresh} checkedChildren="自动" unCheckedChildren="暂停" onChange={setAutoRefresh} /><Button icon={<ReloadOutlined />} loading={realtimeLoading} onClick={() => void refreshRealtime()}>刷新</Button></Space>} styles={{ body: { padding: 0, minHeight: 0 } }} style={{ flex: 1, minHeight: 0 }}>
      <div style={{ padding: '12px 16px', display: 'flex', gap: 12, borderBottom: '1px solid #3e3e42' }}><Select value={monitorConnId} onChange={setMonitorConnId} style={{ width: 220 }} options={[{ value: 'all', label: '全部连接' }, ...connections.map((conn) => ({ value: conn.conn_id, label: `${conn.module_name}/${conn.conn_name}` }))]} /><Input allowClear prefix={<SearchOutlined />} placeholder="筛选标签或连接编号" value={monitorSearch} onChange={(event) => setMonitorSearch(event.target.value)} style={{ maxWidth: 320 }} /><Text type="secondary" style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 12 }}>共 {filteredRealtimeData.length} 条快照</Text></div>
      <Table rowKey="key" columns={realtimeColumns} dataSource={filteredRealtimeData} pagination={false} size="middle" scroll={{ x: 1100, y: 'calc(100vh - 290px)' }} locale={{ emptyText: connections.length ? '暂无最新值，请确认目标连接已启动并产生数据' : '暂无已注册连接' }} />
    </Card>}
    <Modal title="新增路由" open={routeModalOpen} onOk={() => void handleRouteSubmit()} onCancel={() => setRouteModalOpen(false)} width={620} destroyOnClose>
      <Form form={routeForm} layout="vertical" size="small">
        <Form.Item name="source" label="源端点（数据从这里发出）" rules={[{ required: true, message: '请选择源端点' }]}><Select showSearch placeholder="选择源连接与标签" options={endpointOptions} optionRender={(option) => <div><div>{option.label}</div><Text type="secondary" style={{ fontSize: 11 }}>源端点</Text></div>} filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())} /></Form.Item>
        <div style={{ textAlign: 'center', color: '#1677ff', margin: '-4px 0 8px' }}>↓ 单向转发 ↓</div>
        <Form.Item name="destination" label="目标端点（值将写入这里）" rules={[{ required: true, message: '请选择目标端点' }]}><Select showSearch placeholder="选择目标连接与标签" options={endpointOptions} optionRender={(option) => <div><div>{option.label}</div><Text type="secondary" style={{ fontSize: 11 }}>目标端点</Text></div>} filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())} /></Form.Item>
        <Text type="secondary">提示：请确认源/目标方向和点位类型兼容；系统会阻止重复路由和源目标相同的自环。</Text>
      </Form>
    </Modal>
  </div>;
};

export default DataBus;
