import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Form,
  List,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../../adapters';
import type {
  DcConnectionInfo,
  DcRoute,
  DcPointUpdate,
} from '../../adapters';
import { formatAutoRealtimeNumber } from '../../utils/realtime-value';

const { Text } = Typography;

// ── Constants ──

const QUALITY_MAP: Record<number, { label: string; color: string }> = {
  0: { label: '未指定', color: 'default' },
  1: { label: '正常', color: 'green' },
  2: { label: '异常', color: 'red' },
  3: { label: '不确定', color: 'orange' },
};

// ── Helpers ──

const resolveConnName = (connId: number, conns: DcConnectionInfo[]): string => {
  const c = conns.find((item) => item.conn_id === connId);
  return c ? c.conn_name : `连接_${connId}`;
};

const formatTimestamp = (tsMs: number): string => {
  if (tsMs <= 0) return '-';
  const d = new Date(tsMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
};

const formatPointValue = (pv: DcPointUpdate['value']): string => {
  if (!pv) return '-';
  switch (pv.type) {
    case 'Bool':
      return pv.value ? '是' : '否';
    case 'Int':
      return String(pv.value);
    case 'Double':
      return formatAutoRealtimeNumber(pv.value);
    case 'String':
      return pv.value;
    case 'Bytes':
      return `[${pv.value.length} 字节]`;
    default:
      return '-';
  }
};

// ── Route Card Component ──

const RouteCard: React.FC<{
  route: DcRoute;
  conns: DcConnectionInfo[];
  onDelete: () => void;
}> = ({ route, conns, onDelete }) => {
  const srcName = resolveConnName(route.src.conn_id, conns);
  const dstName = resolveConnName(route.dst.conn_id, conns);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        padding: '8px 0',
      }}
    >
      {/* Source box */}
      <div
        style={{
          background: '#37373d',
          border: '1px solid #3e3e42',
          borderRadius: 4,
          padding: '6px 12px',
          minWidth: 200,
          flex: 1,
        }}
      >
        <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
          源端
        </Text>
        <Text style={{ color: '#fff' }}>
          {srcName} : {route.src.tag}
        </Text>
      </div>

      {/* Arrow */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '0 8px',
          minWidth: 56,
        }}
      >
        <Text type="secondary" style={{ fontSize: 11 }}>转发</Text>
        <svg width="40" height="12" viewBox="0 0 40 12">
          <line
            x1="0"
            y1="6"
            x2="32"
            y2="6"
            stroke="#007acc"
            strokeWidth="2"
          />
          <polygon points="30,2 38,6 30,10" fill="#007acc" />
        </svg>
      </div>

      {/* Destination box */}
      <div
        style={{
          background: '#37373d',
          border: '1px solid #3e3e42',
          borderRadius: 4,
          padding: '6px 12px',
          minWidth: 200,
          flex: 1,
        }}
      >
        <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
          目标端
        </Text>
        <Text style={{ color: '#fff' }}>
          {dstName} : {route.dst.tag}
        </Text>
      </div>

      {/* Delete button */}
      <Popconfirm
        title="确认删除该路由？"
        onConfirm={onDelete}
      >
        <Button
          danger
          size="small"
          style={{ marginLeft: 8 }}
        >
          删除
        </Button>
      </Popconfirm>
    </div>
  );
};

// ── Main Component ──

const DataBus: React.FC = () => {
  const [connections, setConnections] = useState<DcConnectionInfo[]>([]);
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [connTags, setConnTags] = useState<string[]>([]);
  const [routes, setRoutes] = useState<DcRoute[]>([]);
  const [realtimeUpdates, setRealtimeUpdates] = useState<DcPointUpdate[]>([]);
  const [loading, setLoading] = useState(false);
  const [routeModalOpen, setRouteModalOpen] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [routeForm] = Form.useForm();

  // ── Data Loading ──

  const refreshConnections = useCallback(async () => {
    setLoading(true);
    try {
      const conns = await api.dcListConnections();
      setConnections(conns);
    } catch (e) {
      messageApi.error(`刷新连接注册表失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  const loadConnTags = useCallback(async (connId: number) => {
    try {
      const ct = await api.dcGetConnTags(connId);
      setConnTags(ct.tags);
    } catch {
      setConnTags([]);
    }
  }, []);

  const refreshRoutes = useCallback(async () => {
    try {
      const r = await api.dcListRoutes(0, '', 0, '');
      setRoutes(r);
    } catch (e) {
      messageApi.error(`刷新路由列表失败: ${e}`);
    }
  }, [messageApi]);

  const refreshRealtime = useCallback(async () => {
    try {
      const allUpdates: DcPointUpdate[] = [];
      for (const conn of connections) {
        try {
          const updates = await api.dcGetLatest(conn.conn_id, []);
          allUpdates.push(...updates);
        } catch {
          // 某连接无数据，忽略
        }
      }
      setRealtimeUpdates(allUpdates);
    } catch (e) {
      messageApi.error(`刷新实时值失败: ${e}`);
    }
  }, [connections, messageApi]);

  // ── Effects ──

  useEffect(() => {
    void refreshConnections();
    void refreshRoutes();
  }, [refreshConnections, refreshRoutes]);

  useEffect(() => {
    if (selectedConnId !== null) {
      void loadConnTags(selectedConnId);
    } else {
      setConnTags([]);
    }
  }, [selectedConnId, loadConnTags]);

  useEffect(() => {
    if (connections.length > 0) {
      void refreshRealtime();
    }
  }, [connections, refreshRealtime]);

  // ── Route Handlers ──

  const openCreateRoute = useCallback(() => {
    routeForm.resetFields();
    setRouteModalOpen(true);
  }, [routeForm]);

  const handleRouteSubmit = useCallback(async () => {
    try {
      const values = await routeForm.validateFields();
      const [srcConnId, srcTag] = (values.source as string).split(':');
      const [dstConnId, dstTag] = (values.destination as string).split(':');
      const newRoute: DcRoute = {
        src: { conn_id: Number(srcConnId), tag: srcTag },
        dst: { conn_id: Number(dstConnId), tag: dstTag },
      };
      await api.dcUpsertRoutes([newRoute], false);
      messageApi.success('路由已添加');
      setRouteModalOpen(false);
      await refreshRoutes();
    } catch (e) {
      messageApi.error(`添加路由失败: ${e}`);
    }
  }, [routeForm, messageApi, refreshRoutes]);

  const handleDeleteRoute = useCallback(
    async (route: DcRoute) => {
      try {
        await api.dcDeleteRoutes([route]);
        messageApi.success('路由已删除');
        await refreshRoutes();
      } catch (e) {
        messageApi.error(`删除路由失败: ${e}`);
      }
    },
    [messageApi, refreshRoutes],
  );

  // ── Build endpoint options for route form ──

  const [allConnTags, setAllConnTags] = useState<Map<number, string[]>>(new Map());

  useEffect(() => {
    const loadAll = async () => {
      const map = new Map<number, string[]>();
      for (const conn of connections) {
        try {
          const ct = await api.dcGetConnTags(conn.conn_id);
          map.set(conn.conn_id, ct.tags);
        } catch {
          map.set(conn.conn_id, []);
        }
      }
      setAllConnTags(map);
    };
    if (connections.length > 0) {
      void loadAll();
    }
  }, [connections]);

  const endpointOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const conn of connections) {
      const tags = allConnTags.get(conn.conn_id) ?? [];
      for (const tag of tags) {
        opts.push({
          value: `${conn.conn_id}:${tag}`,
          label: `${conn.conn_name} : ${tag}`,
        });
      }
    }
    return opts;
  }, [connections, allConnTags]);

  // ── Derived ──

  const selectedConn = connections.find((c) => c.conn_id === selectedConnId) ?? null;

  // ── ConnTags Table (mockup: Tag / 数据类型 / 读写属性 / 描述) ──
  // NOTE: proto ConnTags 目前只返回 tag 名列表，无元信息。
  //       数据类型/读写属性/描述列显示占位 "-"，后续 proto 扩展后接入。

  const connTagColumns: ColumnsType<{ tag: string; key: number }> = [
    {
      title: '标签',
      dataIndex: 'tag',
      key: 'tag',
      width: 140,
      ellipsis: true,
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: '数据类型',
      key: 'data_type',
      width: 110,
      render: () => <Text type="secondary">-</Text>,
    },
    {
      title: '读写属性',
      key: 'access',
      width: 120,
      render: () => <Text type="secondary">-</Text>,
    },
    {
      title: '描述',
      key: 'description',
      width: 100,
      render: () => <Text type="secondary">-</Text>,
    },
  ];

  const connTagData = useMemo(
    () => connTags.map((tag, i) => ({ tag, key: i })),
    [connTags],
  );

  // ── Realtime Columns ──

  const realtimeColumns: ColumnsType<DcPointUpdate & { key: string }> = [
    {
      title: '连接编号 : 标签',
      key: 'endpoint',
      width: 240,
      render: (_, record) => (
        <Text>
          {resolveConnName(record.dst_conn_id, connections)} : {record.dst_tag}
        </Text>
      ),
    },
    {
      title: '当前值',
      key: 'value',
      width: 120,
      render: (_, record) => formatPointValue(record.value),
    },
    {
      title: '时间戳',
      key: 'ts',
      width: 160,
      render: (_, record) => (
        <Text style={{ fontFamily: '"Consolas", monospace', fontSize: 12 }}>
          {formatTimestamp(record.ts_ms)}
        </Text>
      ),
    },
    {
      title: '质量',
      key: 'quality',
      width: 110,
      render: (_, record) => {
        const q = QUALITY_MAP[record.quality] ?? QUALITY_MAP[0];
        return <Tag color={q.color}>{q.label}</Tag>;
      },
    },
  ];

  const realtimeData = useMemo(
    () =>
      realtimeUpdates.map((u, i) => ({
        ...u,
        key: `${u.dst_conn_id}:${u.dst_tag}-${i}`,
      })),
    [realtimeUpdates],
  );

  // ── Render ──

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        flex: 1,
        minHeight: 0,
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {contextHolder}

      <div
        style={{
          display: 'flex',
          gap: 16,
          flex: 1,
          minHeight: 0,
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            flex: '1 1 min(100%, 320px)',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <Card
            title="连接注册表"
            size="small"
            bordered
            style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', minHeight: 0 }}
            styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '8px 0' } }}
            extra={
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={() => void refreshConnections()}
              />
            }
          >
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <List
                dataSource={connections}
                locale={{ emptyText: '暂无连接' }}
                renderItem={(item) => {
                  const isActive = item.conn_id === selectedConnId;
                  return (
                    <List.Item
                      onClick={() => setSelectedConnId(item.conn_id)}
                      style={{
                        cursor: 'pointer',
                        padding: '8px 16px',
                        background: isActive ? '#37373d' : 'transparent',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          width: '100%',
                          gap: 12,
                        }}
                      >
                        <Text style={{ color: '#fff', flex: 1 }}>
                          {item.conn_name}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12, minWidth: 80 }}>
                          {item.module_name}
                        </Text>
                      </div>
                    </List.Item>
                  );
                }}
              />
            </div>
          </Card>

          <Card
            title={
              <Space>
                <span>连接标签注册表</span>
                {selectedConn && (
                  <Text type="secondary" style={{ fontSize: 13, fontWeight: 'normal' }}>
                    当前选中: {selectedConn.conn_name}
                  </Text>
                )}
              </Space>
            }
            size="small"
            bordered
            style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', minHeight: 0 }}
            styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } }}
          >
            <Table
              rowKey="key"
              columns={connTagColumns}
              dataSource={connTagData}
              pagination={false}
              size="small"
              tableLayout="fixed"
              scroll={{ x: 480, y: 'calc(50vh - 260px)' }}
              locale={{
                emptyText: selectedConnId
                  ? '该连接暂无标签'
                  : '请先在上方选择连接',
              }}
            />
            <div style={{ marginTop: 'auto', paddingTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                提示: 连接标签是数据中心视角的抽象标签，与底层协议点表中的具体地址定义解耦。
              </Text>
            </div>
          </Card>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            flex: '2 1 min(100%, 640px)',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <Card
            title="路由管理"
            size="small"
            bordered
            style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', minHeight: 0 }}
            styles={{ body: { flex: 1, padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } }}
            extra={
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={openCreateRoute}
              >
                新增路由
              </Button>
            }
          >
            {routes.length === 0 ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: 1,
                  color: '#666',
                }}
              >
                暂无路由配置
              </div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 16px' }}>
                {routes.map((route, index) => (
                  <RouteCard
                    key={`${route.src.conn_id}:${route.src.tag}->${route.dst.conn_id}:${route.dst.tag}-${index}`}
                    route={route}
                    conns={connections}
                    onDelete={() => void handleDeleteRoute(route)}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card
            title="实时值监控"
            size="small"
            bordered
            style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', minHeight: 0 }}
            styles={{ body: { flex: 1, minHeight: 0 } }}
            extra={
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => void refreshRealtime()}
              />
            }
          >
            <Table
              rowKey="key"
              columns={realtimeColumns}
              dataSource={realtimeData}
              pagination={false}
              size="small"
              scroll={{ x: 720, y: 'calc(50vh - 220px)' }}
              locale={{ emptyText: '暂无实时数据' }}
            />
          </Card>
        </div>
      </div>

      {/* ─── Route Modal ─── */}
      <Modal
        title="新增路由"
        open={routeModalOpen}
        onOk={() => void handleRouteSubmit()}
        onCancel={() => setRouteModalOpen(false)}
        width={560}
        destroyOnClose
      >
        <Form form={routeForm} layout="vertical" size="small">
          <Form.Item
            name="source"
            label="源端点"
            rules={[{ required: true, message: '请选择源端点' }]}
          >
            <Select
              showSearch
              placeholder="选择源 连接:标签"
              options={endpointOptions}
              filterOption={(input, option) =>
                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item
            name="destination"
            label="目标端点"
            rules={[{ required: true, message: '请选择目标端点' }]}
          >
            <Select
              showSearch
              placeholder="选择目标 连接:标签"
              options={endpointOptions}
              filterOption={(input, option) =>
                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default DataBus;
