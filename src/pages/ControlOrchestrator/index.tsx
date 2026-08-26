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
  ControlOrchestratorWorkflowConfig,
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
};

type WorkflowDraft = { sequence_name: string; steps: StepDraft[] };

const emptyStep = (): StepDraft => ({
  step_name: '', module_name: '', conn_name: '', tag: '', value_type: 'Double', value: '0',
  use_trigger_value: false, timeout_ms: 3000, delay_after_ms: 0,
});

const emptyDraft = (): WorkflowDraft => ({ sequence_name: '', steps: [emptyStep()] });

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
      };
    }),
  };
}

function configFromDraft(draft: WorkflowDraft): ControlOrchestratorWorkflowConfig {
  return {
    sequence_name: draft.sequence_name.trim(),
    steps: draft.steps.map<ControlOrchestratorCommandStep>((step) => ({
      step_name: step.step_name.trim(),
      source: { module_name: step.module_name.trim(), conn_name: step.conn_name.trim(), tag: step.tag.trim() },
      value: parseValue(step),
      use_trigger_value: step.use_trigger_value,
      timeout_ms: Math.max(1, step.timeout_ms || 1),
      delay_after_ms: Math.max(0, step.delay_after_ms || 0),
    })),
  };
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

  const openCreate = () => { setEditing(false); setDraft(emptyDraft()); setModalOpen(true); };
  const openEdit = () => { if (selected) { setEditing(true); setDraft(draftFromConfig(selected)); setModalOpen(true); } };

  const save = async () => {
    const config = configFromDraft(draft);
    if (!config.sequence_name) { messageApi.warning('请输入编排名称'); return; }
    if (config.steps.length < 1 || config.steps.length > 8) { messageApi.warning('步骤数量需为 1 到 8'); return; }
    if (config.steps.some((step) => !step.step_name || !step.source.module_name || !step.source.conn_name || !step.source.tag)) {
      messageApi.warning('请完整填写步骤名称和命令源端点');
      return;
    }
    try {
      await api.controlOrchestratorUpsertSequence(config, !editing);
      messageApi.success('编排已保存');
      setModalOpen(false);
      await refresh();
      setSelectedName(config.sequence_name);
    } catch (error) { messageApi.error(`保存失败：${String(error)}`); }
  };

  const remove = async () => {
    if (!selected) return;
    try { await api.controlOrchestratorDeleteSequence(selected.sequence_name); messageApi.success('编排已删除'); await refresh(); }
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
    <Modal title={editing ? '编辑编排' : '新建编排'} open={modalOpen} onCancel={() => setModalOpen(false)} onOk={() => void save()} width={860} okText="保存">
      <Form layout="vertical">
        <Form.Item label="编排名称" required><Input value={draft.sequence_name} onChange={(event) => setDraft({ ...draft, sequence_name: event.target.value })} placeholder="例如 inverter-remote-adjust" /></Form.Item>
        {draft.steps.map((step, index) => <Card key={index} size="small" title={`步骤 ${index + 1}`} extra={<Button type="text" danger icon={<DeleteOutlined />} disabled={draft.steps.length <= 1} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, itemIndex) => itemIndex !== index) })} />}>
          <div className="orchestrator-step-grid">
            <Form.Item label="步骤名" required><Input value={step.step_name} onChange={(event) => { const steps = [...draft.steps]; steps[index] = { ...step, step_name: event.target.value }; setDraft({ ...draft, steps }); }} /></Form.Item>
            <Form.Item label="源模块" required><Input value={step.module_name} onChange={(event) => { const steps = [...draft.steps]; steps[index] = { ...step, module_name: event.target.value }; setDraft({ ...draft, steps }); }} /></Form.Item>
            <Form.Item label="源连接" required><Input value={step.conn_name} onChange={(event) => { const steps = [...draft.steps]; steps[index] = { ...step, conn_name: event.target.value }; setDraft({ ...draft, steps }); }} /></Form.Item>
            <Form.Item label="源点名" required><Input value={step.tag} onChange={(event) => { const steps = [...draft.steps]; steps[index] = { ...step, tag: event.target.value }; setDraft({ ...draft, steps }); }} /></Form.Item>
            <Form.Item label="固定值类型"><Select value={step.value_type} options={['Bool', 'Int', 'Double', 'String'].map((value) => ({ value, label: value }))} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, value_type: value }; setDraft({ ...draft, steps }); }} /></Form.Item>
            <Form.Item label="值"><Input disabled={step.use_trigger_value} value={step.value} onChange={(event) => { const steps = [...draft.steps]; steps[index] = { ...step, value: event.target.value }; setDraft({ ...draft, steps }); }} /></Form.Item>
            <Form.Item label="超时(ms)"><InputNumber min={1} value={step.timeout_ms} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, timeout_ms: value ?? 1 }; setDraft({ ...draft, steps }); }} /></Form.Item>
            <Form.Item label="步骤间延时(ms)"><InputNumber min={0} value={step.delay_after_ms} onChange={(value) => { const steps = [...draft.steps]; steps[index] = { ...step, delay_after_ms: value ?? 0 }; setDraft({ ...draft, steps }); }} /></Form.Item>
          </div>
          <Space size={8}><Switch checked={step.use_trigger_value} onChange={(checked) => { const steps = [...draft.steps]; steps[index] = { ...step, use_trigger_value: checked }; setDraft({ ...draft, steps }); }} /><Text>使用执行触发值</Text></Space>
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
