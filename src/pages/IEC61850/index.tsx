import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Card, Descriptions, Divider, Form, Input, InputNumber, Modal,
  Select, Space, Switch, Table, Tabs, Tag, Typography, message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, ImportOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, PlayCircleOutlined, StopOutlined } from '@ant-design/icons';
import { api } from '../../adapters';
import type {
  Iec61850IedConfig, Iec61850IedInfo, Iec61850ModelSummary,
  Iec61850SclAccessPointSummary, Iec61850SclIedSummary,
  Iec61850NetworkChannelConfig, Iec61850PointMapping, Iec61850RuntimeStatistics,
} from '../../adapters';
import './index.css';

const { Text, Title } = Typography;

const stateMap: Record<number, { label: string; color: string }> = {
  0: { label: '未知', color: 'default' }, 1: { label: '已停止', color: 'default' },
  2: { label: '启动中', color: 'processing' }, 3: { label: '运行中', color: 'success' },
  4: { label: '降级', color: 'warning' }, 5: { label: '停止中', color: 'processing' },
  6: { label: '待删除', color: 'warning' }, 7: { label: '错误', color: 'error' },
};
const channelStateMap: Record<number, string> = { 0: '未知', 1: '禁用', 2: '未连接', 3: '连接中', 4: '已连接', 5: '错误' };
const documentKindMap: Record<number, string> = { 0: '未知', 1: 'SCD', 2: 'CID', 3: 'ICD' };
const fcOptions = [{ value: 1, label: 'ST 状态' }, { value: 2, label: 'MX 测量' }, { value: 3, label: 'SP 定值' }, { value: 13, label: 'CO 控制' }, { value: 15, label: 'BR 缓冲报告' }];
const valueTypeOptions = [{ value: 1, label: 'BOOL' }, { value: 2, label: 'INT64' }, { value: 3, label: 'DOUBLE' }, { value: 4, label: 'STRING' }];

const defaultChannel = (channel: number): Iec61850NetworkChannelConfig => ({
  channel, enabled: channel === 1, interface_name: '', subnetwork_name: '', local_ip: '', remote_ip: '', remote_port: 102,
});

const defaultConfig = (modelName = '', communicationReady = false): Iec61850IedConfig => ({
  conn_name: '', model_name: modelName, ied_name: '', access_point: '',
  channels: [
    { ...defaultChannel(1), enabled: communicationReady },
    { ...defaultChannel(2), enabled: false },
  ],
  enable_mms: communicationReady, enable_goose: false, enable_sv: false,
  auto_start: false, mms_event_queue_capacity: 0, publish_batch_size: 0, publish_batch_window_ms: 0,
  protection_rules: [],
  nominal_frequency_hz: 50, realtime_cpu_indices: [], realtime_scheduling: 0, realtime_priority: 0, realtime_failure_mode: 1,
});

type Iec61850IedFormValues = Pick<Iec61850IedConfig,
  'conn_name' | 'model_name' | 'ied_name' | 'access_point'
  | 'enable_mms' | 'enable_goose' | 'enable_sv' | 'auto_start'>;

const toIedFormValues = (config: Iec61850IedConfig): Iec61850IedFormValues => ({
  conn_name: config.conn_name,
  model_name: config.model_name,
  ied_name: config.ied_name,
  access_point: config.access_point,
  enable_mms: config.enable_mms,
  enable_goose: config.enable_goose,
  enable_sv: config.enable_sv,
  auto_start: config.auto_start,
});

const formatNumber = (value: number) => value.toLocaleString('zh-CN');

const IEC61850Page: React.FC = () => {
  const [models, setModels] = useState<Iec61850ModelSummary[]>([]);
  const [ieds, setIeds] = useState<Iec61850IedInfo[]>([]);
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [mappings, setMappings] = useState<Iec61850PointMapping[]>([]);
  const [stats, setStats] = useState<Iec61850RuntimeStatistics | null>(null);
  const [config, setConfig] = useState<Iec61850IedConfig>(defaultConfig());
  const [loading, setLoading] = useState(false);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [iedModalOpen, setIedModalOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<string | null>(null);
  const [modelName, setModelName] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [modelMessage, setModelMessage] = useState<string | null>(null);
  const [modelMessageType, setModelMessageType] = useState<'success' | 'warning' | 'error'>('success');
  const [iedForm] = Form.useForm<Iec61850IedFormValues>();
  const [iedDraftModelName, setIedDraftModelName] = useState('');
  const [iedDraftName, setIedDraftName] = useState('');
  const [messageApi, contextHolder] = message.useMessage();
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedIed = useMemo(() => ieds.find((item) => item.config?.conn_name === selectedConn) ?? null, [ieds, selectedConn]);
  const selectedModelCatalog = useMemo(
    () => models.find((model) => model.model_name === iedDraftModelName) ?? null,
    [iedDraftModelName, models],
  );
  const selectedModelIeds = useMemo<Iec61850SclIedSummary[]>(
    () => selectedModelCatalog?.ieds ?? [],
    [selectedModelCatalog],
  );
  const selectedIedAccessPoints = useMemo<Iec61850SclAccessPointSummary[]>(
    () => selectedModelIeds.find((item) => item.name === iedDraftName)?.access_points ?? [],
    [iedDraftName, selectedModelIeds],
  );
  const chooseModelForIedForm = (modelName: string) => {
    const model = models.find((item) => item.model_name === modelName);
    const modelIeds = model?.ieds ?? [];
    const nextIed = modelIeds.length === 1 ? modelIeds[0].name : '';
    const nextAccessPoints = modelIeds.find((item) => item.name === nextIed)?.access_points ?? [];
    const nextServerAccessPoints = nextAccessPoints.filter((item) => item.has_server);
    const nextAccessPoint = nextServerAccessPoints.length === 1 ? nextServerAccessPoints[0].name : '';
    console.info('IEC61850新增IED已切换模型目录', { modelName, iedCount: modelIeds.length, selectedIed: nextIed });
    setIedDraftModelName(modelName);
    setIedDraftName(nextIed);
    iedForm.setFieldsValue({ model_name: modelName, ied_name: nextIed, access_point: nextAccessPoint });
    setConfig((current) => ({ ...current, model_name: modelName, ied_name: nextIed, access_point: nextAccessPoint }));
  };

  const chooseIedForForm = (iedName: string) => {
    const accessPoints = selectedModelIeds.find((item) => item.name === iedName)?.access_points ?? [];
    const nextServerAccessPoints = accessPoints.filter((item) => item.has_server);
    const nextAccessPoint = nextServerAccessPoints.length === 1 ? nextServerAccessPoints[0].name : '';
    console.info('IEC61850新增IED已切换IED目录', { iedName, accessPointCount: accessPoints.length, selectedAccessPoint: nextAccessPoint });
    setIedDraftName(iedName);
    iedForm.setFieldsValue({ ied_name: iedName, access_point: nextAccessPoint });
    setConfig((current) => ({ ...current, ied_name: iedName, access_point: nextAccessPoint }));
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [modelResult, iedResult] = await Promise.allSettled([api.iec61850ListModels(), api.iec61850ListIeds()]);
      if (modelResult.status === 'fulfilled') {
        setModels(modelResult.value);
      }
      if (iedResult.status === 'fulfilled') {
        const nextIeds = iedResult.value;
        setIeds(nextIeds);
        if (selectedConn && !nextIeds.some((item) => item.config?.conn_name === selectedConn)) setSelectedConn(null);
        if (!selectedConn && nextIeds[0]?.config?.conn_name) setSelectedConn(nextIeds[0].config.conn_name);
      }
      if (modelResult.status === 'rejected' && iedResult.status === 'rejected') {
        throw modelResult.reason;
      }
      if (modelResult.status === 'rejected') {
        setModelMessage(`模型列表加载失败：${String(modelResult.reason)}`);
      }
      if (iedResult.status === 'rejected') {
        messageApi.warning(`IED 列表加载失败：${String(iedResult.reason)}`);
      }
    } catch (error) {
      setModelMessage(`IEC61850 配置加载失败：${String(error)}`);
      messageApi.error(`加载 IEC61850 配置失败: ${String(error)}`);
    }
    finally { setLoading(false); }
  }, [messageApi, selectedConn]);

  const loadSelected = useCallback(async (connName: string) => {
    try {
      const [ied, table, runtime] = await Promise.all([api.iec61850GetIed(connName), api.iec61850GetPointMappings(connName), api.iec61850GetRuntimeStatistics(connName)]);
      if (ied.config) setConfig(ied.config);
      setMappings(table.points);
      setStats(runtime);
    } catch (error) { messageApi.error(`加载 IED 详情失败: ${String(error)}`); }
  }, [messageApi]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (selectedConn) void loadSelected(selectedConn); }, [loadSelected, selectedConn]);

  const importScl = async (validateOnly: boolean) => {
    const file = fileRef.current?.files?.[0];
    if (!file) { messageApi.warning('请选择 SCL 文件'); return; }
    const name = modelName.trim() || file.name.replace(/\.[^.]+$/, '');
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const result = await api.iec61850ImportScl(name, sourceName.trim() || file.name, bytes, validateOnly, true);
      const errors = result.issues.filter((item) => item.severity === 2);
      if (!result.summary) {
        const detail = result.issues[0]?.message || 'SCL 文件未生成模型摘要，请检查文件格式';
        setModelMessage(detail);
        setModelMessageType('error');
        messageApi.error(detail);
        return;
      }
      const issueText = result.issues.length > 0 ? `，诊断 ${result.issues.length} 条` : '';
      if (errors.length) {
        setModelMessage(`SCL 校验发现 ${errors.length} 个错误${issueText}`);
        setModelMessageType('error');
        messageApi.error(`SCL 校验发现 ${errors.length} 个错误`);
      } else {
        const successText = validateOnly ? 'SCL 校验通过' : `SCL 模型导入完成：${result.summary.model_name}`;
        setModelMessage(`${successText}${issueText}`);
        setModelMessageType(result.issues.length > 0 ? 'warning' : 'success');
        messageApi.success(successText);
      }
      if (!validateOnly) {
        setModelModalOpen(false);
        setModelName('');
        setSourceName('');
        await refresh();
      }
    } catch (error) {
      const detail = `SCL 操作失败：${String(error)}`;
      setModelMessage(detail);
      setModelMessageType('error');
      messageApi.error(detail);
    }
  };

  const saveIed = async (values: Iec61850IedFormValues) => {
    try {
      const nextConfig: Iec61850IedConfig = { ...config, ...values };
      const result = await api.iec61850UpsertIed(nextConfig, !editingConn);
      setIedModalOpen(false); setSelectedConn(result.config?.conn_name ?? values.conn_name); await refresh();
      messageApi.success('IED 配置已保存');
    } catch (error) { messageApi.error(`保存 IED 失败: ${String(error)}`); }
  };

  const saveConfig = async () => {
    if (!selectedConn) return;
    try {
      const result = await api.iec61850UpsertIed(config, false);
      setIeds((current) => current.map((item) => item.config?.conn_name === selectedConn ? result : item));
      messageApi.success('通信配置已保存');
    } catch (error) { messageApi.error(`保存通信配置失败: ${String(error)}`); }
  };

  const toggleRuntime = async () => {
    if (!selectedConn || !selectedIed) return;
    try {
      if (selectedIed.state === 3 || selectedIed.state === 2) await api.iec61850StopIed(selectedConn);
      else await api.iec61850StartIed(selectedConn);
      await refresh(); await loadSelected(selectedConn);
    } catch (error) { messageApi.error(`运行状态操作失败: ${String(error)}`); }
  };

  const deleteSelected = async () => {
    if (!selectedConn) return;
    try { await api.iec61850DeleteIed(selectedConn); setSelectedConn(null); await refresh(); messageApi.success('IED 已删除'); }
    catch (error) { messageApi.error(`删除 IED 失败: ${String(error)}`); }
  };

  const openCreateIed = () => {
    if (models.length === 0) {
      messageApi.info('请先导入 SCL 模型，再创建 IED');
      setModelModalOpen(true);
      return;
    }
    setEditingConn(null);
    const nextConfig = defaultConfig(models[0]?.model_name ?? '');
    const firstModelIeds = models[0]?.ieds ?? [];
    const firstIed = firstModelIeds.length === 1 ? firstModelIeds[0] : undefined;
    const firstServerAccessPoints = firstIed?.access_points.filter((item) => item.has_server) ?? [];
    const firstAccessPoint = firstServerAccessPoints.length === 1 ? firstServerAccessPoints[0].name : '';
    nextConfig.ied_name = firstIed?.name ?? '';
    nextConfig.access_point = firstAccessPoint;
    setConfig(nextConfig);
    setIedDraftModelName(nextConfig.model_name);
    setIedDraftName(nextConfig.ied_name);
    iedForm.resetFields();
    iedForm.setFieldsValue(toIedFormValues(nextConfig));
    setIedModalOpen(true);
  };

  const updateChannel = (index: number, patch: Partial<Iec61850NetworkChannelConfig>) => {
    setConfig((current) => ({ ...current, channels: current.channels.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));
  };

  const saveMappings = async () => {
    if (!selectedConn) return;
    try { await api.iec61850UpsertPointMappings(selectedConn, mappings, true); messageApi.success('点映射已保存'); }
    catch (error) { messageApi.error(`保存点映射失败: ${String(error)}`); }
  };

  const deleteModel = async (modelNameToDelete: string) => {
    try { await api.iec61850DeleteModel(modelNameToDelete); await refresh(); messageApi.success('SCL 模型已删除'); }
    catch (error) { messageApi.error(`删除模型失败: ${String(error)}`); }
  };

  const updateMapping = (record: Iec61850PointMapping, patch: Partial<Iec61850PointMapping>) => {
    setMappings((items) => items.map((item) => item === record ? { ...item, ...patch } : item));
  };

  const mappingColumns: ColumnsType<Iec61850PointMapping> = [
    { title: '上位机标签', dataIndex: 'tag', render: (value, record) => <Input value={value} onChange={(event) => updateMapping(record, { tag: event.target.value })} /> },
    { title: '数据引用', dataIndex: 'data_ref', render: (value, record) => <Input value={value} onChange={(event) => updateMapping(record, { data_ref: event.target.value })} /> },
    { title: '功能约束', dataIndex: 'fc', width: 140, render: (value, record) => <Select value={value} options={fcOptions} style={{ width: '100%' }} onChange={(next) => updateMapping(record, { fc: next })} /> },
    { title: '值类型', dataIndex: 'value_type', width: 120, render: (value, record) => <Select value={value} options={valueTypeOptions} style={{ width: '100%' }} onChange={(next) => updateMapping(record, { value_type: next })} /> },
    { title: '操作', width: 70, render: (_, record) => <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setMappings((items) => items.filter((item) => item !== record))} /> },
  ];

  return <div className="protocol-page iec61850-page">
    {contextHolder}
    <div className="iec61850-toolbar">
      <Space><Title level={4} style={{ margin: 0 }}>IEC 61850 接入</Title><Tag color="blue">SCL / MMS / GOOSE / SV</Tag></Space>
      <Space><Button icon={<ImportOutlined />} onClick={() => setModelModalOpen(true)}>导入 SCL 模型</Button><Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={openCreateIed}>新增 IED</Button></Space>
    </div>
    {modelMessage ? <Alert className="iec61850-model-message" type={modelMessageType} showIcon message={modelMessage} closable onClose={() => setModelMessage(null)} /> : null}
    <div className="iec61850-shell">
      <Card className="iec61850-list" title="IED 列表" extra={<Text type="secondary">{ieds.length} 个</Text>}>
        {ieds.length === 0 ? <div className="iec61850-empty iec61850-empty-action"><Text type="secondary">暂无 IED</Text><Button icon={<ImportOutlined />} onClick={() => setModelModalOpen(true)}>导入 SCL 模型</Button></div> : ieds.map((item) => {
          const name = item.config?.conn_name ?? `IED-${item.conn_id}`; const state = stateMap[item.state] ?? stateMap[0];
          return <button className={`iec61850-list-item${selectedConn === name ? ' selected' : ''}`} key={name} onClick={() => setSelectedConn(name)}><span>{name}</span><Tag color={state.color}>{state.label}</Tag></button>;
        })}
      </Card>
      <Card className="iec61850-detail" loading={loading && !selectedIed}>
        {!selectedIed ? <div className="iec61850-empty-content"><div className="iec61850-empty-action"><Text type="secondary">导入 SCL 模型后，再创建 IED 进行通信配置</Text><Space><Button type="primary" icon={<ImportOutlined />} onClick={() => setModelModalOpen(true)}>导入 SCL 模型</Button><Button icon={<PlusOutlined />} onClick={openCreateIed}>新增 IED</Button></Space></div><Card size="small" title={`已导入的 SCL 模型 (${models.length})`} className="iec61850-model-catalog"><Table rowKey="model_name" size="small" pagination={false} dataSource={models} locale={{ emptyText: '尚未导入 SCL 模型' }} columns={[{ title: '模型名称', dataIndex: 'model_name' }, { title: '来源文件', dataIndex: 'source_name' }, { title: '类型', dataIndex: 'document_kind', render: (value) => documentKindMap[value] ?? '未知' }, { title: 'IED 数', dataIndex: 'ied_count' }, { title: '逻辑节点', dataIndex: 'logical_node_count' }, { title: '数据属性', dataIndex: 'data_attribute_count' }, { title: '操作', width: 86, render: (_, model) => <Button type="text" danger icon={<DeleteOutlined />} onClick={() => void deleteModel(model.model_name)} /> }]} /></Card></div> : <>
          <div className="iec61850-detail-header"><div><Title level={4} style={{ margin: 0 }}>{config.conn_name}</Title><Text type="secondary">{config.ied_name} · {config.model_name}</Text></div><Space><Tag color={stateMap[selectedIed.state]?.color}>{stateMap[selectedIed.state]?.label}</Tag><Button icon={selectedIed.state === 3 ? <StopOutlined /> : <PlayCircleOutlined />} onClick={() => void toggleRuntime()}>{selectedIed.state === 3 ? '停止' : '启动'}</Button><Button danger icon={<DeleteOutlined />} onClick={() => void deleteSelected()}>删除</Button></Space></div>
          <Tabs items={[{
            key: 'config', label: '通信配置', children: <div className="iec61850-config-grid"><Card size="small" title="IED 基本信息"><Space direction="vertical" style={{ width: '100%' }}><Input addonBefore="连接名" value={config.conn_name} onChange={(e) => setConfig({ ...config, conn_name: e.target.value })} /><Input addonBefore="模型" value={config.model_name} disabled /><Select aria-label="IED 名称" value={config.ied_name || undefined} placeholder="选择 IED 名称" options={(models.find((model) => model.model_name === config.model_name)?.ieds ?? []).map((item) => ({ value: item.name, label: item.name }))} onChange={(value) => { const accessPoints = (models.find((model) => model.model_name === config.model_name)?.ieds ?? []).find((item) => item.name === value)?.access_points ?? []; const serverAccessPoints = accessPoints.filter((item) => item.has_server); setConfig({ ...config, ied_name: value, access_point: serverAccessPoints.length === 1 ? serverAccessPoints[0].name : '' }); }} /><Select aria-label="访问点" value={config.access_point || undefined} placeholder="选择访问点" options={((models.find((model) => model.model_name === config.model_name)?.ieds ?? []).find((item) => item.name === config.ied_name)?.access_points ?? []).map((item) => ({ value: item.name, label: item.has_server ? item.name : `${item.name}（无 Server）`, disabled: !item.has_server }))} onChange={(value) => setConfig({ ...config, access_point: value })} /><Divider style={{ margin: '8px 0' }} /><Space> <Text>MMS</Text><Switch checked={config.enable_mms} onChange={(value) => setConfig({ ...config, enable_mms: value })} /><Text>GOOSE</Text><Switch checked={config.enable_goose} onChange={(value) => setConfig({ ...config, enable_goose: value })} /><Text>SV</Text><Switch checked={config.enable_sv} onChange={(value) => setConfig({ ...config, enable_sv: value })} /></Space><Button type="primary" icon={<SaveOutlined />} onClick={() => void saveConfig()}>保存配置</Button></Space></Card><Card size="small" title="A/B 网络通道">{config.channels.map((channel, index) => <div className="iec61850-channel" key={channel.channel}><Space align="start"><Tag color={channel.channel === 1 ? 'blue' : 'cyan'}>{channel.channel === 1 ? 'A' : 'B'}</Tag><Switch checked={channel.enabled} onChange={(value) => updateChannel(index, { enabled: value })} /></Space><Input placeholder="网卡接口" value={channel.interface_name} onChange={(e) => updateChannel(index, { interface_name: e.target.value })} /><Input placeholder="本地 IP" value={channel.local_ip} onChange={(e) => updateChannel(index, { local_ip: e.target.value })} /><Input placeholder="对端 IP" value={channel.remote_ip} onChange={(e) => updateChannel(index, { remote_ip: e.target.value })} /><InputNumber min={1} max={65535} placeholder="MMS 端口" value={channel.remote_port} onChange={(value) => updateChannel(index, { remote_port: value ?? 102 })} /></div>)}<Alert type="info" showIcon message="启用双网时，下位机会按 A/B 通道状态选择活动链路。" /></Card></div>,
          }, {
            key: 'models', label: 'SCL 模型', children: <Card size="small" title="模型导入" extra={<Button icon={<ImportOutlined />} onClick={() => setModelModalOpen(true)}>导入 SCL</Button>}><Table rowKey="model_name" size="small" pagination={false} dataSource={models} columns={[{ title: '模型', dataIndex: 'model_name' }, { title: '来源', dataIndex: 'source_name' }, { title: '类型', dataIndex: 'document_kind', render: (value) => documentKindMap[value] ?? '未知' }, { title: 'IED', dataIndex: 'ied_count' }, { title: '逻辑节点', dataIndex: 'logical_node_count' }, { title: '数据属性', dataIndex: 'data_attribute_count' }, { title: '校验摘要', dataIndex: 'source_checksum', ellipsis: true }, { title: '操作', width: 70, render: (_, model) => <Button type="text" danger icon={<DeleteOutlined />} onClick={() => void deleteModel(model.model_name)} /> }]} /></Card>,
          }, {
            key: 'mappings', label: `点映射 (${mappings.length})`, children: <Card size="small" title="DataCenter 标签映射" extra={<Space><Button icon={<PlusOutlined />} onClick={() => setMappings((items) => [...items, { tag: `点${items.length + 1}`, data_ref: '', fc: 2, source: 1, value_type: 3, scale: 1, offset: 0, deadband: 0 }])}>新增点</Button><Button type="primary" icon={<SaveOutlined />} onClick={() => void saveMappings()}>保存映射</Button></Space>}><Table rowKey={(record) => `${record.tag}-${record.data_ref}`} size="small" pagination={false} dataSource={mappings} columns={mappingColumns} /></Card>,
          }, {
            key: 'runtime', label: '运行状态', children: <><Card size="small" title="通信状态"><Descriptions column={3} size="small"><Descriptions.Item label="IED 状态"><Tag color={stateMap[selectedIed.state]?.color}>{stateMap[selectedIed.state]?.label}</Tag></Descriptions.Item><Descriptions.Item label="活动通道">{selectedIed.active_channel === 1 ? 'A' : selectedIed.active_channel === 2 ? 'B' : '无'}</Descriptions.Item><Descriptions.Item label="DataCenter">{selectedIed.data_center_available ? <Tag color="success">可用</Tag> : <Tag color="warning">降级</Tag>}</Descriptions.Item>{selectedIed.channels.map((channel) => <Descriptions.Item key={channel.config?.channel} label={`${channel.config?.channel === 1 ? 'A' : 'B'} 通道`}>{channelStateMap[channel.state] ?? '未知'}{channel.last_error ? `：${channel.last_error}` : ''}</Descriptions.Item>)}</Descriptions></Card><Card size="small" title="运行统计" style={{ marginTop: 12 }} extra={<Button icon={<ReloadOutlined />} onClick={() => selectedConn && void loadSelected(selectedConn)}>刷新统计</Button>}>{stats ? <div className="iec61850-stat-grid">{[['MMS 报告', stats.mms_reports_received], ['丢弃事件', stats.mms_events_dropped], ['GOOSE 接收', stats.goose_frames_received], ['GOOSE 超时', stats.goose_timeouts], ['SV 接收', stats.sv_frames_received], ['重连次数', stats.reconnect_count], ['发布批次', stats.data_center_batches_published], ['未映射值', stats.mms_values_unmapped]].map(([label, value]) => <div key={label as string}><Text type="secondary">{label}</Text><strong>{formatNumber(value as number)}</strong></div>)}</div> : <Text type="secondary">暂无统计数据</Text>}</Card></>,
          }]} />
        </>}
      </Card>
    </div>
    <Modal title="导入 SCL 模型" open={modelModalOpen} onCancel={() => setModelModalOpen(false)} onOk={() => void importScl(false)} okText="导入" cancelText="取消"><Space direction="vertical" style={{ width: '100%' }}><Input placeholder="模型名称（可选，默认使用文件名）" value={modelName} onChange={(e) => setModelName(e.target.value)} /><Input placeholder="来源名称（可选）" value={sourceName} onChange={(e) => setSourceName(e.target.value)} /><input ref={fileRef} type="file" accept=".scd,.cid,.icd,.xml" /><Button onClick={() => void importScl(true)}>仅校验文件</Button></Space></Modal>
    <Modal title={editingConn ? '编辑 IED' : '新增 IED'} open={iedModalOpen} onCancel={() => setIedModalOpen(false)} footer={null}><Form form={iedForm} initialValues={config} onFinish={(values) => void saveIed({ ...config, ...values })} layout="vertical"><Alert type="info" showIcon message="先保存模型关联信息；网卡、IP、MMS/GOOSE/SV 开关请在保存后到“通信配置”中设置。" style={{ marginBottom: 16 }} /><Form.Item label="连接名" name="conn_name" rules={[{ required: true, message: '请输入连接名' }]}><Input /></Form.Item><Form.Item label="模型" name="model_name" rules={[{ required: true, message: '请选择模型' }]}><Select options={models.map((model) => ({ value: model.model_name, label: model.model_name }))} onChange={chooseModelForIedForm} /></Form.Item><Form.Item label="IED 名称" name="ied_name" rules={[{ required: true, message: '请选择 IED 名称' }]}><Select placeholder="选择 SCL 中的 IED" options={selectedModelIeds.map((item) => ({ value: item.name, label: item.name }))} onChange={chooseIedForForm} /></Form.Item><Form.Item label="访问点" name="access_point" rules={[{ required: true, message: '请选择访问点' }]}><Select placeholder="选择 SCL 中的 AccessPoint" options={selectedIedAccessPoints.map((item) => ({ value: item.name, label: item.has_server ? item.name : `${item.name}（无 Server）`, disabled: !item.has_server }))} notFoundContent="当前 IED 没有可用 AccessPoint" /></Form.Item><Form.Item label="启用功能"><Space><Form.Item name="enable_mms" valuePropName="checked" noStyle><Switch checkedChildren="MMS" unCheckedChildren="MMS" disabled={!editingConn} /></Form.Item><Form.Item name="enable_goose" valuePropName="checked" noStyle><Switch checkedChildren="GOOSE" unCheckedChildren="GOOSE" disabled={!editingConn} /></Form.Item><Form.Item name="enable_sv" valuePropName="checked" noStyle><Switch checkedChildren="SV" unCheckedChildren="SV" disabled={!editingConn} /></Form.Item></Space></Form.Item><Form.Item label="自动启动" name="auto_start" valuePropName="checked"><Switch disabled={!editingConn} /></Form.Item><Button type="primary" htmlType="submit" block>保存 IED</Button></Form></Modal>
  </div>;
};

export default IEC61850Page;
