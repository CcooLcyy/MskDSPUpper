import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
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
  ControlOrchestratorExecuteResponse,
  ControlOrchestratorStepVerification,
  ControlOrchestratorWorkflowConfig,
  DcConnectionInfo,
  DcEndpoint,
  DcPointValue,
} from '../../adapters';
import {
  EDITABLE_POINT_VALUE_TYPES,
  parseEditablePointValue,
  resolveEditablePointValueType,
} from '../../utils/control-point-value';
import type { EditablePointValueType } from '../../utils/control-point-value';
import './index.css';

const { Text } = Typography;

type StepDraft = {
  step_name: string;
  module_name: string;
  conn_name: string;
  tag: string;
  value_type: EditablePointValueType;
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
  step_name: '', module_name: '', conn_name: '', tag: '', value_type: 'Decimal', value: '0',
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
  return parseEditablePointValue(step.value_type, step.value);
}

function draftFromConfig(config: ControlOrchestratorWorkflowConfig): WorkflowDraft {
  return {
    sequence_name: config.sequence_name,
    steps: config.steps.map((step) => {
      const value = step.value;
      const type = resolveEditablePointValueType(value);
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
const internalOutputTag = (sequenceName: string, stepName: string) => `step:${sequenceName}:${stepName}`;

const isOrchestratorEndpoint = (endpoint: DcEndpoint) => endpoint.module_name === orchestratorConnection.module_name
  && endpoint.conn_name === orchestratorConnection.conn_name;

const isManagedRouteForSequence = (route: { src: DcEndpoint; dst: DcEndpoint }, sequenceName: string) => {
  const triggerTag = `trigger:${sequenceName}`;
  const stepPrefix = `step:${sequenceName}:`;
  return (isOrchestratorEndpoint(route.dst) && route.dst.tag === triggerTag)
    || (isOrchestratorEndpoint(route.src) && route.src.tag.startsWith(stepPrefix));
};

async function syncBinding(
  previous: ControlOrchestratorWorkflowConfig | null,
  next: ControlOrchestratorWorkflowConfig | null,
) {
  if (!previous?.trigger && !next?.trigger) return;
  const sequenceName = next?.sequence_name ?? previous?.sequence_name ?? '';
  if (!sequenceName) return;
  const routes = await api.dcListRoutes(0, '', 0, '');
  const routeTag = `trigger:${sequenceName}`;
  const previousRouteTags = previous
    ? new Set([`trigger:${previous.sequence_name}`, ...previous.steps.map((step) => internalOutputTag(previous.sequence_name, step.step_name))])
    : new Set<string>();
  const trigger = next?.trigger ?? null;
  const conflict = trigger
    ? routes.find((route) => route.dst.module_name === orchestratorConnection.module_name
      && route.dst.conn_name === orchestratorConnection.conn_name
      && endpointKey(route.src) === endpointKey(trigger)
      && route.dst.tag !== routeTag
      && !previousRouteTags.has(route.dst.tag))
    : undefined;
  if (conflict) throw new Error('该触发源点已绑定其他编排，请先解除原绑定');
  const directConflict = trigger
    ? routes.find((route) => endpointKey(route.src) === endpointKey(trigger)
      && !isOrchestratorEndpoint(route.dst)
      && !isManagedRouteForSequence(route, previous?.sequence_name ?? sequenceName))
    : undefined;
  if (directConflict) throw new Error('该触发源点已有数据总线直达路由，请先删除直达路由再启用编排');
  const connection = await api.dcGetOrCreateConnection(orchestratorConnection.module_name, orchestratorConnection.conn_name);
  const activeConfigs = await api.controlOrchestratorListSequences();
  const effectiveConfigs = activeConfigs
    .filter((config) => config.sequence_name !== previous?.sequence_name)
    .concat(next?.trigger ? [next] : []);
  const activeRouteTags = effectiveConfigs
    .filter((config) => config.trigger)
    .flatMap((config) => [
      `trigger:${config.sequence_name}`,
      ...config.steps.map((step) => internalOutputTag(config.sequence_name, step.step_name)),
    ]);
  await api.dcUpsertConnTags(connection.conn_id, [...new Set(activeRouteTags)], true);
  const staleRoutes = routes.filter((route) => {
    return previousRouteTags.has(route.dst.tag) && isOrchestratorEndpoint(route.dst)
      || (previous?.sequence_name ? isManagedRouteForSequence(route, previous.sequence_name) : false)
      || isManagedRouteForSequence(route, sequenceName);
  });
  if (staleRoutes.length > 0) await api.dcDeleteRoutes(staleRoutes);
  if (next?.trigger) {
    const routesToAdd: Array<{ src: DcEndpoint; dst: DcEndpoint }> = [{
      src: next.trigger,
      dst: {
        module_name: orchestratorConnection.module_name,
        conn_name: orchestratorConnection.conn_name,
        tag: routeTag,
        conn_id: connection.conn_id,
      },
    }, ...next.steps.map((step) => ({
      src: {
        module_name: orchestratorConnection.module_name,
        conn_name: orchestratorConnection.conn_name,
        tag: internalOutputTag(next.sequence_name, step.step_name),
        conn_id: connection.conn_id,
      },
      dst: step.source,
    }))];
    await api.dcUpsertRoutes(routesToAdd, false);
    console.info('控制编排自动路由已同步', {
      sequenceName: next.sequence_name,
      routeCount: routesToAdd.length,
    });
  } else {
    console.info('控制编排自动路由已清理', { sequenceName });
  }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error).replace(/^Error:\s*/, '');
const decimalNumberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const valueTypeLabels: Record<EditablePointValueType, string> = {
  Bool: '布尔值', Int: '整数', Double: '浮点数', Decimal: '十进制数', String: '文本',
};
const valueTypeOptions = EDITABLE_POINT_VALUE_TYPES.map((value) => ({ value, label: valueTypeLabels[value] }));
const commandStatusLabels: Record<number, string> = {
  0: '未返回命令状态', 1: '命令已接受', 2: '命令被拒绝', 3: '没有匹配路由',
  4: '匹配到多条路由', 5: '目标不可达', 6: '命令超时', 7: '内部错误',
};
type Operation = 'saving' | 'executing' | 'deleting' | 'retrying';
type PendingBinding = {
  previous: ControlOrchestratorWorkflowConfig | null;
  config: ControlOrchestratorWorkflowConfig;
  reason: string;
};
type ExecutionRecord = {
  sequenceName: string;
  startedAt: string;
  completedAt?: string;
  state: 'running' | 'success' | 'failure' | 'communication-error';
  result?: ControlOrchestratorExecuteResponse;
  reason?: string;
};

const ControlOrchestratorPage: React.FC = () => {
  const { modal } = App.useApp();
  const [configs, setConfigs] = useState<ControlOrchestratorWorkflowConfig[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowDraft>(emptyDraft);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editorConfig, setEditorConfig] = useState<ControlOrchestratorWorkflowConfig | null>(null);
  const baseline = useRef('');
  const formContainer = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const operationRef = useRef<Operation | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [pendingBinding, setPendingBinding] = useState<PendingBinding | null>(null);
  const [execution, setExecution] = useState<ExecutionRecord | null>(null);
  const [executeModalOpen, setExecuteModalOpen] = useState(false);
  const [executeValueType, setExecuteValueType] = useState<EditablePointValueType>('Decimal');
  const [executeValue, setExecuteValue] = useState('0');
  const [executeError, setExecuteError] = useState('');
  const [messageApi, contextHolder] = message.useMessage();
  const [connections, setConnections] = useState<DcConnectionInfo[]>([]);
  const [connectionTags, setConnectionTags] = useState<Map<number, string[]>>(new Map());
  const [tagLoadErrors, setTagLoadErrors] = useState<Map<number, string>>(new Map());
  const [endpointError, setEndpointError] = useState('');
  const [endpointLoading, setEndpointLoading] = useState(false);
  const endpointLoadingRef = useRef(false);
  const busy = operation !== null;
  const formLocked = busy;
  const saving = operation === 'saving';
  const executing = operation === 'executing';
  const deleting = operation === 'deleting';
  const retrying = operation === 'retrying';
  const selected = useMemo(() => configs.find((config) => config.sequence_name === selectedName) ?? null, [configs, selectedName]);

  const acquire = (next: Operation) => {
    if (operationRef.current) return false;
    operationRef.current = next;
    setOperation(next);
    return true;
  };
  const release = () => { operationRef.current = null; setOperation(null); };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.controlOrchestratorListSequences();
      setConfigs(next);
      setSelectedName((current) => current && next.some((item) => item.sequence_name === current) ? current : next[0]?.sequence_name ?? null);
    } catch (error) {
      console.error('控制编排列表加载失败', error);
      messageApi.error(`加载编排失败：${errorText(error)}`);
    } finally { setLoading(false); }
  }, [messageApi]);
  useEffect(() => { void refresh(); }, [refresh]);

  const refreshEndpointOptions = useCallback(async () => {
    if (endpointLoadingRef.current) return;
    endpointLoadingRef.current = true;
    setEndpointLoading(true);
    setEndpointError('');
    try {
      const nextConnections = await api.dcListConnections();
      const tagEntries = await Promise.all(nextConnections.map(async (connection) => {
        try {
          return { id: connection.conn_id, tags: (await api.dcGetConnTags(connection.conn_id)).tags, error: '' };
        } catch (error) {
          console.error('控制编排连接点名加载失败', { connection: connection.conn_name, error });
          return { id: connection.conn_id, tags: [] as string[], error: errorText(error) };
        }
      }));
      setConnections(nextConnections);
      setConnectionTags(new Map(tagEntries.map((entry) => [entry.id, entry.tags])));
      setTagLoadErrors(new Map(tagEntries.filter((entry) => entry.error).map((entry) => [entry.id, entry.error])));
    } catch (error) {
      setEndpointError(`连接列表加载失败：${errorText(error)}`);
      console.error('控制编排连接列表加载失败', error);
    } finally {
      endpointLoadingRef.current = false;
      setEndpointLoading(false);
    }
  }, []);
  useEffect(() => { if (modalOpen) void refreshEndpointOptions(); }, [modalOpen, refreshEndpointOptions]);

  const moduleOptions = useMemo(() => {
    const names = new Set(connections.map((connection) => connection.module_name));
    [draft.trigger_module_name, ...draft.steps.flatMap((step) => [step.module_name, step.status_module_name])]
      .map((name) => name.trim()).filter(Boolean).forEach((name) => names.add(name));
    return [...names].sort((left, right) => left.localeCompare(right, 'zh-CN')).map((value) => ({ value, label: value }));
  }, [connections, draft]);
  const connectionOptions = (moduleName: string, currentConnName: string) => {
    const options = connections.filter((connection) => connection.module_name === moduleName)
      .map((connection) => ({ value: connection.conn_name, label: connection.conn_name }));
    if (currentConnName && !options.some((option) => option.value === currentConnName)) {
      options.unshift({ value: currentConnName, label: `${currentConnName}（当前配置）` });
    }
    return options;
  };
  const tagOptions = (moduleName: string, connName: string, currentTag: string) => {
    const connection = connections.find((item) => item.module_name === moduleName && item.conn_name === connName);
    const tags = connection ? connectionTags.get(connection.conn_id) ?? [] : [];
    const options = tags.map((tag) => ({ value: tag, label: tag }));
    if (currentTag && !options.some((option) => option.value === currentTag)) {
      options.unshift({ value: currentTag, label: `${currentTag}（当前配置）` });
    }
    return options;
  };
  const tagLoadFailed = (moduleName: string, connName: string) => {
    const connection = connections.find((item) => item.module_name === moduleName && item.conn_name === connName);
    return connection ? tagLoadErrors.has(connection.conn_id) : false;
  };
  const updateStep = (index: number, patch: Partial<StepDraft>) => {
    setDraft((current) => ({ ...current, steps: current.steps.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step) }));
    setErrors({});
  };
  const openEditor = (config: ControlOrchestratorWorkflowConfig | null) => {
    if (operationRef.current || (pendingBinding && config?.sequence_name !== pendingBinding.config.sequence_name)) return;
    const next = config ? draftFromConfig(config) : emptyDraft();
    setEditing(Boolean(config)); setEditorConfig(config); setDraft(next);
    baseline.current = JSON.stringify(next); setErrors({}); setModalOpen(true);
  };
  const closeEditor = () => {
    if (operationRef.current) return;
    if (JSON.stringify(draft) !== baseline.current) {
      console.info('控制编排请求确认放弃未保存的修改');
      modal.confirm({
        title: '放弃未保存的修改？', content: '本次编辑的内容尚未保存，关闭后将丢弃这些修改。',
        okText: '放弃修改', cancelText: '继续编辑', onOk: () => setModalOpen(false),
      });
    } else setModalOpen(false);
  };
  const focusError = (field: string) => {
    requestAnimationFrame(() => {
      const item = formContainer.current?.querySelector<HTMLElement>(`[data-field="${field}"]`);
      if (!item) return;
      const details = item.closest('details');
      if (details) details.open = true;
      item.scrollIntoView({ block: 'center', behavior: 'smooth' });
      item.querySelector<HTMLElement>('input, button, [tabindex]')?.focus({ preventScroll: true });
    });
  };
  const validate = () => {
    const next: Record<string, string> = {};
    const requireField = (key: string, value: string, label: string) => { if (!value.trim()) next[key] = `请填写或选择${label}`; };
    requireField('sequence_name', draft.sequence_name, '编排名称');
    const parts = [draft.trigger_module_name, draft.trigger_conn_name, draft.trigger_tag];
    if (parts.some((value) => value.trim())) {
      requireField('trigger.module', parts[0], '触发模块'); requireField('trigger.connection', parts[1], '触发连接'); requireField('trigger.tag', parts[2], '触发点名');
    }
    const names = new Set<string>();
    draft.steps.forEach((step, index) => {
      const key = `steps.${index}`;
      requireField(`${key}.name`, step.step_name, '步骤名');
      if (names.has(step.step_name.trim())) next[`${key}.name`] = '步骤名不能重复';
      names.add(step.step_name.trim());
      requireField(`${key}.module`, step.module_name, '目标模块'); requireField(`${key}.connection`, step.conn_name, '目标连接'); requireField(`${key}.tag`, step.tag, '目标点名');
      if (!step.use_trigger_value) {
        try {
          if (step.value_type === 'Int' && !/^[+-]?\d+$/.test(step.value.trim())) throw new Error('请输入完整整数');
          if (step.value_type === 'Int' && !Number.isSafeInteger(Number(step.value))) throw new Error('整数超出可精确表示的范围，请使用十进制数');
          if (step.value_type === 'Double' && (!decimalNumberPattern.test(step.value.trim()) || !Number.isFinite(Number(step.value)))) throw new Error('请输入有效浮点数');
          parseValue(step);
        } catch (error) { next[`${key}.value`] = error instanceof Error ? error.message : errorText(error); }
      }
      if (step.verification_enabled) {
        requireField(`${key}.status.module`, step.status_module_name, '遥信模块'); requireField(`${key}.status.connection`, step.status_conn_name, '遥信连接'); requireField(`${key}.status.tag`, step.status_tag, '遥信点名');
      }
    });
    const checkEndpoint = (moduleName: string, connName: string, tag: string, field: string) => {
      if (!moduleName || !connName || !tag) return;
      if (endpointError) { next[field] = '连接列表加载失败，请刷新点表后重试'; return; }
      const connection = connections.find((item) => item.module_name === moduleName && item.conn_name === connName);
      if (!connection) { next[field] = '连接尚未在数据中心注册'; return; }
      if (tagLoadErrors.has(connection.conn_id)) { next[field] = '该连接的点名加载失败，请刷新点表后重试'; return; }
      if (!(connectionTags.get(connection.conn_id) ?? []).includes(tag)) next[field] = '点名尚未在数据中心注册';
    };
    checkEndpoint(draft.trigger_module_name, draft.trigger_conn_name, draft.trigger_tag, 'trigger.tag');
    draft.steps.forEach((step, index) => {
      checkEndpoint(step.module_name, step.conn_name, step.tag, `steps.${index}.tag`);
      if (step.verification_enabled) checkEndpoint(step.status_module_name, step.status_conn_name, step.status_tag, `steps.${index}.status.tag`);
    });
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) { focusError(first); messageApi.warning('请检查标红字段'); return false; }
    return true;
  };

  const save = async () => {
    if (operationRef.current || endpointLoadingRef.current || (pendingBinding && editorConfig?.sequence_name !== pendingBinding.config.sequence_name)) return;
    if (!validate()) return;
    if (draft.steps.length < 1 || draft.steps.length > 8) { messageApi.warning('步骤数量需为 1 到 8'); return; }
    if (editing && editorConfig && draft.sequence_name.trim() !== editorConfig.sequence_name) return;
    const config = configFromDraft(draft);
    const endpoints = [config.trigger, ...config.steps.flatMap((step) => [step.source, step.verification?.status_source])];
    endpoints.forEach((endpoint) => {
      if (endpoint) endpoint.conn_id = connections.find((connection) => connection.module_name === endpoint.module_name && connection.conn_name === endpoint.conn_name)?.conn_id;
    });
    if (!acquire('saving')) return;
    try {
      const previous = pendingBinding
        ? (pendingBinding.previous?.trigger ? pendingBinding.previous : pendingBinding.config)
        : editing ? editorConfig : null;
      await api.controlOrchestratorUpsertSequence(config, !editing);
      // 新建配置一旦保存即切换编辑态，路由同步失败后不会再次发起仅创建请求。
      setEditing(true); setEditorConfig(config); baseline.current = JSON.stringify(draft);
      setConfigs((current) => [...current.filter((item) => item.sequence_name !== config.sequence_name), config]);
      setSelectedName(config.sequence_name);
      console.info('控制编排配置已保存，开始自动同步路由', { sequenceName: config.sequence_name });
      try {
        await syncBinding(previous, config);
      } catch (error) {
        setPendingBinding({ previous, config, reason: errorText(error) });
        console.error('控制编排已保存但自动路由同步失败，可独立重试', error);
        messageApi.error('编排已保存，但自动路由同步失败，请点击重试路由同步');
        await refresh(); return;
      }
      setPendingBinding(null);
      messageApi.success('编排已保存，自动路由已同步');
      setModalOpen(false); await refresh(); setSelectedName(config.sequence_name);
    } catch (error) {
      console.error('控制编排保存失败', error); messageApi.error(`保存失败：${errorText(error)}`);
    } finally { release(); }
  };
  const retryBinding = async () => {
    if (!pendingBinding || !acquire('retrying')) return;
    const pending = pendingBinding;
    try {
      await syncBinding(pending.previous, pending.config);
      setPendingBinding(null); messageApi.success('自动路由已同步');
      console.info('控制编排自动路由重试成功', { sequenceName: pending.config.sequence_name });
      await refresh();
    } catch (error) {
      setPendingBinding({ ...pending, reason: errorText(error) });
      console.error('控制编排自动路由重试失败', error); messageApi.error(`自动路由同步失败：${errorText(error)}`);
    } finally { release(); }
  };
  const remove = async () => {
    if (!selected || pendingBinding || !acquire('deleting')) return;
    try {
      try { await syncBinding(selected, null); }
      catch (error) { messageApi.error(`自动路由清理失败，编排未删除：${errorText(error)}`); await refresh(); return; }
      await api.controlOrchestratorDeleteSequence(selected.sequence_name);
      console.info('控制编排已删除', { sequenceName: selected.sequence_name });
      messageApi.success('编排已删除'); await refresh();
    } catch (error) { console.error('控制编排删除失败', error); messageApi.error(`删除失败：${errorText(error)}`); }
    finally { release(); }
  };
  const executeNow = async (triggerValue?: DcPointValue) => {
    if (!selected || pendingBinding || !acquire('executing')) return;
    const sequenceName = selected.sequence_name;
    const startedAt = new Date().toLocaleString('zh-CN', { hour12: false });
    setExecuteModalOpen(false);
    setExecution({ sequenceName, startedAt, state: 'running' });
    console.info('控制编排开始手工执行', { sequenceName });
    try {
      const request: ControlOrchestratorExecuteRequest = {
        sequence_name: sequenceName, trigger_value: triggerValue, request_id: `upper-${Date.now()}`,
      };
      const result = await api.controlOrchestratorExecuteSequence(request);
      setExecution({ sequenceName, startedAt, completedAt: new Date().toLocaleString('zh-CN', { hour12: false }), state: result.accepted ? 'success' : 'failure', result });
      console.info('控制编排手工执行返回结果', { sequenceName, result });
      if (result.accepted) messageApi.success(`执行成功，命令已接受数量：${result.executed_steps}`);
      else messageApi.error(`执行失败：${result.reason || '未返回失败原因'}`);
    } catch (error) {
      setExecution({ sequenceName, startedAt, completedAt: new Date().toLocaleString('zh-CN', { hour12: false }), state: 'communication-error', reason: errorText(error) });
      console.error('控制编排手工执行通信异常，执行结果未知', { sequenceName, error });
      messageApi.error('通信异常，执行结果未知，请核实设备状态后再操作');
    } finally { release(); }
  };
  const execute = () => {
    if (!selected || operationRef.current || pendingBinding) return;
    setExecuteValueType('Decimal'); setExecuteValue('0'); setExecuteError(''); setExecuteModalOpen(true);
  };
  const confirmExecute = () => {
    if (!selected || operationRef.current) return;
    let value: DcPointValue | undefined;
    if (selected.steps.some((step) => step.use_trigger_value)) {
      try {
        if (executeValueType === 'Int' && (!/^[+-]?\d+$/.test(executeValue.trim()) || !Number.isSafeInteger(Number(executeValue)))) throw new Error('请输入可精确表示的完整整数');
        if (executeValueType === 'Double' && (!decimalNumberPattern.test(executeValue.trim()) || !Number.isFinite(Number(executeValue)))) throw new Error('请输入有效浮点数');
        value = parseEditablePointValue(executeValueType, executeValue);
      } catch (error) { setExecuteError(error instanceof Error ? error.message : errorText(error)); return; }
    }
    void executeNow(value);
  };

  const changeSteps = (next: StepDraft[]) => { setDraft((current) => ({ ...current, steps: next })); setErrors({}); };
  const moveStep = (index: number, offset: number) => {
    const next = [...draft.steps]; const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; changeSteps(next);
  };
  const copyStep = (index: number) => {
    if (draft.steps.length >= 8) return;
    const source = draft.steps[index]; const base = source.step_name.trim() || `步骤${index + 1}`;
    const names = new Set(draft.steps.map((step) => step.step_name.trim()));
    let suffix = 1; let name = `${base}副本`;
    while (names.has(name)) { suffix += 1; name = `${base}副本${suffix}`; }
    const next = [...draft.steps]; next.splice(index + 1, 0, { ...source, step_name: name }); changeSteps(next);
  };
  const field = (key: string, label: string, child: React.ReactNode, required = false) => (
    <Form.Item key={key} data-field={key} label={label} required={required} validateStatus={errors[key] ? 'error' : undefined} help={errors[key]}>{child}</Form.Item>
  );
  const endpointFields = (key: string, prefix: string, moduleName: string, connName: string, tag: string, onChange: (moduleName: string, connName: string, tag: string) => void, required: boolean) => <>
    {field(`${key}.module`, `${prefix}模块`, <Select aria-label={`${key.startsWith('steps.') ? `步骤 ${Number(key.split('.')[1]) + 1} ` : ''}${prefix}模块`} allowClear showSearch optionFilterProp="label" loading={endpointLoading} value={moduleName || undefined} options={moduleOptions} placeholder="选择模块" onChange={(value) => onChange(value ?? '', '', '')} />, required)}
    {field(`${key}.connection`, `${prefix}连接`, <Select aria-label={`${key.startsWith('steps.') ? `步骤 ${Number(key.split('.')[1]) + 1} ` : ''}${prefix}连接`} allowClear showSearch optionFilterProp="label" loading={endpointLoading} disabled={formLocked || !moduleName} value={connName || undefined} options={connectionOptions(moduleName, connName)} placeholder="选择连接" onChange={(value) => onChange(moduleName, value ?? '', '')} />, required)}
    {field(`${key}.tag`, `${prefix}点名`, <Select aria-label={`${key.startsWith('steps.') ? `步骤 ${Number(key.split('.')[1]) + 1} ` : ''}${prefix}点名`} allowClear showSearch optionFilterProp="label" loading={endpointLoading} disabled={formLocked || !moduleName || !connName} value={tag || undefined} options={tagOptions(moduleName, connName, tag)} placeholder="选择点名" notFoundContent={tagLoadFailed(moduleName, connName) ? '点名加载失败，请刷新重试' : '暂无已注册点名'} onChange={(value) => onChange(moduleName, connName, value ?? '')} />, required)}
  </>;
  const boolValueInput = (value: string, onChange: (value: string) => void, label: string) => <Select aria-label={label} value={value === 'true' || value === '1' ? 'true' : 'false'} options={[{ value: 'true', label: '真（置位）' }, { value: 'false', label: '假（复位）' }]} onChange={onChange} />;
  const pendingNotice = pendingBinding && <Alert type="error" showIcon title={`编排“${pendingBinding.config.sequence_name}”已保存，自动路由未同步`} description={<><div>{pendingBinding.reason}</div><div>可重试路由同步，或编辑本编排修正触发源点及目标后重新保存。重试仅同步已保存的配置，当前草稿需重新保存。恢复前不能执行或删除编排。</div></>} action={<Button loading={retrying} disabled={busy && !retrying} onClick={() => void retryBinding()}>重试路由同步</Button>} />;
  const columns: ColumnsType<ControlOrchestratorWorkflowConfig> = [
    { title: '编排名称', dataIndex: 'sequence_name', render: (value: string) => <Text strong>{value}</Text> },
    { title: '步骤数', render: (_, record) => <Tag>{record.steps.length}</Tag> },
    { title: '触发方式', render: (_, record) => record.trigger ? '源点自动触发／手工执行' : '仅手工执行' },
    { title: '步骤摘要', render: (_, record) => record.steps.map((step) => step.step_name).join(' → ') },
  ];
  const needsTriggerValue = selected?.steps.some((step) => step.use_trigger_value);
  const executionLabels = { running: '执行中', success: '执行成功', failure: '执行失败', 'communication-error': '通信异常，执行结果未知' };

  return <div className="orchestrator-page">
    {contextHolder}
    {pendingNotice}
    <Card className="orchestrator-toolbar" size="small"><Space wrap>
      <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} disabled={busy || Boolean(pendingBinding)} onClick={() => openEditor(null)}>新建编排</Button>
      <Button icon={<EditOutlined aria-hidden="true" />} disabled={!selected || busy || Boolean(pendingBinding && selected?.sequence_name !== pendingBinding.config.sequence_name)} onClick={() => selected && openEditor(selected)}>编辑</Button>
      <Popconfirm title={`确认删除编排“${selected?.sequence_name ?? ''}”？`} description="删除时会自动清理该编排维护的路由。" okText="删除" cancelText="取消" onConfirm={remove} disabled={!selected || busy || Boolean(pendingBinding)}>
        <Button danger icon={<DeleteOutlined aria-hidden="true" />} loading={deleting} disabled={!selected || busy || Boolean(pendingBinding)}>删除</Button>
      </Popconfirm>
      <Button icon={<PlayCircleOutlined aria-hidden="true" />} loading={executing} disabled={!selected || busy || Boolean(pendingBinding)} onClick={execute}>{executing ? '执行中' : '执行'}</Button>
      <Button icon={<ReloadOutlined aria-hidden="true" />} loading={loading} disabled={busy} onClick={() => void refresh()}>刷新</Button>
    </Space></Card>
    <Card className="orchestrator-list" size="small" title="控制编排">
      <Table rowKey="sequence_name" size="small" loading={loading} dataSource={configs} columns={columns} locale={{ emptyText: '暂无编排，请新建编排' }}
        rowClassName={(record) => record.sequence_name === selectedName ? 'orchestrator-selected-row' : ''}
        onRow={(record) => ({ onClick: () => { if (!operationRef.current && !executeModalOpen) setSelectedName(record.sequence_name); } })} pagination={false} scroll={{ x: 600 }} />
      {selected ? <div className="orchestrator-detail"><Text type="secondary">当前步骤：</Text>{selected.steps.map((step, index) => <Tag key={`${step.step_name}-${index}`}>{index + 1}. {step.step_name} · {step.source.module_name}/{step.source.conn_name}/{step.source.tag}</Tag>)}</div> : <div className="orchestrator-empty">请选择或新建一个编排</div>}
    </Card>
    <Card size="small" title="最近一次手工执行结果" className="orchestrator-execution" aria-live="polite">
      {execution ? <>
        <Space wrap><Text strong>{execution.sequenceName}</Text><Tag color={execution.state === 'success' ? 'success' : execution.state === 'running' ? 'processing' : 'error'}>{executionLabels[execution.state]}</Tag></Space>
        <div>开始时间：{execution.startedAt}{execution.completedAt && `；结束时间：${execution.completedAt}`}</div>
        {execution.result && <>
          <div>命令已接受数量：{execution.result.executed_steps}（不等同于遥信校验通过数量）</div>
          {!execution.result.accepted && <>
            <div>失败步骤：{execution.result.failed_step_index > 0 ? `第 ${execution.result.failed_step_index} 步 · ${execution.result.failed_step_name || '未命名步骤'}` : '未进入具体步骤'}</div>
            <div>命令状态：{commandStatusLabels[execution.result.failed_command_status] ?? `未知命令状态（${execution.result.failed_command_status}）`}</div>
            <div>失败原因：{execution.result.reason || '未返回失败原因'}</div>
          </>}
        </>}
        {execution.state === 'communication-error' && <Alert type="warning" title="通信异常，执行结果未知，请核实设备状态后再操作。" description={execution.reason} />}
      </> : <Text type="secondary">暂无手工执行记录。执行后将在此保留本次结果。</Text>}
    </Card>
    <Modal className="orchestrator-editor-modal" title={editing ? '编辑编排' : '新建编排'} open={modalOpen} onCancel={closeEditor} onOk={() => void save()} confirmLoading={saving}
      cancelText={pendingBinding ? '关闭' : '取消'} okText="保存并同步路由" width={960} style={{ top: 24 }} keyboard={!busy} closable={{ disabled: busy, 'aria-label': '关闭' }} maskClosable={false}
      cancelButtonProps={{ disabled: busy }} okButtonProps={{ disabled: busy || endpointLoading }}>
      <div ref={formContainer} className="orchestrator-editor-body">
        {pendingNotice}
        <Alert type="info" showIcon title="选择点位仅更新当前草稿。点击“保存并同步路由”后，才保存编排并自动建立或更新路由。" description="设置触发源点后，来自该源点的同步控制将进入本编排；全部留空时仅支持手工执行。" />
        <div className="orchestrator-point-toolbar"><Text type="secondary">从数据中心已注册点位中选择目标和遥信。</Text><Button icon={<ReloadOutlined aria-hidden="true" />} loading={endpointLoading} disabled={busy} onClick={() => void refreshEndpointOptions()}>刷新点表</Button></div>
        {endpointError && <Alert type="error" title={endpointError} description="请刷新点表后重试，当前结果不能用于判断连接或点名是否已注册。" />}
        {tagLoadErrors.size > 0 && <Alert type="warning" title={`有 ${tagLoadErrors.size} 个连接的点名加载失败`} description={[...tagLoadErrors.keys()].map((id) => connections.find((connection) => connection.conn_id === id)).filter(Boolean).map((connection) => `${connection!.module_name}/${connection!.conn_name}`).join('、') + '。请刷新点表重试。'} />}
        <Form layout="vertical" disabled={busy}>
          {field('sequence_name', '编排名称', <Input aria-label="编排名称" disabled={editing || formLocked} value={draft.sequence_name} onChange={(event) => { setDraft({ ...draft, sequence_name: event.target.value }); setErrors({}); }} placeholder="例如：逆变器远方调节" />, true)}
          <Card size="small" title="触发源点（可选）"><div className="orchestrator-endpoint-grid">
            {endpointFields('trigger', '触发', draft.trigger_module_name, draft.trigger_conn_name, draft.trigger_tag, (module, connection, tag) => { setDraft((current) => ({ ...current, trigger_module_name: module, trigger_conn_name: connection, trigger_tag: tag })); setErrors({}); }, false)}
          </div></Card>
          {draft.steps.map((step, index) => <Card key={index} size="small" className="orchestrator-step" title={`步骤 ${index + 1}${step.step_name ? ` · ${step.step_name}` : ''}`}
            extra={<Space size={0} wrap><Button size="small" type="text" disabled={formLocked || index === 0} onClick={() => moveStep(index, -1)}>上移</Button><Button size="small" type="text" disabled={formLocked || index === draft.steps.length - 1} onClick={() => moveStep(index, 1)}>下移</Button><Button size="small" type="text" disabled={formLocked || draft.steps.length >= 8} onClick={() => copyStep(index)}>复制</Button><Button size="small" type="text" danger icon={<DeleteOutlined aria-hidden="true" />} disabled={formLocked || draft.steps.length <= 1} onClick={() => changeSteps(draft.steps.filter((_, itemIndex) => itemIndex !== index))}>删除</Button></Space>}>
            {field(`steps.${index}.name`, '步骤名', <Input aria-label={`步骤 ${index + 1} 步骤名`} value={step.step_name} onChange={(event) => updateStep(index, { step_name: event.target.value })} placeholder="例如：切换远方模式" />, true)}
            <div className="orchestrator-endpoint-grid">{endpointFields(`steps.${index}`, '目标', step.module_name, step.conn_name, step.tag, (module, connection, tag) => updateStep(index, { module_name: module, conn_name: connection, tag }), true)}</div>
            <div className="orchestrator-step-grid">
              <Form.Item label="命令值来源"><Select aria-label={`步骤 ${index + 1} 命令值来源`} value={step.use_trigger_value ? 'trigger' : 'fixed'} options={[{ value: 'fixed', label: '固定值' }, { value: 'trigger', label: '使用触发值' }]} onChange={(value) => updateStep(index, { use_trigger_value: value === 'trigger' })} /></Form.Item>
              {!step.use_trigger_value && <><Form.Item label="固定值类型"><Select aria-label={`步骤 ${index + 1} 固定值类型`} value={step.value_type} options={valueTypeOptions} onChange={(value) => updateStep(index, { value_type: value })} /></Form.Item>
                {field(`steps.${index}.value`, '固定值', step.value_type === 'Bool' ? boolValueInput(step.value, (value) => updateStep(index, { value }), `步骤 ${index + 1} 固定值`) : <Input aria-label={`步骤 ${index + 1} 固定值`} value={step.value} onChange={(event) => updateStep(index, { value: event.target.value })} />, true)}</>}
            </div>
            {step.use_trigger_value && <Text type="secondary">本步骤使用本次执行传入的触发值；手工执行时会要求输入。</Text>}
            <div className="orchestrator-verification"><Space><Switch aria-label={`步骤 ${index + 1} 命令后检查遥信状态`} checked={step.verification_enabled} onChange={(checked) => updateStep(index, { verification_enabled: checked })} /><Text>命令后检查遥信状态</Text></Space></div>
            {step.verification_enabled && <><div className="orchestrator-endpoint-grid">{endpointFields(`steps.${index}.status`, '遥信', step.status_module_name, step.status_conn_name, step.status_tag, (module, connection, tag) => updateStep(index, { status_module_name: module, status_conn_name: connection, status_tag: tag }), true)}</div>
              <Form.Item label="期望状态"><Select aria-label={`步骤 ${index + 1} 期望状态`} value={step.expected_state} options={[{ value: true, label: '真（置位）' }, { value: false, label: '假（复位）' }]} onChange={(value) => updateStep(index, { expected_state: value })} /></Form.Item></>}
            <details className="orchestrator-advanced"><summary>高级参数（超时、延时及重试）</summary><div className="orchestrator-step-grid">
              <Form.Item label="命令超时（毫秒）"><InputNumber min={1} max={4294967295} precision={0} value={step.timeout_ms} onChange={(value) => updateStep(index, { timeout_ms: value ?? 1 })} /></Form.Item>
              <Form.Item label="步骤间延时（毫秒）"><InputNumber min={0} max={4294967295} precision={0} value={step.delay_after_ms} onChange={(value) => updateStep(index, { delay_after_ms: value ?? 0 })} /></Form.Item>
              {step.verification_enabled && <>
                <Form.Item label="遥信等待超时（毫秒）"><InputNumber min={1} max={4294967295} precision={0} value={step.wait_timeout_ms} onChange={(value) => updateStep(index, { wait_timeout_ms: value ?? 1 })} /></Form.Item>
                <Form.Item label="遥信轮询间隔（毫秒）"><InputNumber min={1} max={4294967295} precision={0} value={step.poll_interval_ms} onChange={(value) => updateStep(index, { poll_interval_ms: value ?? 1 })} /></Form.Item>
                <Form.Item label="检查失败策略"><Select value={step.failure_action} options={[{ value: 'STOP', label: '停止，不下发后续命令' }, { value: 'RETRY_COMMAND', label: '重新下发本步骤命令' }]} onChange={(value) => updateStep(index, { failure_action: value })} /></Form.Item>
                <Form.Item label="最大重试次数"><InputNumber min={0} max={4294967295} precision={0} value={step.max_retries} disabled={formLocked || step.failure_action !== 'RETRY_COMMAND'} onChange={(value) => updateStep(index, { max_retries: value ?? 0 })} /></Form.Item>
                <Form.Item label="重试间隔（毫秒）"><InputNumber min={0} max={4294967295} precision={0} value={step.retry_interval_ms} disabled={formLocked || step.failure_action !== 'RETRY_COMMAND'} onChange={(value) => updateStep(index, { retry_interval_ms: value ?? 0 })} /></Form.Item>
              </>}
            </div></details>
          </Card>)}
          <Button block icon={<PlusOutlined aria-hidden="true" />} onClick={() => changeSteps([...draft.steps, emptyStep()])} disabled={formLocked || draft.steps.length >= 8}>添加步骤（{draft.steps.length}/8）</Button>
        </Form>
      </div>
    </Modal>
    <Modal className="orchestrator-editor-modal" width={600} style={{ top: 24 }} title="确认执行编排" open={executeModalOpen} onCancel={() => { if (!operationRef.current) setExecuteModalOpen(false); }} onOk={confirmExecute} okText="执行" cancelText="取消" confirmLoading={executing} closable={{ 'aria-label': '关闭' }} maskClosable={false}>
      <Alert type="warning" showIcon title={`即将执行编排“${selected?.sequence_name ?? ''}”`} description="确认目标和值后执行，命令将按步骤顺序下发。" />
      <ol className="orchestrator-execute-preview">{selected?.steps.map((step, index) => <li key={index}><strong>{step.step_name}</strong><div>{step.source.module_name}/{step.source.conn_name}/{step.source.tag}</div><div>命令值：{step.use_trigger_value ? '使用触发值' : step.value?.type === 'Bool' ? step.value.value ? '真（置位）' : '假（复位）' : String(step.value?.value ?? '')}</div></li>)}</ol>
      {needsTriggerValue && <Form layout="vertical"><Form.Item label="触发值类型" required><Select aria-label="触发值类型" value={executeValueType} options={valueTypeOptions} onChange={(value) => { setExecuteValueType(value); setExecuteError(''); }} /></Form.Item>
        <Form.Item label="触发值" required validateStatus={executeError ? 'error' : undefined} help={executeError}>{executeValueType === 'Bool' ? boolValueInput(executeValue, setExecuteValue, '触发值') : <Input aria-label="触发值" value={executeValue} onChange={(event) => { setExecuteValue(event.target.value); setExecuteError(''); }} placeholder="供使用触发值的步骤复用" />}</Form.Item></Form>}
    </Modal>
  </div>;
};

export default ControlOrchestratorPage;
