import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  Descriptions,
  Form,
  Input,
  InputNumber,
  List,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../adapters';
import type {
  AgcDerivedOutputs,
  AgcGroupConfig,
  AgcGroupInfo,
  AgcMemberConfig,
  AgcSignalSpec,
  AgcValueSpec,
  DcEndpoint,
} from '../../adapters';
import { CONTROL_VIEW_QUERY_KEY, normalizeControlView } from '../../components/control/control-view';
import {
  ControlGroupRoutesError,
  buildControlDataBusRoutes,
  saveControlGroupWithOptionalRoutes,
} from '../../utils/control-auto-routing';
import type { ControlDataBusBinding } from '../../utils/control-auto-routing';
import { RuntimeRestartError, formatErrorText, runWithRuntimeRestart } from '../../utils/runtime-restart';

const { Text } = Typography;

const AGC_MODULE_NAME = 'AGC';

const STATE_MAP: Record<number, { label: string; color: string }> = {
  0: { label: 'UNSPECIFIED', color: 'default' },
  1: { label: 'STOPPED', color: 'red' },
  2: { label: 'RUNNING', color: 'green' },
  3: { label: 'PENDING_DELETE', color: 'orange' },
};

const VALUE_MODE_LABELS: Record<number, string> = {
  0: 'UNSPECIFIED',
  1: 'ABSOLUTE (绝对值)',
  2: 'DELTA (增量)',
};

const DELTA_BASE_LABELS: Record<number, string> = {
  0: 'UNSPECIFIED',
  1: 'LAST_TARGET',
  2: 'CURRENT_MEAS',
  3: 'BASE_TAG',
};

const DEFAULT_SIGNAL: AgcSignalSpec = {
  tag: '',
  unit: 'kW',
  scale: 1,
  offset: 0,
};

const DEFAULT_MEMBER: AgcMemberConfig = {
  member_name: '',
  controllable: true,
  capacity_kw: 0,
  weight: 1,
  min_kw: 0,
  max_kw: 0,
  p_meas: { ...DEFAULT_SIGNAL },
  p_set: {
    signal: { ...DEFAULT_SIGNAL },
    mode: 1,
    delta_base: 0,
    base_tag: '',
  },
};

const buildEmptyConfig = (): AgcGroupConfig => ({
  group_name: '控制组1',
  p_cmd: {
    signal: { ...DEFAULT_SIGNAL, tag: 'AGC总控点' },
    mode: 1,
    delta_base: 0,
    base_tag: '',
  },
  strategy: { strategy_type: 'weighted' },
  members: [],
  outputs: {
    p_total_meas: { ...DEFAULT_SIGNAL, tag: 'AGC总有功测量点' },
    p_total_target: { ...DEFAULT_SIGNAL, tag: 'AGC总有功目标点' },
    p_total_error: { ...DEFAULT_SIGNAL, tag: 'AGC总有功偏差点' },
  },
});

const cloneSignal = (signal: AgcSignalSpec | null | undefined): AgcSignalSpec => ({
  tag: signal?.tag ?? '',
  unit: signal?.unit ?? '',
  scale: signal?.scale ?? 1,
  offset: signal?.offset ?? 0,
});

const cloneValueSpec = (spec: AgcValueSpec | null | undefined): AgcValueSpec => ({
  signal: cloneSignal(spec?.signal),
  mode: spec?.mode ?? 1,
  delta_base: spec?.delta_base ?? 0,
  base_tag: spec?.base_tag ?? '',
});

const cloneMember = (member: AgcMemberConfig | null | undefined): AgcMemberConfig => ({
  member_name: member?.member_name ?? '',
  controllable: member?.controllable ?? true,
  capacity_kw: member?.capacity_kw ?? 0,
  weight: member?.weight ?? 1,
  min_kw: member?.min_kw ?? 0,
  max_kw: member?.max_kw ?? 0,
  p_meas: cloneSignal(member?.p_meas),
  p_set: cloneValueSpec(member?.p_set),
});

const cloneOutputs = (outputs: AgcDerivedOutputs | null | undefined): AgcDerivedOutputs => ({
  p_total_meas: cloneSignal(outputs?.p_total_meas),
  p_total_target: cloneSignal(outputs?.p_total_target),
  p_total_error: cloneSignal(outputs?.p_total_error),
});

const formatSignal = (signal: AgcSignalSpec | null | undefined): string => {
  if (!signal?.tag) return '-';
  const unitPart = signal.unit ? ` (${signal.unit})` : '';
  return `${signal.tag}${unitPart} | scale=${signal.scale}, offset=${signal.offset}`;
};

const formatValueSpec = (spec: AgcValueSpec | null | undefined): string => {
  if (!spec?.signal?.tag) return '-';
  const basePart = spec.mode === 2
    ? `, base=${DELTA_BASE_LABELS[spec.delta_base] ?? spec.delta_base}${spec.delta_base === 3 && spec.base_tag ? `:${spec.base_tag}` : ''}`
    : '';
  return `${formatSignal(spec.signal)} | ${VALUE_MODE_LABELS[spec.mode] ?? spec.mode}${basePart}`;
};

const normalizeSignal = (signal: AgcSignalSpec | null | undefined): AgcSignalSpec | null => {
  if (!signal) return null;
  if (!signal.tag.trim()) return null;
  return {
    tag: signal.tag.trim(),
    unit: signal.unit.trim(),
    scale: signal.scale ?? 1,
    offset: signal.offset ?? 0,
  };
};

const normalizeValueSpec = (spec: AgcValueSpec | null | undefined): AgcValueSpec | null => {
  if (!spec) return null;
  const signal = normalizeSignal(spec.signal);
  if (!signal) return null;
  return {
    signal,
    mode: spec.mode ?? 0,
    delta_base: spec.mode === 2 ? (spec.delta_base ?? 0) : 0,
    base_tag: spec.mode === 2 && spec.delta_base === 3 ? spec.base_tag.trim() : '',
  };
};

const normalizeOutputs = (outputs: AgcDerivedOutputs | null | undefined): AgcDerivedOutputs | null => {
  if (!outputs) return null;
  return {
    p_total_meas: normalizeSignal(outputs.p_total_meas),
    p_total_target: normalizeSignal(outputs.p_total_target),
    p_total_error: normalizeSignal(outputs.p_total_error),
  };
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const buildDefaultMemberTag = (memberName: string, kind: 'p_meas' | 'p_set'): string => {
  const normalizedMemberName = memberName
    .trim()
    .replace(/[\\/:]/g, '_')
    .replace(/\s+/g, '_');
  if (!normalizedMemberName) return '';
  const suffix = kind === 'p_meas' ? '有功功率测量' : '有功功率设定';
  return `${normalizedMemberName}_${suffix}`;
};

const findDuplicateGroupEndpointTags = (config: AgcGroupConfig): string[] => {
  const tagOwners = new Map<string, string[]>();
  const collectTag = (tag: string | null | undefined, owner: string) => {
    const normalizedTag = tag?.trim();
    if (!normalizedTag) return;
    const owners = tagOwners.get(normalizedTag) ?? [];
    owners.push(owner);
    tagOwners.set(normalizedTag, owners);
  };

  collectTag(config.p_cmd?.signal?.tag, 'p_cmd');
  config.members.forEach((member, index) => {
    const memberLabel = member.member_name.trim() || `member #${index + 1}`;
    collectTag(member.p_meas?.tag, `${memberLabel}.p_meas`);
    collectTag(member.p_set?.signal?.tag, `${memberLabel}.p_set`);
  });
  collectTag(config.outputs?.p_total_meas?.tag, 'outputs.p_total_meas');
  collectTag(config.outputs?.p_total_target?.tag, 'outputs.p_total_target');
  collectTag(config.outputs?.p_total_error?.tag, 'outputs.p_total_error');

  return Array.from(tagOwners.entries())
    .filter(([, owners]) => owners.length > 1)
    .map(([tag, owners]) => `${tag} (${owners.join(', ')})`);
};

type DataBusEndpointOption = {
  value: string;
  label: string;
  tag: string;
  moduleName: string;
  connName: string;
};

type DataBusConnectionOption = {
  value: string;
  label: string;
  memberName: string;
};

type MemberTagPickerKey = 'p_meas' | 'p_set' | 'base_tag';

type MemberRouteDraft = {
  createRoutes: boolean;
  endpoints: Partial<Record<MemberTagPickerKey, DcEndpoint>>;
};

const buildDataBusEndpointValue = (endpoint: DcEndpoint): string => JSON.stringify([
  endpoint.module_name,
  endpoint.conn_name,
  endpoint.tag,
]);

const AGC: React.FC = () => {
  const [groups, setGroups] = useState<AgcGroupInfo[]>([]);
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [memberModalOpen, setMemberModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<AgcGroupConfig | null>(null);
  const [editingMemberIndex, setEditingMemberIndex] = useState<number | null>(null);
  const [membersDraft, setMembersDraft] = useState<AgcMemberConfig[]>([]);
  const [memberRouteDrafts, setMemberRouteDrafts] = useState<MemberRouteDraft[]>([]);
  const [dataBusConnectionOptions, setDataBusConnectionOptions] = useState<DataBusConnectionOption[]>([]);
  const [dataBusEndpointOptions, setDataBusEndpointOptions] = useState<DataBusEndpointOption[]>([]);
  const [dataBusEndpointLoading, setDataBusEndpointLoading] = useState(false);
  const [memberConnectionPickerValue, setMemberConnectionPickerValue] = useState<string>();
  const [createMemberRoutes, setCreateMemberRoutes] = useState(false);
  const [memberRouteEndpoints, setMemberRouteEndpoints] = useState<
    Partial<Record<MemberTagPickerKey, DcEndpoint>>
  >({});
  const [memberTagPickerValues, setMemberTagPickerValues] = useState<
    Partial<Record<MemberTagPickerKey, string>>
  >({});
  const [messageApi, contextHolder] = message.useMessage();
  const [groupForm] = Form.useForm<AgcGroupConfig>();
  const [memberForm] = Form.useForm<AgcMemberConfig>();
  const [searchParams] = useSearchParams();

  const selectedGroup = useMemo(
    () => groups.find((item) => item.config?.group_name === selectedGroupName) ?? null,
    [groups, selectedGroupName],
  );

  const getGroupState = useCallback(async (groupName: string): Promise<number | null> => {
    const group = await api.agcGetGroup(groupName);
    return group.state;
  }, []);

  const runSelectedGroupStopped = useCallback(
    async (operation: () => Promise<void>, groupName: string) => {
      if (!selectedGroupName) {
        await operation();
        return {
          stoppedBeforeRun: false,
          restartedAfterRun: false,
          retriedAfterRunningPrecondition: false,
          restartError: null,
        };
      }

      const originalGroupName = editingGroup?.group_name ?? groupName;
      return runWithRuntimeRestart({
        initialState: selectedGroup?.state ?? null,
        loadState: () => getGroupState(originalGroupName),
        stop: () => api.agcStopGroup(originalGroupName),
        run: operation,
        start: () => api.agcStartGroup(groupName),
        restoreStart: () => api.agcStartGroup(originalGroupName),
        failOnRestartError: false,
      });
    },
    [editingGroup?.group_name, getGroupState, selectedGroup?.state, selectedGroupName],
  );

  const refreshGroups = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.agcListGroups();
      setGroups(list);
      setSelectedGroupName((prev) => {
        if (prev && list.some((item) => item.config?.group_name === prev)) {
          return prev;
        }
        return list[0]?.config?.group_name ?? null;
      });
    } catch (e) {
      messageApi.error(`刷新控制组失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups]);

  const refreshDataBusEndpointOptions = useCallback(async () => {
    setDataBusEndpointLoading(true);
    try {
      const connections = await api.dcListConnections();
      setDataBusConnectionOptions(
        connections
          .map((connection) => ({
            value: String(connection.conn_id),
            label: `${connection.module_name}/${connection.conn_name}`,
            memberName: connection.conn_name,
          }))
          .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN')),
      );
      const endpointGroups = await Promise.all(
        connections.map(async (connection) => {
          try {
            const connTags = await api.dcGetConnTags(connection.conn_id);
            return connTags.tags.map((tag) => ({
              value: buildDataBusEndpointValue({
                module_name: connection.module_name,
                conn_name: connection.conn_name,
                tag,
              }),
              label: `${connection.module_name}/${connection.conn_name} : ${tag}`,
              tag,
              moduleName: connection.module_name,
              connName: connection.conn_name,
            }));
          } catch {
            return [];
          }
        }),
      );

      setDataBusEndpointOptions(
        endpointGroups
          .flat()
          .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN')),
      );
    } catch {
      setDataBusConnectionOptions([]);
      setDataBusEndpointOptions([]);
    } finally {
      setDataBusEndpointLoading(false);
    }
  }, []);

  const handleSelectMemberConnection = useCallback(
    (connectionValue: string | undefined) => {
      setMemberConnectionPickerValue(connectionValue);
      if (!connectionValue) return;

      const selected = dataBusConnectionOptions.find((item) => item.value === connectionValue);
      if (!selected) return;
      const previousMemberName = String(memberForm.getFieldValue('member_name') ?? '').trim();
      const currentPMeasTag = String(memberForm.getFieldValue(['p_meas', 'tag']) ?? '').trim();
      const currentPSetTag = String(memberForm.getFieldValue(['p_set', 'signal', 'tag']) ?? '').trim();
      memberForm.setFieldValue('member_name', selected.memberName);
      const previousPMeasTag = buildDefaultMemberTag(previousMemberName, 'p_meas');
      if (!currentPMeasTag || (previousPMeasTag && currentPMeasTag === previousPMeasTag)) {
        memberForm.setFieldValue(['p_meas', 'tag'], buildDefaultMemberTag(selected.memberName, 'p_meas'));
      }
      const previousPSetTag = buildDefaultMemberTag(previousMemberName, 'p_set');
      if (!currentPSetTag || (previousPSetTag && currentPSetTag === previousPSetTag)) {
        memberForm.setFieldValue(['p_set', 'signal', 'tag'], buildDefaultMemberTag(selected.memberName, 'p_set'));
      }
    },
    [dataBusConnectionOptions, memberForm],
  );

  const handleSelectMemberEndpoint = useCallback(
    (picker: MemberTagPickerKey, endpointValue: string | undefined) => {
      setMemberTagPickerValues((prev) => ({ ...prev, [picker]: endpointValue }));
      if (!endpointValue) {
        setMemberRouteEndpoints((prev) => {
          const next = { ...prev };
          delete next[picker];
          return next;
        });
        return;
      }

      const selected = dataBusEndpointOptions.find((item) => item.value === endpointValue);
      if (!selected) return;
      setMemberRouteEndpoints((prev) => ({
        ...prev,
        [picker]: {
          module_name: selected.moduleName,
          conn_name: selected.connName,
          tag: selected.tag,
        },
      }));
      const memberName = String(memberForm.getFieldValue('member_name') ?? '').trim();
      if (!memberName) {
        memberForm.setFieldValue('member_name', selected.connName);
      }

      if (picker === 'p_meas') {
        memberForm.setFieldValue(['p_meas', 'tag'], selected.tag);
        return;
      }

      if (picker === 'p_set') {
        memberForm.setFieldValue(['p_set', 'signal', 'tag'], selected.tag);
        return;
      }

      memberForm.setFieldValue(['p_set', 'base_tag'], selected.tag);
    },
    [dataBusEndpointOptions, memberForm],
  );

  const handleSelectGroup = useCallback((groupName: string) => {
    setSelectedGroupName(groupName);
  }, []);

  const openCreateGroup = useCallback(() => {
    setEditingGroup(null);
    setMembersDraft([]);
    setMemberRouteDrafts([]);
    groupForm.resetFields();
    groupForm.setFieldsValue(buildEmptyConfig());
    setGroupModalOpen(true);
  }, [groupForm]);

  const openEditGroup = useCallback(() => {
    if (!selectedGroup?.config) return;
    const config: AgcGroupConfig = {
      group_name: selectedGroup.config.group_name,
      p_cmd: cloneValueSpec(selectedGroup.config.p_cmd),
      strategy: { strategy_type: selectedGroup.config.strategy?.strategy_type ?? 'weighted' },
      members: selectedGroup.config.members.map((member) => cloneMember(member)),
      outputs: cloneOutputs(selectedGroup.config.outputs),
    };
    setEditingGroup(config);
    setMembersDraft(config.members);
    setMemberRouteDrafts(config.members.map(() => ({ createRoutes: false, endpoints: {} })));
    groupForm.resetFields();
    groupForm.setFieldsValue({
      group_name: config.group_name,
      p_cmd: config.p_cmd,
      strategy: config.strategy,
      members: config.members,
      outputs: config.outputs,
    });
    setGroupModalOpen(true);
  }, [groupForm, selectedGroup]);

  const handleDeleteGroup = useCallback(async (groupName: string) => {
    try {
      await api.agcDeleteGroup(groupName);
      messageApi.success(`控制组 ${groupName} 已删除`);
      if (selectedGroupName === groupName) {
        setSelectedGroupName(null);
      }
      await refreshGroups();
    } catch (e) {
      messageApi.error(`删除控制组失败: ${e}`);
    }
  }, [messageApi, refreshGroups, selectedGroupName]);

  const handleStartGroup = useCallback(async () => {
    if (!selectedGroupName) return;
    try {
      await api.agcStartGroup(selectedGroupName);
      messageApi.success('启动请求已发送');
      setTimeout(() => void refreshGroups(), 1000);
    } catch (e) {
      messageApi.error(`启动失败: ${e}`);
    }
  }, [messageApi, refreshGroups, selectedGroupName]);

  const handleStopGroup = useCallback(async () => {
    if (!selectedGroupName) return;
    try {
      await api.agcStopGroup(selectedGroupName);
      messageApi.success('停止请求已发送');
      setTimeout(() => void refreshGroups(), 1000);
    } catch (e) {
      messageApi.error(`停止失败: ${e}`);
    }
  }, [messageApi, refreshGroups, selectedGroupName]);

  const handleGroupSubmit = useCallback(async () => {
    let submittedConfig: AgcGroupConfig | null = null;
    try {
      const values = await groupForm.validateFields();
      const config: AgcGroupConfig = {
        group_name: values.group_name.trim(),
        p_cmd: normalizeValueSpec(values.p_cmd),
        strategy: { strategy_type: values.strategy?.strategy_type ?? 'weighted' },
        members: membersDraft.map((member) => ({
          member_name: member.member_name.trim(),
          controllable: member.controllable,
          capacity_kw: member.capacity_kw,
          weight: member.weight,
          min_kw: member.min_kw,
          max_kw: member.max_kw,
          p_meas: normalizeSignal(member.p_meas),
          p_set: normalizeValueSpec(member.p_set),
        })),
        outputs: normalizeOutputs(values.outputs),
      };
      submittedConfig = config;
      const duplicateTags = findDuplicateGroupEndpointTags(config);
      if (duplicateTags.length > 0) {
        throw new Error(`同一控制组内 DataBus tag 不能重复: ${duplicateTags.join('；')}`);
      }
      const routeBindings = memberRouteDrafts.flatMap<ControlDataBusBinding>((routeDraft, index) => {
        if (!routeDraft?.createRoutes) return [];
        const member = config.members[index];
        if (!member) return [];

        const bindings: ControlDataBusBinding[] = [];
        if (routeDraft.endpoints.p_meas && member.p_meas?.tag) {
          bindings.push({
            direction: 'input',
            groupTag: member.p_meas.tag,
            external: routeDraft.endpoints.p_meas,
          });
        }
        if (member.controllable && routeDraft.endpoints.p_set && member.p_set?.signal?.tag) {
          bindings.push({
            direction: 'output',
            groupTag: member.p_set.signal.tag,
            external: routeDraft.endpoints.p_set,
          });
        }
        if (
          member.controllable
          && routeDraft.endpoints.base_tag
          && member.p_set?.mode === 2
          && member.p_set.delta_base === 3
          && member.p_set.base_tag
        ) {
          bindings.push({
            direction: 'input',
            groupTag: member.p_set.base_tag,
            external: routeDraft.endpoints.base_tag,
          });
        }
        return bindings;
      });
      const routes = buildControlDataBusRoutes({
        moduleName: AGC_MODULE_NAME,
        groupName: config.group_name,
        bindings: routeBindings,
      });
      const createOnly = !editingGroup;
      let routesSubmitted = 0;
      const saveGroup = async () => {
        const result = await saveControlGroupWithOptionalRoutes({
          createRoutes: routes.length > 0,
          routes,
          saveGroup: () => api.agcUpsertGroup(config, createOnly),
          saveRoutes: (nextRoutes) => api.dcUpsertRoutes(nextRoutes, false),
        });
        routesSubmitted = result.routesSubmitted;
      };
      const restartResult = createOnly
        ? await runWithRuntimeRestart({
          initialState: null,
          stop: () => api.agcStopGroup(config.group_name),
          run: saveGroup,
          start: () => api.agcStartGroup(config.group_name),
          failOnRestartError: false,
        })
        : await runSelectedGroupStopped(saveGroup, config.group_name);
      console.info('AGC 控制组保存完成', {
        groupName: config.group_name,
        routeCount: routesSubmitted,
      });
      if (restartResult.restartError) {
        messageApi.warning(
          routesSubmitted > 0
            ? `控制组配置和 ${routesSubmitted} 条 DataCenter 路由已保存，但重新启动失败: ${formatErrorText(restartResult.restartError)}`
            : `控制组配置已保存，但重新启动失败: ${formatErrorText(restartResult.restartError)}`,
        );
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success(
          routesSubmitted > 0
            ? `控制组已更新，提交 ${routesSubmitted} 条 DataCenter 路由并重新启动成功`
            : '控制组已更新并重新启动成功',
        );
      } else {
        const savedText = createOnly ? '控制组创建成功' : '控制组更新成功';
        messageApi.success(
          routesSubmitted > 0
            ? `${savedText}，并提交 ${routesSubmitted} 条 DataCenter 路由`
            : savedText,
        );
      }
      setGroupModalOpen(false);
      await refreshGroups();
      setSelectedGroupName(config.group_name);
    } catch (e) {
      const routeSaveError = e instanceof ControlGroupRoutesError
        ? e
        : e instanceof RuntimeRestartError && e.operationError instanceof ControlGroupRoutesError
          ? e.operationError
          : null;
      if (routeSaveError) {
        const restartError = e instanceof RuntimeRestartError ? e.restartError : null;
        const formConfig = groupForm.getFieldsValue(true);
        const groupName = submittedConfig?.group_name ?? String(formConfig.group_name ?? '').trim();
        console.error('AGC 控制组已保存，但创建 DataCenter 路由失败', {
          groupName,
          error: routeSaveError.routeError,
          restartError,
        });
        messageApi.error(`控制组已保存，路由创建失败: ${formatErrorText(routeSaveError.routeError)}`);
        if (restartError) {
          messageApi.warning(`控制组恢复运行失败: ${formatErrorText(restartError)}`);
        }
        if (submittedConfig) {
          const savedConfig = submittedConfig;
          setGroups((prev) => prev.map((group) => (
            group.config?.group_name === groupName
              ? { ...group, config: savedConfig }
              : group
          )));
        }
        setGroupModalOpen(false);
        await refreshGroups();
        setSelectedGroupName(groupName);
        return;
      }
      messageApi.error(`操作失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [
    editingGroup,
    groupForm,
    memberRouteDrafts,
    membersDraft,
    messageApi,
    refreshGroups,
    runSelectedGroupStopped,
  ]);

  const openCreateMember = useCallback(() => {
    setEditingMemberIndex(null);
    setMemberConnectionPickerValue(undefined);
    setMemberTagPickerValues({});
    setCreateMemberRoutes(false);
    setMemberRouteEndpoints({});
    memberForm.resetFields();
    memberForm.setFieldsValue(cloneMember(DEFAULT_MEMBER));
    setMemberModalOpen(true);
    void refreshDataBusEndpointOptions();
  }, [memberForm, refreshDataBusEndpointOptions]);

  const openEditMember = useCallback((index: number) => {
    const member = membersDraft[index];
    if (!member) return;
    const routeDraft = memberRouteDrafts[index];
    const routeEndpoints = routeDraft?.endpoints ?? {};
    setEditingMemberIndex(index);
    setMemberConnectionPickerValue(undefined);
    setMemberTagPickerValues({
      p_meas: routeEndpoints.p_meas
        ? buildDataBusEndpointValue(routeEndpoints.p_meas)
        : undefined,
      p_set: routeEndpoints.p_set
        ? buildDataBusEndpointValue(routeEndpoints.p_set)
        : undefined,
      base_tag: routeEndpoints.base_tag
        ? buildDataBusEndpointValue(routeEndpoints.base_tag)
        : undefined,
    });
    setCreateMemberRoutes(routeDraft?.createRoutes ?? false);
    setMemberRouteEndpoints(routeEndpoints);
    memberForm.resetFields();
    memberForm.setFieldsValue(cloneMember(member));
    setMemberModalOpen(true);
    void refreshDataBusEndpointOptions();
  }, [memberForm, memberRouteDrafts, membersDraft, refreshDataBusEndpointOptions]);

  const handleMemberSubmit = useCallback(async () => {
    try {
      const values = await memberForm.validateFields();
      const nextMember: AgcMemberConfig = {
        member_name: values.member_name.trim(),
        controllable: values.controllable ?? true,
        capacity_kw: values.capacity_kw ?? 0,
        weight: values.weight ?? 1,
        min_kw: values.min_kw ?? 0,
        max_kw: values.max_kw ?? 0,
        p_meas: cloneSignal(values.p_meas),
        p_set: cloneValueSpec(values.p_set),
      };
      const nextRouteDraft: MemberRouteDraft = {
        createRoutes: createMemberRoutes,
        endpoints: { ...memberRouteEndpoints },
      };
      setMembersDraft((prev) => {
        if (editingMemberIndex === null) {
          return [...prev, nextMember];
        }
        return prev.map((member, index) => (index === editingMemberIndex ? nextMember : member));
      });
      setMemberRouteDrafts((prev) => {
        if (editingMemberIndex === null) {
          return [...prev, nextRouteDraft];
        }
        const next = [...prev];
        next[editingMemberIndex] = nextRouteDraft;
        return next;
      });
      setMemberModalOpen(false);
    } catch (e) {
      messageApi.error(`成员保存失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [createMemberRoutes, editingMemberIndex, memberForm, memberRouteEndpoints, messageApi]);

  const handleDeleteMember = useCallback((index: number) => {
    setMembersDraft((prev) => prev.filter((_item, itemIndex) => itemIndex !== index));
    setMemberRouteDrafts((prev) => prev.filter((_item, itemIndex) => itemIndex !== index));
  }, []);

  const memberColumns: ColumnsType<AgcMemberConfig> = [
    {
      title: '成员名称',
      dataIndex: 'member_name',
      key: 'member_name',
      width: 180,
      render: (value: string) => <Text strong>{value}</Text>,
    },
    {
      title: '权重',
      dataIndex: 'weight',
      key: 'weight',
      width: 90,
    },
    {
      title: 'p_min (kW)',
      dataIndex: 'min_kw',
      key: 'min_kw',
      width: 110,
    },
    {
      title: 'p_max (kW)',
      dataIndex: 'max_kw',
      key: 'max_kw',
      width: 110,
    },
    {
      title: 'p_meas tag',
      key: 'p_meas',
      width: 180,
      render: (_, record) => record.p_meas?.tag || '-',
    },
    {
      title: 'p_set tag',
      key: 'p_set',
      width: 180,
      render: (_, record) => record.p_set?.signal?.tag || '-',
    },
    {
      title: '可控',
      key: 'controllable',
      width: 100,
      render: (_, record) => (
        <Tag color={record.controllable ? 'green' : 'default'}>
          {record.controllable ? 'YES' : 'NO'}
        </Tag>
      ),
    },
  ];

  const modalMemberColumns: ColumnsType<AgcMemberConfig> = [
    ...memberColumns,
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_, __, index) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEditMember(index)}
          />
          <Popconfirm title="确认删除该成员？" onConfirm={() => handleDeleteMember(index)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const stateInfo = STATE_MAP[selectedGroup?.state ?? 0] ?? STATE_MAP[0];
  const selectedConfig = selectedGroup?.config ?? null;
  const currentView = normalizeControlView(searchParams.get(CONTROL_VIEW_QUERY_KEY));

  const runtimeRows = [
    {
      label: 'p_total_meas',
      signal: selectedConfig?.outputs?.p_total_meas,
    },
    {
      label: 'p_total_target',
      signal: selectedConfig?.outputs?.p_total_target,
    },
    {
      label: 'p_total_error',
      signal: selectedConfig?.outputs?.p_total_error,
    },
  ];

  return (
    <div className="protocol-page">
      {contextHolder}

      {currentView === 'strategy' ? (
        <div
          style={{
            display: 'flex',
            flex: '1 1 auto',
            gap: 16,
            alignItems: 'stretch',
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <Card
            title="控制组列表"
            size="small"
            bordered
            style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}
            styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', padding: '8px 0' } }}
            extra={
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={() => void refreshGroups()}
              />
            }
          >
            <div style={{ flex: 1, overflow: 'auto' }}>
              <List
                dataSource={groups}
                locale={{ emptyText: '暂无控制组' }}
                renderItem={(item) => {
                  const groupName = item.config?.group_name ?? `group_${item.conn_id}`;
                  const isActive = groupName === selectedGroupName;
                  const color = item.state === 2 ? '#4caf50' : item.state === 3 ? '#ff9800' : '#f44336';
                  return (
                    <List.Item
                      onClick={() => handleSelectGroup(groupName)}
                      style={{
                        cursor: 'pointer',
                        padding: '8px 16px',
                        background: isActive ? '#37373d' : 'transparent',
                      }}
                    >
                      <Space size={10} style={{ width: '100%', justifyContent: 'space-between' }}>
                        <Space size={10}>
                          <span
                            style={{
                              display: 'inline-block',
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: color,
                            }}
                          />
                          <Text style={{ color: '#fff' }}>{groupName}</Text>
                        </Space>
                        <Tag color={STATE_MAP[item.state]?.color ?? 'default'} style={{ marginInlineEnd: 0 }}>
                          {STATE_MAP[item.state]?.label ?? 'UNKNOWN'}
                        </Tag>
                      </Space>
                    </List.Item>
                  );
                }}
              />
            </div>
            <div style={{ padding: '8px 12px', borderTop: '1px solid #3e3e42' }}>
              <Button block icon={<PlusOutlined />} onClick={openCreateGroup}>
                + 新增控制组
              </Button>
            </div>
          </Card>

          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              minWidth: 0,
              minHeight: 0,
              overflow: 'hidden',
            }}
          >
            <div className="protocol-top-row" style={{ flex: '0 1 320px', minHeight: 220 }}>
              <Card
                title="组配置"
                size="small"
                bordered
                className="protocol-log-card"
                style={{ flex: 1, minHeight: 0 }}
                extra={
                  selectedConfig ? (
                    <Space>
                      <Button type="link" size="small" icon={<EditOutlined />} onClick={openEditGroup}>
                        编辑
                      </Button>
                      <Popconfirm
                        title={`确认删除 ${selectedConfig.group_name}？`}
                        onConfirm={() => void handleDeleteGroup(selectedConfig.group_name)}
                      >
                        <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  ) : undefined
                }
              >
                <div className="protocol-log-scroll">
                  {selectedConfig ? (
                    <Descriptions size="small" column={2}>
                      <Descriptions.Item label="group_name">{selectedConfig.group_name}</Descriptions.Item>
                      <Descriptions.Item label="conn_id">{selectedGroup?.conn_id ?? '-'}</Descriptions.Item>
                      <Descriptions.Item label="p_cmd" span={2}>{formatValueSpec(selectedConfig.p_cmd)}</Descriptions.Item>
                      <Descriptions.Item label="strategy_type">
                        {selectedConfig.strategy?.strategy_type ?? '-'}
                      </Descriptions.Item>
                      <Descriptions.Item label="enable state">
                        <Tag color={stateInfo.color}>{stateInfo.label}</Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label="input description" span={2}>
                        {selectedConfig.p_cmd?.signal?.tag
                          ? `输入命令来自 ${selectedConfig.p_cmd.signal.tag}，按 ${VALUE_MODE_LABELS[selectedConfig.p_cmd.mode] ?? selectedConfig.p_cmd.mode} 方式解释。`
                          : '-'}
                      </Descriptions.Item>
                      <Descriptions.Item label="output description" span={2}>
                        {selectedConfig.outputs
                          ? `总测量=${selectedConfig.outputs.p_total_meas?.tag || '-'}；总目标=${selectedConfig.outputs.p_total_target?.tag || '-'}；误差=${selectedConfig.outputs.p_total_error?.tag || '-'}。`
                          : '-'}
                      </Descriptions.Item>
                    </Descriptions>
                  ) : (
                    <Text type="secondary">请先在左侧选择控制组</Text>
                  )}
                </div>
              </Card>

              <Card
                title="运行状态"
                size="small"
                bordered
                className="protocol-log-card"
                style={{ width: 300, flexShrink: 0, minHeight: 0 }}
              >
                <div className="protocol-log-scroll">
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <div>
                      <Text type="secondary" style={{ marginRight: 12 }}>当前状态</Text>
                      <Tag color={stateInfo.color}>{stateInfo.label}</Tag>
                    </div>
                    <div>
                      <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>运行控制</Text>
                      <Space wrap>
                        <Button
                          type="primary"
                          icon={<PlayCircleOutlined />}
                          style={{ background: '#4caf50', borderColor: '#4caf50' }}
                          disabled={!selectedGroupName}
                          onClick={() => void handleStartGroup()}
                        >
                          启动
                        </Button>
                        <Button
                          danger
                          icon={<PauseCircleOutlined />}
                          disabled={!selectedGroupName}
                          onClick={() => void handleStopGroup()}
                        >
                          停止
                        </Button>
                      </Space>
                    </div>
                    {runtimeRows.map((item) => (
                      <div key={item.label}>
                        <Text type="secondary" style={{ display: 'block' }}>{item.label}</Text>
                        <Text>{item.signal?.tag || '-'} — 接入实时数据后渲染</Text>
                      </div>
                    ))}
                    <div>
                      <Text type="secondary" style={{ display: 'block' }}>last_error</Text>
                      <Text>{selectedGroup?.last_error || '— 接入实时数据后渲染'}</Text>
                    </div>
                  </Space>
                </div>
              </Card>
            </div>

            <Card
              title="成员配置"
              size="small"
              bordered
              className="protocol-point-card"
            >
              <div className="protocol-table-scroll">
                <Table
                  rowKey={(record, index) => `${record.member_name}-${index}`}
                  columns={memberColumns}
                  dataSource={selectedConfig?.members ?? []}
                  pagination={false}
                  size="small"
                  locale={{ emptyText: selectedConfig ? '暂无成员配置' : '请先选择控制组' }}
                />
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <Card
          title="控制日志"
          size="small"
          bordered
          className="protocol-log-card"
        >
          <div className="protocol-log-scroll">
            <div className="protocol-log-console">
              <div>[AGC] --:--:--.--- {selectedGroupName ?? '<group>'} - 控制日志 — 接入实时数据后渲染</div>
              <div className="protocol-log-line--hint">
                等待实时控制回路、状态回写与告警事件接入后显示详细日志...
              </div>
            </div>
          </div>
        </Card>
      )}

      <Modal
        title={editingGroup ? '编辑控制组' : '新增控制组'}
        open={groupModalOpen}
        onOk={() => void handleGroupSubmit()}
        onCancel={() => setGroupModalOpen(false)}
        width={1080}
        destroyOnClose
      >
        <Form form={groupForm} layout="vertical" size="small">
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <Form.Item
                name="group_name"
                label="group_name"
                rules={[{ required: true, message: '请输入控制组名称' }]}
              >
                <Input disabled={!!editingGroup} placeholder="agc_group_1" />
              </Form.Item>
            </div>
            <div style={{ width: 220 }}>
              <Form.Item name={['strategy', 'strategy_type']} label="strategy_type">
                <Select options={[{ value: 'weighted', label: 'weighted' }]} />
              </Form.Item>
            </div>
          </div>

          <Card title="p_cmd" size="small" bordered style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <Form.Item name={['p_cmd', 'signal', 'tag']} label="tag">
                  <Input placeholder="agc_cmd_tag" />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['p_cmd', 'signal', 'unit']} label="unit">
                  <Input placeholder="kW" />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['p_cmd', 'signal', 'scale']} label="scale">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['p_cmd', 'signal', 'offset']} label="offset">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ width: 260 }}>
                <Form.Item name={['p_cmd', 'mode']} label="mode">
                  <Select
                    options={Object.entries(VALUE_MODE_LABELS).map(([value, label]) => ({
                      value: Number(value),
                      label,
                    }))}
                  />
                </Form.Item>
              </div>
              <Form.Item noStyle shouldUpdate>
                {({ getFieldValue }) => {
                  const mode = getFieldValue(['p_cmd', 'mode']);
                  const deltaBase = getFieldValue(['p_cmd', 'delta_base']);
                  return mode === 2 ? (
                    <>
                      <div style={{ width: 260 }}>
                        <Form.Item name={['p_cmd', 'delta_base']} label="delta_base">
                          <Select
                            options={Object.entries(DELTA_BASE_LABELS).map(([value, label]) => ({
                              value: Number(value),
                              label,
                            }))}
                          />
                        </Form.Item>
                      </div>
                      {deltaBase === 3 ? (
                        <div style={{ flex: 1 }}>
                          <Form.Item name={['p_cmd', 'base_tag']} label="base_tag">
                            <Input placeholder="base_power_tag" />
                          </Form.Item>
                        </div>
                      ) : null}
                    </>
                  ) : null;
                }}
              </Form.Item>
            </div>
          </Card>

          <Card title="派生输出 (outputs)" size="small" bordered style={{ marginBottom: 16 }}>
            {[
              { key: 'p_total_meas', label: 'p_total_meas' },
              { key: 'p_total_target', label: 'p_total_target' },
              { key: 'p_total_error', label: 'p_total_error' },
            ].map((item) => (
              <div key={item.key} style={{ display: 'flex', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <Form.Item name={['outputs', item.key, 'tag']} label={`${item.label} tag`}>
                    <Input placeholder={item.label} />
                  </Form.Item>
                </div>
                <div style={{ width: 140 }}>
                  <Form.Item name={['outputs', item.key, 'unit']} label="unit">
                    <Input placeholder="kW" />
                  </Form.Item>
                </div>
                <div style={{ width: 140 }}>
                  <Form.Item name={['outputs', item.key, 'scale']} label="scale">
                    <InputNumber step={0.01} style={{ width: '100%' }} />
                  </Form.Item>
                </div>
                <div style={{ width: 140 }}>
                  <Form.Item name={['outputs', item.key, 'offset']} label="offset">
                    <InputNumber step={0.01} style={{ width: '100%' }} />
                  </Form.Item>
                </div>
              </div>
            ))}
          </Card>

          <Card
            title="成员配置"
            size="small"
            bordered
            extra={
              <Button size="small" icon={<PlusOutlined />} onClick={openCreateMember}>
                添加成员
              </Button>
            }
          >
            <Table
              rowKey={(record, index) => `${record.member_name}-${index}`}
              columns={modalMemberColumns}
              dataSource={membersDraft}
              pagination={false}
              size="small"
              locale={{ emptyText: '暂无成员，请添加' }}
            />
          </Card>
        </Form>
      </Modal>

      <Modal
        title={editingMemberIndex === null ? '添加成员' : '编辑成员'}
        open={memberModalOpen}
        onOk={() => void handleMemberSubmit()}
        onCancel={() => setMemberModalOpen(false)}
        width={920}
        destroyOnClose
      >
        <Form form={memberForm} layout="vertical" size="small">
          <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
            可从数据总线快速选择成员点位来回填 tag；未开启自动路由时，仍需在数据总线中手动设置最终映射。
          </Text>
          <div style={{ marginBottom: 16 }}>
            <Checkbox
              checked={createMemberRoutes}
              onChange={(event) => setCreateMemberRoutes(event.target.checked)}
            >
              保存控制组时自动创建 DataCenter 路由
            </Checkbox>
            <Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
              仅为本次从下方选择的点位增量创建路由：p_meas/base_tag → AGC，AGC p_set → 外部点位。已有路由不会自动删除。
            </Text>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <Form.Item
                name="member_name"
                label="member_name"
                rules={[{ required: true, message: '请输入成员名称' }]}
              >
                <Input placeholder="pcs_1" />
              </Form.Item>
              <Form.Item label="从数据总线连接快速填充" style={{ marginTop: -8, marginBottom: 0 }}>
                <Select
                  allowClear
                  showSearch
                  placeholder="可选：按连接名回填 member_name"
                  options={dataBusConnectionOptions}
                  value={memberConnectionPickerValue}
                  loading={dataBusEndpointLoading}
                  notFoundContent="暂无可选连接，可继续手动输入"
                  onChange={handleSelectMemberConnection}
                  filterOption={(input, option) =>
                    String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
              </Form.Item>
            </div>
            <div style={{ width: 140 }}>
              <Form.Item name="controllable" label="controllable" valuePropName="checked">
                <Switch />
              </Form.Item>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <Form.Item
                name="capacity_kw"
                label="capacity_kw"
                rules={[
                  {
                    validator: async (_rule, value) => {
                      if (value == null || isFiniteNumber(value)) return;
                      throw new Error('额定容量必须是有效数字');
                    },
                  },
                ]}
              >
                <InputNumber style={{ width: '100%' }} step={0.1} min={0} />
              </Form.Item>
            </div>
            <div style={{ flex: 1 }}>
              <Form.Item name="weight" label="weight">
                <InputNumber style={{ width: '100%' }} step={0.1} min={0} />
              </Form.Item>
            </div>
            <div style={{ flex: 1 }}>
              <Form.Item name="min_kw" label="min_kw">
                <InputNumber style={{ width: '100%' }} step={0.1} />
              </Form.Item>
            </div>
            <div style={{ flex: 1 }}>
              <Form.Item
                name="max_kw"
                label="max_kw"
                dependencies={['capacity_kw', 'min_kw']}
                rules={[
                  {
                    validator: async (_rule, value) => {
                      if (value == null) return;
                      if (!isFiniteNumber(value)) {
                        throw new Error('最大可调有功必须是有效数字');
                      }

                      const capacityKw = memberForm.getFieldValue('capacity_kw');
                      if (isFiniteNumber(capacityKw) && value > capacityKw) {
                        throw new Error('最大可调有功不能大于额定容量');
                      }

                      const minKw = memberForm.getFieldValue('min_kw');
                      if (isFiniteNumber(minKw) && value < minKw) {
                        throw new Error('最大可调有功不能小于最小可调有功');
                      }
                    },
                  },
                ]}
              >
                <InputNumber style={{ width: '100%' }} step={0.1} />
              </Form.Item>
            </div>
          </div>

          <Card title="p_meas" size="small" bordered style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <Form.Item name={['p_meas', 'tag']} label="tag">
                  <Input placeholder="pcs_1_p_meas" />
                </Form.Item>
                <Form.Item label="从数据总线快速选择" style={{ marginTop: -8, marginBottom: 0 }}>
                  <Select
                    allowClear
                    showSearch
                    placeholder="可选：从数据总线点位回填 p_meas"
                    options={dataBusEndpointOptions}
                    value={memberTagPickerValues.p_meas}
                    loading={dataBusEndpointLoading}
                    notFoundContent="暂无可选点位，可继续手动输入"
                    onChange={(value) => handleSelectMemberEndpoint('p_meas', value)}
                    filterOption={(input, option) =>
                      String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['p_meas', 'unit']} label="unit">
                  <Input placeholder="kW" />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['p_meas', 'scale']} label="scale">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['p_meas', 'offset']} label="offset">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </div>
            </div>
          </Card>

          <Card title="p_set" size="small" bordered>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <Form.Item name={['p_set', 'signal', 'tag']} label="tag">
                  <Input placeholder="pcs_1_p_set" />
                </Form.Item>
                <Form.Item label="从数据总线快速选择" style={{ marginTop: -8, marginBottom: 0 }}>
                  <Select
                    allowClear
                    showSearch
                    placeholder="可选：从数据总线点位回填 p_set"
                    options={dataBusEndpointOptions}
                    value={memberTagPickerValues.p_set}
                    loading={dataBusEndpointLoading}
                    notFoundContent="暂无可选点位，可继续手动输入"
                    onChange={(value) => handleSelectMemberEndpoint('p_set', value)}
                    filterOption={(input, option) =>
                      String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['p_set', 'signal', 'unit']} label="unit">
                  <Input placeholder="kW" />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['p_set', 'signal', 'scale']} label="scale">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['p_set', 'signal', 'offset']} label="offset">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ width: 260 }}>
                <Form.Item name={['p_set', 'mode']} label="mode">
                  <Select
                    options={Object.entries(VALUE_MODE_LABELS).map(([value, label]) => ({
                      value: Number(value),
                      label,
                    }))}
                  />
                </Form.Item>
              </div>
              <Form.Item noStyle shouldUpdate>
                {({ getFieldValue }) => {
                  const mode = getFieldValue(['p_set', 'mode']);
                  const deltaBase = getFieldValue(['p_set', 'delta_base']);
                  return mode === 2 ? (
                    <>
                      <div style={{ width: 260 }}>
                        <Form.Item name={['p_set', 'delta_base']} label="delta_base">
                          <Select
                            options={Object.entries(DELTA_BASE_LABELS).map(([value, label]) => ({
                              value: Number(value),
                              label,
                            }))}
                          />
                        </Form.Item>
                      </div>
                      {deltaBase === 3 ? (
                        <div style={{ flex: 1 }}>
                          <Form.Item name={['p_set', 'base_tag']} label="base_tag">
                            <Input placeholder="base_power_tag" />
                          </Form.Item>
                          <Form.Item label="从数据总线快速选择" style={{ marginTop: -8, marginBottom: 0 }}>
                            <Select
                              allowClear
                              showSearch
                              placeholder="可选：从数据总线点位回填 base_tag"
                              options={dataBusEndpointOptions}
                              value={memberTagPickerValues.base_tag}
                              loading={dataBusEndpointLoading}
                              notFoundContent="暂无可选点位，可继续手动输入"
                              onChange={(value) => handleSelectMemberEndpoint('base_tag', value)}
                              filterOption={(input, option) =>
                                String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                              }
                            />
                          </Form.Item>
                        </div>
                      ) : null}
                    </>
                  ) : null;
                }}
              </Form.Item>
            </div>
          </Card>
        </Form>
      </Modal>
    </div>
  );
};

export default AGC;
