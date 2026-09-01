import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../../adapters';
import type {
  ControlOrchestratorCommandStep,
  ControlOrchestratorExecuteRequest,
  ControlOrchestratorStepVerification,
  ControlOrchestratorWorkflowConfig,
  DcConnectionInfo,
  DcEndpoint,
  DcPointValue,
} from '../../adapters';
import './index.css';

const { Text } = Typography;

type StepDraft = {
  step_name: string;
  module_name: string;
  conn_name: string;
  tag: string;
  value_type: 'Bool' | 'Int' | 'Double' | 'String';
  value: string;
  use_trigger_value: boolean;
  timeout_ms: number;
  delay_after_ms: number;
  verification_enabled: boolean;
  status_module_name: string;
  status_conn_name: string;
  status_tag: string;
  expected_state: boolean;
  wait_timeout_ms: number;
  poll_interval_ms: number;
  failure_action: 'STOP' | 'RETRY_COMMAND';
  max_retries: number;
  retry_interval_ms: number;
};

type WorkflowDraft = {
  sequence_name: string;
  trigger_module_name: string;
  trigger_conn_name: string;
  trigger_tag: string;
  steps: StepDraft[];
};

const emptyStep = (): StepDraft => ({
  step_name: '', module_name: '', conn_name: '', tag: '', value_type: 'Double', value: '0',
  use_trigger_value: false, timeout_ms: 3000, delay_after_ms: 0,
  verification_enabled: false, status_module_name: '', status_conn_name: '', status_tag: '',
  expected_state: true, wait_timeout_ms: 3000, poll_interval_ms: 200, failure_action: 'STOP',
  max_retries: 1, retry_interval_ms: 200,
});

const emptyDraft = (): WorkflowDraft => ({
  sequence_name: '', trigger_module_name: '', trigger_conn_name: '', trigger_tag: '', steps: [emptyStep()],
});

function parseValue(step: StepDraft): DcPointValue | null {
  if (step.use_trigger_value) return null;
  if (step.value_type === 'Bool') return { type: 'Bool', value: step.value === 'true' || step.value === '1' };
  if (step.value_type === 'Int') return { type: 'Int', value: Number.parseInt(step.value, 10) || 0 };
  if (step.value_type === 'Double') return { type: 'Double', value: Number.parseFloat(step.value) || 0 };
  return { type: 'String', value: step.value };
}

function draftFromConfig(config: ControlOrchestratorWorkflowConfig): WorkflowDraft {
  return {
    sequence_name: config.sequence_name,
    steps: config.steps.map((step) => {
      const value = step.value;
      const type = value?.type === 'Bool' || value?.type === 'Int' || value?.type === 'Double' || value?.type === 'String'
        ? value.type : 'Double';
      const raw = value ? String(value.value) : '0';
      return {
        step_name: step.step_name,
        module_name: step.source.module_name,
        conn_name: step.source.conn_name,
        tag: step.source.tag,
        value_type: type,
        value: raw,
        use_trigger_value: step.use_trigger_value,
        timeout_ms: step.timeout_ms || 3000,
        delay_after_ms: step.delay_after_ms,
        verification_enabled: Boolean(step.verification),
        status_module_name: step.verification?.status_source.module_name ?? '',
        status_conn_name: step.verification?.status_source.conn_name ?? '',
        status_tag: step.verification?.status_source.tag ?? '',
        expected_state: step.verification?.expected_value.type === 'Bool' ? step.verification.expected_value.value : true,
        wait_timeout_ms: step.verification?.wait_timeout_ms || 3000,
        poll_interval_ms: step.verification?.poll_interval_ms || 200,
        failure_action: step.verification?.failure_action ?? 'STOP',
        max_retries: step.verification?.max_retries ?? 1,
        retry_interval_ms: step.verification?.retry_interval_ms ?? 200,
      };
    }),
    trigger_module_name: config.trigger?.module_name ?? '',
    trigger_conn_name: config.trigger?.conn_name ?? '',
    trigger_tag: config.trigger?.tag ?? '',
  };
}

function configFromDraft(draft: WorkflowDraft): ControlOrchestratorWorkflowConfig {
  const trigger = draft.trigger_module_name.trim() && draft.trigger_conn_name.trim() && draft.trigger_tag.trim()
    ? { module_name: draft.trigger_module_name.trim(), conn_name: draft.trigger_conn_name.trim(), tag: draft.trigger_tag.trim() }
    : null;
  return {
    sequence_name: draft.sequence_name.trim(),
    trigger,
    steps: draft.steps.map<ControlOrchestratorCommandStep>((step) => ({
      step_name: step.step_name.trim(),
      source: { module_name: step.module_name.trim(), conn_name: step.conn_name.trim(), tag: step.tag.trim() },
      value: parseValue(step),
      use_trigger_value: step.use_trigger_value,
      timeout_ms: Math.max(1, step.timeout_ms || 1),
      delay_after_ms: Math.max(0, step.delay_after_ms || 0),
      verification: step.verification_enabled
        ? ({
            status_source: {
              module_name: step.status_module_name.trim(),
              conn_name: step.status_conn_name.trim(),
              tag: step.status_tag.trim(),
            },
            expected_value: { type: 'Bool', value: step.expected_state },
            wait_timeout_ms: Math.max(1, step.wait_timeout_ms || 1),
            poll_interval_ms: Math.max(1, step.poll_interval_ms || 1),
            failure_action: step.failure_action,
            max_retries: Math.max(0, step.max_retries || 0),
            retry_interval_ms: Math.max(0, step.retry_interval_ms || 0),
          } satisfies ControlOrchestratorStepVerification)
        : null,
    })),
  };
}

const endpointKey = (endpoint: DcEndpoint) => `${endpoint.module_name}\u0000${endpoint.conn_name}\u0000${endpoint.tag}`;
const orchestratorConnection = { module_name: 'ControlOrchestrator', conn_name: 'control-orchestrator' };

async function syncBinding(previous: ControlOrchestratorWorkflowConfig | null, next: ControlOrchestratorWorkflowConfig) {
  if (!previous?.trigger && !next.trigger) return;
  const routeTag = `trigger:${next.sequence_name}`;
  const routes = await api.dcListRoutes(0, '', 0, '');
  const previousKey = previous?.trigger ? endpointKey(previous.trigger) : null;
  const previousRouteTag = previous ? `trigger:${previous.sequence_name}` : null;
  const trigger = next.trigger;
  const conflict = trigger
    ? routes.find((route) => route.dst.module_name === orchestratorConnection.module_name
      && route.dst.conn_name === orchestratorConnection.conn_name
      && endpointKey(route.src) === endpointKey(trigger)
      && route.dst.tag !== routeTag)
    : undefined;
  if (conflict) throw new Error('该触发源点已绑定其他编排，请先解除原绑定');
  const connection = await api.dcGetOrCreateConnection(orchestratorConnection.module_name, orchestratorConnection.conn_name);
  const activeConfigs = await api.controlOrchestratorListSequences();
  const activeRouteTags = activeConfigs
    .filter((config) => config.trigger)
    .map((config) => `trigger:${config.sequence_name}`);
  if (next.trigger && !activeRouteTags.includes(routeTag)) activeRouteTags.push(routeTag);
  await api.dcUpsertConnTags(connection.conn_id, activeRouteTags, true);
  const staleRoutes = routes.filter((route) => {
    if (route.dst.module_name !== orchestratorConnection.module_name || route.dst.conn_name !== orchestratorConnection.conn_name) return false;
    return route.dst.tag === routeTag || (previousKey !== null && route.dst.tag === previousRouteTag
      && endpointKey(route.src) === previousKey);
  });
  if (staleRoutes.length > 0) await api.dcDeleteRoutes(staleRoutes);
  if (next.trigger) {
    await api.dcUpsertRoutes([{ src: next.trigger, dst: {
      module_name: orchestratorConnection.module_name,
      conn_name: orchestratorConnection.conn_name,
      tag: routeTag,
      conn_id: connection.conn_id,
    } }], false);
  }
}

const ControlOrchestratorPage: React.FC = () => {
  const [configs, setConfigs] = useState<ControlOrchestratorWorkflowConfig[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowDraft>(emptyDraft);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [executeModalOpen, setExecuteModalOpen] = useState(false);
  const [executeValueType, setExecuteValueType] = useState<'Bool' | 'Int' | 'Double' | 'String'>('Double');
  const [executeValue, setExecuteValue] = useState('0');
  const [messageApi, contextHolder] = message.useMessage();
  const [connections, setConnections] = useState<DcConnectionInfo[]>([]);
  const [connectionTags, setConnectionTags] = useState<Map<number, string[]>>(new Map());
  const [endpointLoading, setEndpointLoading] = useState(false);

  const selected = useMemo(() => configs.find((config) => config.sequence_name === selectedName) ?? null, [configs, selectedName]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.controlOrchestratorListSequences();
      setConfigs(next);
      setSelectedName((current) => current && next.some((item) => item.sequence_name === current) ? current : next[0]?.sequence_name ?? null);
    } catch (error) {
      messageApi.error(`加载编排失败：${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => { void refresh(); }, [refresh]);

  const refreshEndpointOptions = useCallback(async () => {
    setEndpointLoading(true);
    try {
      const nextConnections = await api.dcListConnections();
      const tagEntries = await Promise.all(nextConnections.map(async (connection) => {
        try {
          return [connection.conn_id, (await api.dcGetConnTags(connection.conn_id)).tags] as [number, string[]];
        } catch {
          return [connection.conn_id, []] as [number, string[]];
        }
      }));
      setConnections(nextConnections);
      setConnectionTags(new Map(tagEntries));
    } catch (error) {
      setConnections([]);
      setConnectionTags(new Map());
      messageApi.error(`加载 DataCenter 连接和点名失败：${String(error)}`);
    } finally {
      setEndpointLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    if (modalOpen) void refreshEndpointOptions();
  }, [modalOpen, refreshEndpointOptions]);

  const moduleOptions = useMemo(() => {
    const names = new Set(connections.map((connection) => connection.module_name));
    [draft.trigger_module_name, ...draft.steps.flatMap((step) => [step.module_name, step.status_module_name])]
      .map((name) => name.trim())
      .filter(Boolean)
      .forEach((name) => names.add(name));
    return [...names]
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
      .map((value) => ({ value, label: value }));
  }, [connections, draft]);

  const connectionOptions = useCallback((moduleName: string, currentConnName: string) => {
    const options = connections
      .filter((connection) => connection.module_name === moduleName)
      .map((connection) => ({ value: connection.conn_name, label: connection.conn_name }));
    if (currentConnName && !options.some((option) => option.value === currentConnName)) {
      options.unshift({ value: currentConnName, label: `${currentConnName}（当前配置）` });
    }
    return options;
  }, [connections]);

  const tagOptions = useCallback((moduleName: string, connName: string, currentTag: string) => {
    const connection = connections.find((item) => item.module_name === moduleName && item.conn_name === connName);
    const tags = connection ? connectionTags.get(connection.conn_id) ?? [] : [];
    const options = tags.map((tag) => ({ value: tag, label: tag }));
    if (currentTag && !options.some((option) => option.value === currentTag)) {
      options.unshift({ value: currentTag, label: `${currentTag}（当前配置）` });
    }
    return options;
  }, [connectionTags, connections]);

  const updateStep = useCallback((index: number, patch: Partial<StepDraft>) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step),
    }));
  }, []);

  const openCreate = () => { setEditing(false); setDraft(emptyDraft()); setModalOpen(true); };
  const openEdit = () => { if (selected) { setEditing(true); setDraft(draftFromConfig(selected)); setModalOpen(true); } };

  const save = async () => {
    const config = configFromDraft(draft);
    const triggerParts = [draft.trigger_module_name, draft.trigger_conn_name, draft.trigger_tag]
      .map((value) => value.trim());
    const hasTriggerPart = triggerParts.some(Boolean);
    const hasCompleteTrigger = triggerParts.every(Boolean);
    if (!config.sequence_name) { messageApi.warning('请输入编排名称'); return; }
    if (editing && selected && config.sequence_name !== selected.sequence_name) {
      messageApi.warning('编辑时不能修改编排名称，请新建后删除旧编排'); return;
    }
    if (config.steps.length < 1 || config.steps.length > 8) { messageApi.warning('步骤数量需为 1 到 8'); return; }
    if (config.steps.some((step) => !step.step_name || !step.source.module_name || !step.source.conn_name || !step.source.tag)) {
      messageApi.warning('请填写步骤名称并选择完整的命令源端点');
      return;
    }
    if (hasTriggerPart && !hasCompleteTrigger) {
      messageApi.warning('请选择完整的触发源点，或全部留空表示仅手工执行'); return;
    }
    if (config.steps.some((step) => step.verification && (!step.verification.status_source.module_name
      || !step.verification.status_source.conn_name || !step.verification.status_source.tag))) {
      messageApi.warning('请选择完整的遥信状态端点'); return;
    }

    const endpoints: Array<{ label: string; endpoint: DcEndpoint }> = [];
    config.steps.forEach((step, index) => {
      endpoints.push({ label: `步骤 ${index + 1} 命令源`, endpoint: step.source });
      if (step.verification) endpoints.push({ label: `步骤 ${index + 1} 遥信状态`, endpoint: step.verification.status_source });
    });
    if (config.trigger) endpoints.push({ label: '触发源', endpoint: config.trigger });
    for (const { label, endpoint } of endpoints) {
      const sourceConnection = connections.find((connection) => connection.module_name === endpoint.module_name
        && connection.conn_name === endpoint.conn_name);
      if (!sourceConnection) {
        messageApi.warning(`${label}连接尚未在 DataCenter 注册：${endpoint.module_name}/${endpoint.conn_name}`); return;
      }
      const tags = connectionTags.get(sourceConnection.conn_id) ?? [];
      if (!tags.includes(endpoint.tag)) {
        messageApi.warning(`${label}点名尚未在 DataCenter 注册：${endpoint.module_name}/${endpoint.conn_name}/${endpoint.tag}`); return;
      }
      endpoint.conn_id = sourceConnection.conn_id;
    }
    try {
      const previous = editing ? selected : null;
      await api.controlOrchestratorUpsertSequence(config, !editing);
      try {
        await syncBinding(previous, config);
      } catch (error) {
        messageApi.error(`编排已保存，但触发路由同步失败：${String(error)}`);
        await refresh();
        return;
      }
      messageApi.success('编排已保存');
      setModalOpen(false);
      await refresh();
      setSelectedName(config.sequence_name);
    } catch (error) { messageApi.error(`保存失败：${String(error)}`); }
  };

  const remove = async () => {
    if (!selected) return;
    try {
      await api.controlOrchestratorDeleteSequence(selected.sequence_name);
      try {
        await syncBinding(selected, { ...selected, trigger: null });
      } catch (error) {
        messageApi.error(`编排已删除，但触发路由清理失败：${String(error)}`);
        await refresh();
        return;
      }
      messageApi.success('编排已删除'); await refresh();
    }
    catch (error) { messageApi.error(`删除失败：${String(error)}`); }
  };

  const executeNow = async (triggerValue?: DcPointValue) => {
    if (!selected) return;
    try {
      const request: ControlOrchestratorExecuteRequest = {
        sequence_name: selected.sequence_name,
        trigger_value: triggerValue,
        request_id: `upper-${Date.now()}`,
      };
      const result = await api.controlOrchestratorExecuteSequence(request);
      if (result.accepted) messageApi.success(`执行完成，共 ${result.executed_steps} 步`);
      else messageApi.error(result.reason || '执行失败');
    } catch (error) { messageApi.error(`执行失败：${String(error)}`); }
  };

  const execute = () => {
    if (!selected) return;
    if (selected.steps.some((step) => step.use_trigger_value)) {
      setExecuteModalOpen(true);
      return;
    }
    void executeNow();
  };

  const confirmExecute = () => {
    let value: DcPointValue;
    if (executeValueType === 'Bool') value = { type: 'Bool', value: executeValue === 'true' || executeValue === '1' };
    else if (executeValueType === 'Int') value = { type: 'Int', value: Number.parseInt(executeValue, 10) || 0 };
    else if (executeValueType === 'Double') value = { type: 'Double', value: Number.parseFloat(executeValue) || 0 };
    else value = { type: 'String', value: executeValue };
    setExecuteModalOpen(false);
    void executeNow(value);
  };

  const columns: ColumnsType<ControlOrchestratorWorkflowConfig> = [
    { title: '编排名称', dataIndex: 'sequence_name', render: (value: string) => <Text strong>{value}</Text> },
    { title: '步骤数', render: (_, record) => <Tag>{record.steps.length}</Tag> },
    { title: '步骤摘要', render: (_, record) => record.steps.map((step) => step.step_name).join(' -> ') },
  ];

  return <div className="orchestrator-page">
    {contextHolder}
    <Card className="orchestrator-toolbar" size="small">
      <Space wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建编排</Button>
        <Button icon={<EditOutlined />} disabled={!selected} onClick={openEdit}>编辑</Button>
        <Popconfirm title="确认删除当前编排？" onConfirm={remove} disabled={!selected}>
          <Button danger icon={<DeleteOutlined />} disabled={!selected}>删除</Button>
        </Popconfirm>
        <Button icon={<PlayCircleOutlined />} disabled={!selected} onClick={execute}>执行</Button>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>刷新</Button>
      </Space>
    </Card>
    <Card className="orchestrator-list" size="small" title="控制编排">
      <Table rowKey="sequence_name" size="small" loading={loading} dataSource={configs} columns={columns}
        rowClassName={(record) => record.sequence_name === selectedName ? 'orchestrator-selected-row' : ''}
        onRow={(record) => ({ onClick: () => setSelectedName(record.sequence_name) })} pagination={false} />
      {selected ? <div className="orchestrator-detail"><Text type="secondary">当前步骤：</Text>{selected.steps.map((step, index) => <Tag key={`${step.step_name}-${index}`}>{index + 1}. {step.step_name} · {step.source.module_name}/{step.source.conn_name}/{step.source.tag}</Tag>)}</div> : <div className="orchestrator-empty">请选择或新建一个编排</div>}
    </Card>
    <Modal title={editing ? '编辑编排' : '新建编排'} open={modalOpen} onCancel={() => setModalOpen(false)} onOk={() => void save()} confirmLoading={endpointLoading} width={860} okText="保存">
      <Form layout="vertical">
        <Form.Item label="编排名称" required><Input value={draft.sequence_name} onChange={(event) => setDraft({ ...draft, sequence_name: event.target.value })} placeholder="例如 inverter-remote-adjust" /></Form.Item>
        <Card size="small" title="触发源点（可选）">
          <div className="orchestrator-step-grid">
            <Form.Item label="触发模块">
              <Select allowClear showSearch optionFilterProp="label" loading={endpointLoading}
                value={draft.trigger_module_name || undefined} options={moduleOptions}
                placeholder="选择模块"
                onChange={(value) => setDraft((current) => ({ ...current, trigger_module_name: value ?? '', trigger_conn_name: '', trigger_tag: '' }))} />
            </Form.Item>
            <Form.Item label="触发连接">
              <Select allowClear showSearch optionFilterProp="label" loading={endpointLoading}
                disabled={!draft.trigger_module_name} value={draft.trigger_conn_name || undefined}
                options={connectionOptions(draft.trigger_module_name, draft.trigger_conn_name)} placeholder="选择连接"
                onChange={(value) => setDraft((current) => ({ ...current, trigger_conn_name: value ?? '', trigger_tag: '' }))} />
            </Form.Item>
            <Form.Item label="触发点名">
              <Select allowClear showSearch optionFilterProp="label" loading={endpointLoading}
                disabled={!draft.trigger_module_name || !draft.trigger_conn_name} value={draft.trigger_tag || undefined}
                options={tagOptions(draft.trigger_module_name, draft.trigger_conn_name, draft.trigger_tag)}
                placeholder="选择点名" notFoundContent="暂无已注册点名"
                onChange={(value) => setDraft((current) => ({ ...current, trigger_tag: value ?? '' }))} />
            </Form.Item>
          </div>
          <Text type="secondary">选择后，来自该源点的同步控制会自动进入本编排；全部留空时仅支持手工执行。</Text>
        </Card>
        {draft.steps.map((step, index) => <Card key={index} size="small" title={`步骤 ${index + 1}`} extra={<Button type="text" danger icon={<DeleteOutlined />} disabled={draft.steps.length <= 1} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, itemIndex) => itemIndex !== index) })} />}>
          <div className="orchestrator-step-grid">
            <Form.Item label="步骤名" required><Input value={step.step_name} onChange={(event) => { const steps = [...draft.steps]; steps[index] = { ...step, step_name: event.target.value }; setDraft({ ...draft, steps }); }} /></Form.Item>
            <Form.Item label="源模块" required>
              <Select allowClear showSearch optionFilterProp="label" loading={endpointLoading}
                value={step.module_name || undefined} options={moduleOptions} placeholder="选择模块"
                onChange={(value) => updateStep(index, { module_name: value ?? '', conn_name: '', tag: '' })} />
            </Form.Item>
            <Form.Item label="源连接" required>
              <Select allowClear showSearch optionFilterProp="label" loading={endpointLoading}
                disabled={!step.module_name} value={step.conn_name || undefined}
                options={connectionOptions(step.module_name, step.conn_name)} placeholder="选择连接"
                onChange={(value) => updateStep(index, { conn_name: value ?? '', tag: '' })} />
            </Form.Item>
            <Form.Item label="源点名" required>
              <Select allowClear showSearch optionFilterProp="label" loading={endpointLoading}
                disabled={!step.module_name || !step.conn_name} value={step.tag || undefined}
                options={tagOptions(step.module_name, step.conn_name, step.tag)} placeholder="选择点名"
                notFoundContent="暂无已注册点名" onChange={(value) => updateStep(index, { tag: value ?? '' })} />
            </Form.Item>
            <Form.Item label="固定值类型"><Select value={step.value_type} options={['Bool', 'Int', 'Double', 'String'].map((value) => ({ value, label: value }))} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, value_type: value }; setDraft({ ...draft, steps }); }} /></Form.Item>
            <Form.Item label="值"><Input disabled={step.use_trigger_value} value={step.value} onChange={(event) => { const steps = [...draft.steps]; steps[index] = { ...step, value: event.target.value }; setDraft({ ...draft, steps }); }} /></Form.Item>
            <Form.Item label="超时(ms)"><InputNumber min={1} value={step.timeout_ms} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, timeout_ms: value ?? 1 }; setDraft({ ...draft, steps }); }} /></Form.Item>
            <Form.Item label="步骤间延时(ms)"><InputNumber min={0} value={step.delay_after_ms} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, delay_after_ms: value ?? 0 }; setDraft({ ...draft, steps }); }} /></Form.Item>
          </div>
          <Space size={8}><Switch checked={step.use_trigger_value} onChange={(checked) => { const steps = [...draft.steps]; steps[index] = { ...step, use_trigger_value: checked }; setDraft({ ...draft, steps }); }} /><Text>使用执行触发值</Text></Space>
          <div style={{ marginTop: 12 }}>
            <Space size={8}><Switch checked={step.verification_enabled} onChange={(checked) => { const steps = [...draft.steps]; steps[index] = { ...step, verification_enabled: checked }; setDraft({ ...draft, steps }); }} /><Text>命令后检查遥信状态</Text></Space>
            {step.verification_enabled && <div className="orchestrator-step-grid" style={{ marginTop: 8 }}>
              <Form.Item label="遥信模块" required>
                <Select allowClear showSearch optionFilterProp="label" loading={endpointLoading}
                  value={step.status_module_name || undefined} options={moduleOptions} placeholder="选择模块"
                  onChange={(value) => updateStep(index, { status_module_name: value ?? '', status_conn_name: '', status_tag: '' })} />
              </Form.Item>
              <Form.Item label="遥信连接" required>
                <Select allowClear showSearch optionFilterProp="label" loading={endpointLoading}
                  disabled={!step.status_module_name} value={step.status_conn_name || undefined}
                  options={connectionOptions(step.status_module_name, step.status_conn_name)} placeholder="选择连接"
                  onChange={(value) => updateStep(index, { status_conn_name: value ?? '', status_tag: '' })} />
              </Form.Item>
              <Form.Item label="遥信点名" required>
                <Select allowClear showSearch optionFilterProp="label" loading={endpointLoading}
                  disabled={!step.status_module_name || !step.status_conn_name} value={step.status_tag || undefined}
                  options={tagOptions(step.status_module_name, step.status_conn_name, step.status_tag)} placeholder="选择点名"
                  notFoundContent="暂无已注册点名" onChange={(value) => updateStep(index, { status_tag: value ?? '' })} />
              </Form.Item>
              <Form.Item label="期望状态"><Select value={step.expected_state} options={[{ value: true, label: '合/在线（true）' }, { value: false, label: '分/离线（false）' }]} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, expected_state: value }; setDraft({ ...draft, steps }); }} /></Form.Item>
              <Form.Item label="等待超时(ms)"><InputNumber min={1} value={step.wait_timeout_ms} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, wait_timeout_ms: value ?? 1 }; setDraft({ ...draft, steps }); }} /></Form.Item>
              <Form.Item label="轮询间隔(ms)"><InputNumber min={1} value={step.poll_interval_ms} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, poll_interval_ms: value ?? 1 }; setDraft({ ...draft, steps }); }} /></Form.Item>
              <Form.Item label="检查失败策略"><Select value={step.failure_action} options={[{ value: 'STOP', label: '停止，不下发后续命令' }, { value: 'RETRY_COMMAND', label: '重新下发本步骤命令' }]} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, failure_action: value }; setDraft({ ...draft, steps }); }} /></Form.Item>
              <Form.Item label="最大重试次数"><InputNumber min={0} value={step.max_retries} disabled={step.failure_action !== 'RETRY_COMMAND'} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, max_retries: value ?? 0 }; setDraft({ ...draft, steps }); }} /></Form.Item>
              <Form.Item label="重试间隔(ms)"><InputNumber min={0} value={step.retry_interval_ms} disabled={step.failure_action !== 'RETRY_COMMAND'} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, retry_interval_ms: value ?? 0 }; setDraft({ ...draft, steps }); }} /></Form.Item>
            </div>}
          </div>
        </Card>)}
        <Button block icon={<PlusOutlined />} onClick={() => setDraft({ ...draft, steps: [...draft.steps, emptyStep()] })} disabled={draft.steps.length >= 8}>添加步骤</Button>
      </Form>
    </Modal>
    <Modal title="输入执行触发值" open={executeModalOpen} onCancel={() => setExecuteModalOpen(false)} onOk={confirmExecute} okText="执行">
      <Form layout="vertical">
        <Form.Item label="触发值类型" required>
          <Select value={executeValueType} options={['Bool', 'Int', 'Double', 'String'].map((value) => ({ value, label: value }))} onChange={(value) => setExecuteValueType(value as typeof executeValueType)} />
        </Form.Item>
        <Form.Item label="触发值" required>
          <Input value={executeValue} onChange={(event) => setExecuteValue(event.target.value)} placeholder="供使用执行触发值的步骤复用" />
        </Form.Item>
      </Form>
    </Modal>
  </div>;
};

export default ControlOrchestratorPage;
