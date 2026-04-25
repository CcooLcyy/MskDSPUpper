import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
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
  AvcDefaultPointInfo,
  AvcGroupConfig,
  AvcGroupInfo,
  AvcMemberConfig,
  AvcSignalSpec,
  AvcValueSpec,
  AvcVoltageControlConfig,
  DcPointUpdate,
} from '../../adapters';
import { CONTROL_VIEW_QUERY_KEY, normalizeControlView } from '../../components/control/control-view';
import { formatAutoRealtimeNumber } from '../../utils/realtime-value';

const { Text } = Typography;

type AvcCommandMode = 'voltage' | 'q_total';

type AvcGroupFormValues = {
  group_name: string;
  command_mode: AvcCommandMode;
  voltage_meas: AvcSignalSpec;
  voltage_cmd: AvcSignalSpec;
  q_total_cmd: AvcValueSpec;
  voltage_control: AvcVoltageControlConfig;
  strategy: { strategy_type: string };
  members: AvcMemberConfig[];
};

type DataBusEndpointOption = {
  value: string;
  label: string;
  tag: string;
  connName: string;
};

type DataBusConnectionOption = {
  value: string;
  label: string;
  memberName: string;
};

type GroupTagPickerKey = 'voltage_meas' | 'voltage_cmd' | 'q_total_cmd' | 'q_total_base_tag';
type MemberTagPickerKey = 'q_meas' | 'q_set' | 'base_tag';

const STATE_MAP: Record<number, { label: string; color: string }> = {
  0: { label: '未指定', color: 'default' },
  1: { label: '已停止', color: 'default' },
  2: { label: '运行中', color: 'green' },
  3: { label: '待删除', color: 'orange' },
};

const VALUE_MODE_LABELS: Record<number, string> = {
  0: '未指定',
  1: '绝对值',
  2: '增量值',
};

const DELTA_BASE_LABELS: Record<number, string> = {
  0: '未指定',
  1: '上一轮目标值',
  2: '当前实测值',
  3: '指定 base_tag',
};

const DEFAULT_POINT_KIND_LABELS: Record<number, string> = {
  0: '未指定',
  1: '理论可调无功下限',
  2: '理论可调无功上限',
  3: '当前可调无功下限',
  4: '当前可调无功上限',
  5: '调节返回值',
  6: '当前电压',
  7: '总无功目标',
  8: '总无功实测',
  9: '总无功偏差',
  10: '电压偏差',
};

const DEFAULT_VOLTAGE_SIGNAL: AvcSignalSpec = {
  tag: '',
  unit: 'kV',
  scale: 1,
  offset: 0,
};

const DEFAULT_Q_SIGNAL: AvcSignalSpec = {
  tag: '',
  unit: 'kVar',
  scale: 1,
  offset: 0,
};

const DEFAULT_MEMBER: AvcMemberConfig = {
  member_name: '',
  controllable: true,
  weight: 1,
  q_min_kvar: 0,
  q_max_kvar: 0,
  q_meas: { ...DEFAULT_Q_SIGNAL },
  q_set: {
    signal: { ...DEFAULT_Q_SIGNAL },
    mode: 1,
    delta_base: 0,
    base_tag: '',
  },
};

const buildEmptyGroupForm = (): AvcGroupFormValues => ({
  group_name: '控制组1',
  command_mode: 'voltage',
  voltage_meas: { ...DEFAULT_VOLTAGE_SIGNAL, tag: '母线电压测量' },
  voltage_cmd: { ...DEFAULT_VOLTAGE_SIGNAL, tag: 'AVC目标电压命令' },
  q_total_cmd: {
    signal: { ...DEFAULT_Q_SIGNAL, tag: 'AVC总无功命令' },
    mode: 1,
    delta_base: 0,
    base_tag: '',
  },
  voltage_control: {
    kp: 1,
    deadband: 0,
  },
  strategy: { strategy_type: 'weighted' },
  members: [],
});

const cloneSignal = (signal: AvcSignalSpec | null | undefined): AvcSignalSpec => ({
  tag: signal?.tag ?? '',
  unit: signal?.unit ?? '',
  scale: signal?.scale ?? 1,
  offset: signal?.offset ?? 0,
});

const cloneValueSpec = (spec: AvcValueSpec | null | undefined): AvcValueSpec => ({
  signal: cloneSignal(spec?.signal),
  mode: spec?.mode ?? 1,
  delta_base: spec?.delta_base ?? 0,
  base_tag: spec?.base_tag ?? '',
});

const cloneVoltageControl = (
  config: AvcVoltageControlConfig | null | undefined,
): AvcVoltageControlConfig => ({
  kp: config?.kp ?? 1,
  deadband: config?.deadband ?? 0,
});

const cloneMember = (member: AvcMemberConfig | null | undefined): AvcMemberConfig => ({
  member_name: member?.member_name ?? '',
  controllable: member?.controllable ?? true,
  weight: member?.weight ?? 1,
  q_min_kvar: member?.q_min_kvar ?? 0,
  q_max_kvar: member?.q_max_kvar ?? 0,
  q_meas: cloneSignal(member?.q_meas),
  q_set: cloneValueSpec(member?.q_set),
});

const determineCommandMode = (config: AvcGroupConfig | null | undefined): AvcCommandMode =>
  config?.voltage_cmd ? 'voltage' : 'q_total';

const buildGroupFormValues = (config: AvcGroupConfig): AvcGroupFormValues => ({
  group_name: config.group_name,
  command_mode: determineCommandMode(config),
  voltage_meas: cloneSignal(config.voltage_meas),
  voltage_cmd: cloneSignal(config.voltage_cmd),
  q_total_cmd: cloneValueSpec(config.q_total_cmd),
  voltage_control: cloneVoltageControl(config.voltage_control),
  strategy: { strategy_type: config.strategy?.strategy_type ?? 'weighted' },
  members: config.members.map((member) => cloneMember(member)),
});

const normalizeSignal = (signal: AvcSignalSpec | null | undefined): AvcSignalSpec | null => {
  if (!signal) {
    return null;
  }

  if (!signal.tag.trim()) {
    return null;
  }

  return {
    tag: signal.tag.trim(),
    unit: signal.unit.trim(),
    scale: signal.scale ?? 1,
    offset: signal.offset ?? 0,
  };
};

const normalizeValueSpec = (spec: AvcValueSpec | null | undefined): AvcValueSpec | null => {
  if (!spec) {
    return null;
  }

  const signal = normalizeSignal(spec.signal);
  if (!signal) {
    return null;
  }

  return {
    signal,
    mode: spec.mode ?? 1,
    delta_base: spec.mode === 2 ? (spec.delta_base ?? 0) : 0,
    base_tag: spec.mode === 2 && spec.delta_base === 3 ? spec.base_tag.trim() : '',
  };
};

const normalizeVoltageControl = (
  config: AvcVoltageControlConfig | null | undefined,
): AvcVoltageControlConfig | null => {
  if (!config) {
    return null;
  }

  return {
    kp: config.kp ?? 0,
    deadband: config.deadband ?? 0,
  };
};

const formatSignal = (signal: AvcSignalSpec | null | undefined): string => {
  if (!signal?.tag) {
    return '-';
  }

  const unitPart = signal.unit ? ` (${signal.unit})` : '';
  return `${signal.tag}${unitPart} | scale=${signal.scale}, offset=${signal.offset}`;
};

const formatValueSpec = (spec: AvcValueSpec | null | undefined): string => {
  if (!spec?.signal?.tag) {
    return '-';
  }

  const basePart =
    spec.mode === 2
      ? `，基准=${DELTA_BASE_LABELS[spec.delta_base] ?? spec.delta_base}${spec.delta_base === 3 && spec.base_tag ? `:${spec.base_tag}` : ''}`
      : '';
  return `${formatSignal(spec.signal)} | ${VALUE_MODE_LABELS[spec.mode] ?? spec.mode}${basePart}`;
};

const formatPointValue = (update: DcPointUpdate | null | undefined): string => {
  if (!update?.value) {
    return '—';
  }

  switch (update.value.type) {
    case 'Bool':
      return update.value.value ? '是' : '否';
    case 'Int':
      return String(update.value.value);
    case 'Double':
      return formatAutoRealtimeNumber(update.value.value);
    case 'String':
      return update.value.value;
    case 'Bytes':
      return `[${update.value.value.length} 字节]`;
    default:
      return '—';
  }
};

const buildDefaultMemberTag = (memberName: string, kind: 'q_meas' | 'q_set'): string => {
  const normalizedMemberName = memberName
    .trim()
    .replace(/[\\/:]/g, '_')
    .replace(/\s+/g, '_');
  if (!normalizedMemberName) {
    return '';
  }

  const suffix = kind === 'q_meas' ? '无功测量' : '无功设定';
  return `${normalizedMemberName}_${suffix}`;
};

const findDuplicateGroupEndpointTags = (config: AvcGroupConfig): string[] => {
  const tagOwners = new Map<string, string[]>();

  const collectTag = (tag: string | null | undefined, owner: string) => {
    const normalizedTag = tag?.trim();
    if (!normalizedTag) {
      return;
    }

    const owners = tagOwners.get(normalizedTag) ?? [];
    owners.push(owner);
    tagOwners.set(normalizedTag, owners);
  };

  collectTag(config.voltage_meas?.tag, 'voltage_meas');
  collectTag(config.voltage_cmd?.tag, 'voltage_cmd');
  collectTag(config.q_total_cmd?.signal?.tag, 'q_total_cmd');
  config.members.forEach((member, index) => {
    const memberLabel = member.member_name.trim() || `member #${index + 1}`;
    collectTag(member.q_meas?.tag, `${memberLabel}.q_meas`);
    collectTag(member.q_set?.signal?.tag, `${memberLabel}.q_set`);
  });

  return Array.from(tagOwners.entries())
    .filter(([, owners]) => owners.length > 1)
    .map(([tag, owners]) => `${tag} (${owners.join('，')})`);
};

const validateGroupConfig = (config: AvcGroupConfig) => {
  if (!config.group_name.trim()) {
    throw new Error('请输入控制组名称');
  }

  if (!config.voltage_meas?.tag) {
    throw new Error('请配置电压量测点 voltage_meas');
  }

  const hasVoltageCommand = Boolean(config.voltage_cmd?.tag);
  const hasQTotalCommand = Boolean(config.q_total_cmd?.signal?.tag);
  if (hasVoltageCommand === hasQTotalCommand) {
    throw new Error('目标电压命令和总无功命令必须二选一');
  }

  if (hasVoltageCommand && !config.voltage_control) {
    throw new Error('目标电压模式必须配置电压控制参数');
  }

  if (config.members.length === 0) {
    throw new Error('至少添加一个成员');
  }

  config.members.forEach((member, index) => {
    const memberLabel = member.member_name.trim() || `member #${index + 1}`;
    if (!member.member_name.trim()) {
      throw new Error(`成员 #${index + 1} 缺少 member_name`);
    }
    if (!member.q_meas?.tag) {
      throw new Error(`${memberLabel} 缺少 q_meas`);
    }
    if (member.q_min_kvar > member.q_max_kvar) {
      throw new Error(`${memberLabel} 的 q_min_kvar 不能大于 q_max_kvar`);
    }
    if (member.controllable && !member.q_set?.signal?.tag) {
      throw new Error(`${memberLabel} 为可控成员，必须配置 q_set`);
    }
    if (member.controllable && (member.weight ?? 0) <= 0) {
      throw new Error(`${memberLabel} 的 weight 必须大于 0`);
    }
  });

  const duplicateTags = findDuplicateGroupEndpointTags(config);
  if (duplicateTags.length > 0) {
    throw new Error(`同一 AVC 控制组内 DataBus tag 不能重复: ${duplicateTags.join('；')}`);
  }
};

const collectObservedTags = (group: AvcGroupInfo | null): string[] => {
  if (!group?.config) {
    return [];
  }

  const tags = new Set<string>();
  const collectTag = (tag: string | null | undefined) => {
    const normalizedTag = tag?.trim();
    if (normalizedTag) {
      tags.add(normalizedTag);
    }
  };

  collectTag(group.config.voltage_meas?.tag);
  collectTag(group.config.voltage_cmd?.tag);
  collectTag(group.config.q_total_cmd?.signal?.tag);
  group.config.members.forEach((member) => {
    collectTag(member.q_meas?.tag);
    collectTag(member.q_set?.signal?.tag);
  });
  group.default_points.forEach((point) => collectTag(point.tag));

  return Array.from(tags);
};

const findDefaultPointByKind = (
  points: AvcDefaultPointInfo[],
  kind: number,
): AvcDefaultPointInfo | null => points.find((point) => point.kind === kind) ?? null;

const AVC: React.FC = () => {
  const [groups, setGroups] = useState<AvcGroupInfo[]>([]);
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [memberModalOpen, setMemberModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<AvcGroupConfig | null>(null);
  const [editingMemberIndex, setEditingMemberIndex] = useState<number | null>(null);
  const [membersDraft, setMembersDraft] = useState<AvcMemberConfig[]>([]);
  const [dataBusConnectionOptions, setDataBusConnectionOptions] = useState<DataBusConnectionOption[]>([]);
  const [dataBusEndpointOptions, setDataBusEndpointOptions] = useState<DataBusEndpointOption[]>([]);
  const [dataBusEndpointLoading, setDataBusEndpointLoading] = useState(false);
  const [groupTagPickerValues, setGroupTagPickerValues] = useState<Partial<Record<GroupTagPickerKey, string>>>({});
  const [memberConnectionPickerValue, setMemberConnectionPickerValue] = useState<string>();
  const [memberTagPickerValues, setMemberTagPickerValues] = useState<
    Partial<Record<MemberTagPickerKey, string>>
  >({});
  const [runtimeUpdates, setRuntimeUpdates] = useState<Record<string, DcPointUpdate>>({});
  const [messageApi, contextHolder] = message.useMessage();
  const [groupForm] = Form.useForm<AvcGroupFormValues>();
  const [renameForm] = Form.useForm<{ old_group_name: string; new_group_name: string }>();
  const [memberForm] = Form.useForm<AvcMemberConfig>();
  const [searchParams] = useSearchParams();

  const commandMode = Form.useWatch('command_mode', groupForm) ?? 'voltage';
  const qTotalMode = Form.useWatch(['q_total_cmd', 'mode'], groupForm) ?? 1;
  const qTotalDeltaBase = Form.useWatch(['q_total_cmd', 'delta_base'], groupForm) ?? 0;
  const memberControllable = Form.useWatch('controllable', memberForm) ?? true;
  const memberQSetMode = Form.useWatch(['q_set', 'mode'], memberForm) ?? 1;
  const memberQSetDeltaBase = Form.useWatch(['q_set', 'delta_base'], memberForm) ?? 0;

  const selectedGroup = useMemo(
    () => groups.find((item) => item.config?.group_name === selectedGroupName) ?? null,
    [groups, selectedGroupName],
  );
  const selectedConfig = selectedGroup?.config ?? null;
  const stateInfo = STATE_MAP[selectedGroup?.state ?? 0] ?? STATE_MAP[0];
  const currentView = normalizeControlView(searchParams.get(CONTROL_VIEW_QUERY_KEY));

  const refreshGroups = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.avcListGroups();
      setGroups(list);
      setSelectedGroupName((prev) => {
        if (prev && list.some((item) => item.config?.group_name === prev)) {
          return prev;
        }
        return list[0]?.config?.group_name ?? null;
      });
    } catch (error) {
      messageApi.error(`刷新 AVC 控制组失败: ${error}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

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
              value: `${connection.conn_id}:${tag}`,
              label: `${connection.module_name}/${connection.conn_name} : ${tag}`,
              tag,
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

  const refreshRuntime = useCallback(async () => {
    if (!selectedGroup?.conn_id) {
      setRuntimeUpdates({});
      return;
    }

    const tags = collectObservedTags(selectedGroup);
    if (tags.length === 0) {
      setRuntimeUpdates({});
      return;
    }

    setRuntimeLoading(true);
    try {
      const updates = await api.dcGetLatest(selectedGroup.conn_id, tags);
      const nextUpdates: Record<string, DcPointUpdate> = {};
      updates.forEach((update) => {
        nextUpdates[update.dst_tag] = update;
      });
      setRuntimeUpdates(nextUpdates);
    } catch (error) {
      messageApi.error(`刷新 AVC 运行监视失败: ${error}`);
    } finally {
      setRuntimeLoading(false);
    }
  }, [messageApi, selectedGroup]);

  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups]);

  useEffect(() => {
    void refreshDataBusEndpointOptions();
  }, [refreshDataBusEndpointOptions]);

  useEffect(() => {
    if (currentView !== 'strategy' || !selectedGroup?.conn_id) {
      setRuntimeUpdates({});
      return;
    }

    void refreshRuntime();
    const timer = window.setInterval(() => {
      void refreshRuntime();
    }, 2000);

    return () => window.clearInterval(timer);
  }, [currentView, refreshRuntime, selectedGroup?.conn_id]);

  const handleSelectGroup = useCallback((groupName: string) => {
    setSelectedGroupName(groupName);
  }, []);

  const handleSelectGroupEndpoint = useCallback(
    (picker: GroupTagPickerKey, endpointValue: string | undefined) => {
      setGroupTagPickerValues((prev) => ({ ...prev, [picker]: endpointValue }));
      if (!endpointValue) {
        return;
      }

      const selected = dataBusEndpointOptions.find((item) => item.value === endpointValue);
      if (!selected) {
        return;
      }

      switch (picker) {
        case 'voltage_meas':
          groupForm.setFieldValue(['voltage_meas', 'tag'], selected.tag);
          break;
        case 'voltage_cmd':
          groupForm.setFieldValue(['voltage_cmd', 'tag'], selected.tag);
          break;
        case 'q_total_cmd':
          groupForm.setFieldValue(['q_total_cmd', 'signal', 'tag'], selected.tag);
          break;
        case 'q_total_base_tag':
          groupForm.setFieldValue(['q_total_cmd', 'base_tag'], selected.tag);
          break;
        default:
          break;
      }
    },
    [dataBusEndpointOptions, groupForm],
  );

  const handleSelectMemberConnection = useCallback(
    (connectionValue: string | undefined) => {
      setMemberConnectionPickerValue(connectionValue);
      if (!connectionValue) {
        return;
      }

      const selected = dataBusConnectionOptions.find((item) => item.value === connectionValue);
      if (!selected) {
        return;
      }

      const previousMemberName = String(memberForm.getFieldValue('member_name') ?? '').trim();
      const currentQMeasTag = String(memberForm.getFieldValue(['q_meas', 'tag']) ?? '').trim();
      const currentQSetTag = String(memberForm.getFieldValue(['q_set', 'signal', 'tag']) ?? '').trim();
      memberForm.setFieldValue('member_name', selected.memberName);

      const previousQMeasTag = buildDefaultMemberTag(previousMemberName, 'q_meas');
      if (!currentQMeasTag || (previousQMeasTag && currentQMeasTag === previousQMeasTag)) {
        memberForm.setFieldValue(['q_meas', 'tag'], buildDefaultMemberTag(selected.memberName, 'q_meas'));
      }

      const previousQSetTag = buildDefaultMemberTag(previousMemberName, 'q_set');
      if (!currentQSetTag || (previousQSetTag && currentQSetTag === previousQSetTag)) {
        memberForm.setFieldValue(['q_set', 'signal', 'tag'], buildDefaultMemberTag(selected.memberName, 'q_set'));
      }
    },
    [dataBusConnectionOptions, memberForm],
  );

  const handleSelectMemberEndpoint = useCallback(
    (picker: MemberTagPickerKey, endpointValue: string | undefined) => {
      setMemberTagPickerValues((prev) => ({ ...prev, [picker]: endpointValue }));
      if (!endpointValue) {
        return;
      }

      const selected = dataBusEndpointOptions.find((item) => item.value === endpointValue);
      if (!selected) {
        return;
      }

      const memberName = String(memberForm.getFieldValue('member_name') ?? '').trim();
      if (!memberName) {
        memberForm.setFieldValue('member_name', selected.connName);
      }

      switch (picker) {
        case 'q_meas':
          memberForm.setFieldValue(['q_meas', 'tag'], selected.tag);
          break;
        case 'q_set':
          memberForm.setFieldValue(['q_set', 'signal', 'tag'], selected.tag);
          break;
        case 'base_tag':
          memberForm.setFieldValue(['q_set', 'base_tag'], selected.tag);
          break;
        default:
          break;
      }
    },
    [dataBusEndpointOptions, memberForm],
  );

  const openCreateGroup = useCallback(() => {
    setEditingGroup(null);
    setMembersDraft([]);
    setGroupTagPickerValues({});
    groupForm.resetFields();
    groupForm.setFieldsValue(buildEmptyGroupForm());
    setGroupModalOpen(true);
  }, [groupForm]);

  const openEditGroup = useCallback(() => {
    if (!selectedConfig) {
      return;
    }

    setEditingGroup(selectedConfig);
    setMembersDraft(selectedConfig.members.map((member) => cloneMember(member)));
    setGroupTagPickerValues({});
    groupForm.resetFields();
    groupForm.setFieldsValue(buildGroupFormValues(selectedConfig));
    setGroupModalOpen(true);
  }, [groupForm, selectedConfig]);

  const openRenameGroup = useCallback(() => {
    if (!selectedConfig) {
      return;
    }

    renameForm.resetFields();
    renameForm.setFieldsValue({
      old_group_name: selectedConfig.group_name,
      new_group_name: selectedConfig.group_name,
    });
    setRenameModalOpen(true);
  }, [renameForm, selectedConfig]);

  const openCreateMember = useCallback(() => {
    setEditingMemberIndex(null);
    setMemberConnectionPickerValue(undefined);
    setMemberTagPickerValues({});
    memberForm.resetFields();
    memberForm.setFieldsValue(cloneMember(DEFAULT_MEMBER));
    setMemberModalOpen(true);
  }, [memberForm]);

  const openEditMember = useCallback(
    (index: number) => {
      const member = membersDraft[index];
      if (!member) {
        return;
      }

      setEditingMemberIndex(index);
      setMemberConnectionPickerValue(undefined);
      setMemberTagPickerValues({});
      memberForm.resetFields();
      memberForm.setFieldsValue(cloneMember(member));
      setMemberModalOpen(true);
    },
    [memberForm, membersDraft],
  );

  const handleDeleteGroup = useCallback(
    async (groupName: string) => {
      try {
        await api.avcDeleteGroup(groupName);
        messageApi.success(`控制组 ${groupName} 已删除`);
        if (selectedGroupName === groupName) {
          setSelectedGroupName(null);
        }
        await refreshGroups();
      } catch (error) {
        messageApi.error(`删除控制组失败: ${error}`);
        await refreshGroups();
      }
    },
    [messageApi, refreshGroups, selectedGroupName],
  );

  const handleStartGroup = useCallback(async () => {
    if (!selectedGroupName) {
      return;
    }

    try {
      await api.avcStartGroup(selectedGroupName);
      messageApi.success('启动控制组请求已发送');
      await refreshGroups();
      window.setTimeout(() => void refreshGroups(), 1000);
    } catch (error) {
      messageApi.error(`启动控制组失败: ${error}`);
      await refreshGroups();
    }
  }, [messageApi, refreshGroups, selectedGroupName]);

  const handleStopGroup = useCallback(async () => {
    if (!selectedGroupName) {
      return;
    }

    try {
      await api.avcStopGroup(selectedGroupName);
      messageApi.success('停止控制组请求已发送');
      await refreshGroups();
      window.setTimeout(() => void refreshGroups(), 1000);
    } catch (error) {
      messageApi.error(`停止控制组失败: ${error}`);
      await refreshGroups();
    }
  }, [messageApi, refreshGroups, selectedGroupName]);

  const handleGroupSubmit = useCallback(async () => {
    try {
      const values = await groupForm.validateFields();
      const config: AvcGroupConfig = {
        group_name: values.group_name.trim(),
        voltage_meas: normalizeSignal(values.voltage_meas),
        voltage_cmd: values.command_mode === 'voltage' ? normalizeSignal(values.voltage_cmd) : null,
        q_total_cmd: values.command_mode === 'q_total' ? normalizeValueSpec(values.q_total_cmd) : null,
        voltage_control:
          values.command_mode === 'voltage' ? normalizeVoltageControl(values.voltage_control) : null,
        strategy: { strategy_type: values.strategy?.strategy_type ?? 'weighted' },
        members: membersDraft.map((member) => ({
          member_name: member.member_name.trim(),
          controllable: member.controllable ?? true,
          weight: member.weight ?? 0,
          q_min_kvar: member.q_min_kvar ?? 0,
          q_max_kvar: member.q_max_kvar ?? 0,
          q_meas: normalizeSignal(member.q_meas),
          q_set: member.controllable ? normalizeValueSpec(member.q_set) : null,
        })),
      };

      validateGroupConfig(config);

      const createOnly = !editingGroup;
      await api.avcUpsertGroup(config, createOnly);
      messageApi.success(createOnly ? 'AVC 控制组创建成功' : 'AVC 控制组更新成功');
      setGroupModalOpen(false);
      await refreshGroups();
      setSelectedGroupName(config.group_name);
    } catch (error) {
      messageApi.error(`保存 AVC 控制组失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [editingGroup, groupForm, membersDraft, messageApi, refreshGroups]);

  const handleRenameGroup = useCallback(async () => {
    try {
      const values = await renameForm.validateFields();
      const oldGroupName = values.old_group_name.trim();
      const newGroupName = values.new_group_name.trim();
      const group = await api.avcRenameGroup(oldGroupName, newGroupName);
      const nextGroupName = group.config?.group_name ?? newGroupName;
      messageApi.success(`控制组已重命名为 ${nextGroupName}`);
      setRenameModalOpen(false);
      await refreshGroups();
      setSelectedGroupName(nextGroupName);
    } catch (error) {
      messageApi.error(`重命名控制组失败: ${error instanceof Error ? error.message : String(error)}`);
      await refreshGroups();
    }
  }, [messageApi, refreshGroups, renameForm]);

  const handleMemberSubmit = useCallback(async () => {
    try {
      const values = await memberForm.validateFields();
      const nextMember: AvcMemberConfig = {
        member_name: values.member_name.trim(),
        controllable: values.controllable ?? true,
        weight: values.weight ?? 0,
        q_min_kvar: values.q_min_kvar ?? 0,
        q_max_kvar: values.q_max_kvar ?? 0,
        q_meas: cloneSignal(values.q_meas),
        q_set: values.controllable ? cloneValueSpec(values.q_set) : null,
      };

      if (nextMember.q_min_kvar > nextMember.q_max_kvar) {
        throw new Error('q_min_kvar 不能大于 q_max_kvar');
      }

      if (nextMember.controllable && !(nextMember.q_set?.signal?.tag ?? '').trim()) {
        throw new Error('可控成员必须配置 q_set');
      }

      if (!(nextMember.q_meas?.tag ?? '').trim()) {
        throw new Error('请配置 q_meas');
      }

      setMembersDraft((prev) => {
        if (editingMemberIndex === null) {
          return [...prev, nextMember];
        }

        return prev.map((member, index) => (index === editingMemberIndex ? nextMember : member));
      });
      setMemberModalOpen(false);
    } catch (error) {
      messageApi.error(`保存成员失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [editingMemberIndex, memberForm, messageApi]);

  const handleDeleteMember = useCallback((index: number) => {
    setMembersDraft((prev) => prev.filter((_item, itemIndex) => itemIndex !== index));
  }, []);

  const editDisabled = !selectedGroup || selectedGroup.state !== 1;
  const renameDisabled = !selectedGroup || selectedGroup.state !== 1;
  const startDisabled = !selectedGroup || selectedGroup.state !== 1;
  const stopDisabled = !selectedGroup || selectedGroup.state !== 2;

  const importantRuntimeRows = useMemo(() => {
    if (!selectedGroup) {
      return [];
    }

    const rows: Array<{ label: string; tag: string }> = [];
    if (selectedConfig?.voltage_meas?.tag) {
      rows.push({ label: '电压量测', tag: selectedConfig.voltage_meas.tag });
    }
    if (selectedConfig?.voltage_cmd?.tag) {
      rows.push({ label: '目标电压命令', tag: selectedConfig.voltage_cmd.tag });
    }
    if (selectedConfig?.q_total_cmd?.signal?.tag) {
      rows.push({ label: '总无功命令', tag: selectedConfig.q_total_cmd.signal.tag });
    }

    [
      { kind: 6, fallback: '当前电压' },
      { kind: 7, fallback: '总无功目标' },
      { kind: 8, fallback: '总无功实测' },
      { kind: 9, fallback: '总无功偏差' },
      { kind: 10, fallback: '电压偏差' },
      { kind: 5, fallback: '调节返回值' },
    ].forEach((item) => {
      const point = findDefaultPointByKind(selectedGroup.default_points, item.kind);
      if (point?.tag) {
        rows.push({ label: DEFAULT_POINT_KIND_LABELS[item.kind] ?? item.fallback, tag: point.tag });
      }
    });

    return rows;
  }, [selectedConfig, selectedGroup]);

  const memberColumns: ColumnsType<AvcMemberConfig> = [
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
      title: 'q_min (kVar)',
      dataIndex: 'q_min_kvar',
      key: 'q_min_kvar',
      width: 120,
    },
    {
      title: 'q_max (kVar)',
      dataIndex: 'q_max_kvar',
      key: 'q_max_kvar',
      width: 120,
    },
    {
      title: 'q_meas tag',
      key: 'q_meas',
      width: 180,
      render: (_, record) => record.q_meas?.tag || '-',
    },
    {
      title: 'q_meas 最新值',
      key: 'q_meas_value',
      width: 140,
      render: (_, record) => formatPointValue(record.q_meas?.tag ? runtimeUpdates[record.q_meas.tag] : null),
    },
    {
      title: 'q_set tag',
      key: 'q_set',
      width: 180,
      render: (_, record) => record.q_set?.signal?.tag || '-',
    },
    {
      title: 'q_set 最新值',
      key: 'q_set_value',
      width: 140,
      render: (_, record) =>
        formatPointValue(record.q_set?.signal?.tag ? runtimeUpdates[record.q_set.signal.tag] : null),
    },
    {
      title: '可控',
      key: 'controllable',
      width: 90,
      render: (_, record) => (
        <Tag color={record.controllable ? 'green' : 'default'}>
          {record.controllable ? '是' : '否'}
        </Tag>
      ),
    },
  ];

  const modalMemberColumns: ColumnsType<AvcMemberConfig> = [
    ...memberColumns,
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_, __, index) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEditMember(index)} />
          <Popconfirm title="确认删除该成员？" onConfirm={() => handleDeleteMember(index)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const defaultPointColumns: ColumnsType<AvcDefaultPointInfo> = [
    {
      title: '类型',
      key: 'kind',
      width: 160,
      render: (_, record) => DEFAULT_POINT_KIND_LABELS[record.kind] ?? record.name ?? '未知',
    },
    {
      title: 'tag',
      dataIndex: 'tag',
      key: 'tag',
      width: 220,
      render: (value: string) => value || '-',
    },
    {
      title: '最新值',
      key: 'value',
      width: 120,
      render: (_, record) => formatPointValue(record.tag ? runtimeUpdates[record.tag] : null),
    },
    {
      title: '说明',
      key: 'description',
      render: (_, record) => record.description || record.name || '-',
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
            style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}
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
                locale={{ emptyText: '暂无 AVC 控制组' }}
                renderItem={(item) => {
                  const groupName = item.config?.group_name ?? `group_${item.conn_id}`;
                  const isActive = groupName === selectedGroupName;
                  const color = item.state === 2 ? '#4caf50' : item.state === 3 ? '#ff9800' : '#9e9e9e';
                  const commandMode = item.config?.voltage_cmd ? '目标电压' : item.config?.q_total_cmd ? '总无功' : '未配置';
                  return (
                    <List.Item
                      onClick={() => handleSelectGroup(groupName)}
                      style={{
                        cursor: 'pointer',
                        padding: '8px 16px',
                        background: isActive ? '#37373d' : 'transparent',
                      }}
                    >
                      <Space direction="vertical" size={4} style={{ width: '100%' }}>
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
                            {STATE_MAP[item.state]?.label ?? '未知'}
                          </Tag>
                        </Space>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          conn_id={item.conn_id} | {commandMode} | 成员 {item.config?.members.length ?? 0}
                        </Text>
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
            <div className="protocol-top-row" style={{ flex: '0 1 360px', minHeight: 240 }}>
              <Card
                title="组配置"
                size="small"
                bordered
                className="protocol-log-card"
                style={{ flex: 1, minHeight: 0 }}
                extra={
                  selectedConfig ? (
                    <Space>
                      <Button type="link" size="small" icon={<EditOutlined />} disabled={editDisabled} onClick={openEditGroup}>
                        编辑
                      </Button>
                      <Button type="link" size="small" disabled={renameDisabled} onClick={openRenameGroup}>
                        重命名
                      </Button>
                      <Popconfirm
                        title={`确认删除 ${selectedConfig.group_name}？`}
                        onConfirm={() => void handleDeleteGroup(selectedConfig.group_name)}
                      >
                        <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                          {selectedGroup?.state === 3 ? '重试删除' : '删除'}
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
                      <Descriptions.Item label="控制状态">
                        <Tag color={stateInfo.color}>{stateInfo.label}</Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label="策略类型">
                        {selectedConfig.strategy?.strategy_type ?? '-'}
                      </Descriptions.Item>
                      <Descriptions.Item label="命令模式">
                        {selectedConfig.voltage_cmd ? '目标电压模式' : '总无功模式'}
                      </Descriptions.Item>
                      <Descriptions.Item label="成员数量">
                        {selectedConfig.members.length}
                      </Descriptions.Item>
                      <Descriptions.Item label="voltage_meas" span={2}>
                        {formatSignal(selectedConfig.voltage_meas)}
                      </Descriptions.Item>
                      <Descriptions.Item label="voltage_cmd / q_total_cmd" span={2}>
                        {selectedConfig.voltage_cmd
                          ? formatSignal(selectedConfig.voltage_cmd)
                          : formatValueSpec(selectedConfig.q_total_cmd)}
                      </Descriptions.Item>
                      <Descriptions.Item label="voltage_control" span={2}>
                        {selectedConfig.voltage_control
                          ? `kp=${selectedConfig.voltage_control.kp}，deadband=${selectedConfig.voltage_control.deadband}`
                          : '当前模式下不使用'}
                      </Descriptions.Item>
                      <Descriptions.Item label="last_error" span={2}>
                        {selectedGroup?.last_error || '—'}
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
                style={{ width: 360, flexShrink: 0, minHeight: 0 }}
                extra={
                  <Button
                    type="text"
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={runtimeLoading}
                    onClick={() => void refreshRuntime()}
                    disabled={!selectedGroup}
                  />
                }
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
                          disabled={startDisabled}
                          onClick={() => void handleStartGroup()}
                        >
                          启动控制组
                        </Button>
                        <Button
                          danger
                          icon={<PauseCircleOutlined />}
                          disabled={stopDisabled}
                          onClick={() => void handleStopGroup()}
                        >
                          停止控制组
                        </Button>
                      </Space>
                    </div>
                    {importantRuntimeRows.length > 0 ? (
                      importantRuntimeRows.map((item) => (
                        <div key={item.tag}>
                          <Text type="secondary" style={{ display: 'block' }}>{item.label}</Text>
                          <Text>
                            {item.tag} | {formatPointValue(runtimeUpdates[item.tag])}
                          </Text>
                        </div>
                      ))
                    ) : (
                      <Text type="secondary">暂无可监视点位</Text>
                    )}
                  </Space>
                </div>
              </Card>
            </div>

            <Card title="默认点" size="small" bordered className="protocol-point-card">
              <div className="protocol-table-scroll">
                <Table
                  rowKey={(record) => `${record.kind}-${record.tag}`}
                  columns={defaultPointColumns}
                  dataSource={selectedGroup?.default_points ?? []}
                  pagination={false}
                  size="small"
                  scroll={{ x: 780 }}
                  locale={{ emptyText: selectedGroup ? '当前控制组暂无默认点' : '请先选择控制组' }}
                />
              </div>
            </Card>

            <Card title="成员配置" size="small" bordered className="protocol-point-card">
              <div className="protocol-table-scroll">
                <Table
                  rowKey={(record, index) => `${record.member_name}-${index}`}
                  columns={memberColumns}
                  dataSource={selectedConfig?.members ?? []}
                  pagination={false}
                  size="small"
                  scroll={{ x: 1240 }}
                  locale={{ emptyText: selectedConfig ? '暂无成员配置' : '请先选择控制组' }}
                />
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <Card title="控制日志" size="small" bordered className="protocol-log-card">
          <div className="protocol-log-scroll">
            <div className="protocol-log-console">
              <div>[AVC] --:--:--.--- {selectedGroupName ?? '<group>'} - 控制日志 — 接入实时数据后渲染</div>
              <div className="protocol-log-line--hint">
                当前版本先完成 AVC 配置与运行控制，日志流后续再接入。
              </div>
            </div>
          </div>
        </Card>
      )}

      <Modal
        title={editingGroup ? '编辑 AVC 控制组' : '新增 AVC 控制组'}
        open={groupModalOpen}
        onOk={() => void handleGroupSubmit()}
        onCancel={() => setGroupModalOpen(false)}
        width={1100}
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
                <Input disabled={!!editingGroup} placeholder="avc_group_1" />
              </Form.Item>
            </div>
            <div style={{ width: 220 }}>
              <Form.Item name="command_mode" label="命令模式">
                <Select
                  options={[
                    { value: 'voltage', label: '目标电压模式' },
                    { value: 'q_total', label: '总无功模式' },
                  ]}
                />
              </Form.Item>
            </div>
            <div style={{ width: 220 }}>
              <Form.Item name={['strategy', 'strategy_type']} label="strategy_type">
                <Select options={[{ value: 'weighted', label: 'weighted' }]} />
              </Form.Item>
            </div>
          </div>

          <Card title="voltage_meas" size="small" bordered style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <Form.Item name={['voltage_meas', 'tag']} label="tag">
                  <Input placeholder="bus_voltage_meas" />
                </Form.Item>
                <Form.Item label="从数据总线快速选择" style={{ marginTop: -8, marginBottom: 0 }}>
                  <Select
                    allowClear
                    showSearch
                    placeholder="可选：从数据总线点位回填 voltage_meas"
                    options={dataBusEndpointOptions}
                    value={groupTagPickerValues.voltage_meas}
                    loading={dataBusEndpointLoading}
                    notFoundContent="暂无可选点位，可继续手动输入"
                    onChange={(value) => handleSelectGroupEndpoint('voltage_meas', value)}
                    filterOption={(input, option) =>
                      String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['voltage_meas', 'unit']} label="unit">
                  <Input placeholder="kV" />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['voltage_meas', 'scale']} label="scale">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['voltage_meas', 'offset']} label="offset">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </div>
            </div>
          </Card>

          {commandMode === 'voltage' ? (
            <>
              <Card title="voltage_cmd" size="small" bordered style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 16 }}>
                  <div style={{ flex: 1 }}>
                    <Form.Item name={['voltage_cmd', 'tag']} label="tag">
                      <Input placeholder="bus_voltage_cmd" />
                    </Form.Item>
                    <Form.Item label="从数据总线快速选择" style={{ marginTop: -8, marginBottom: 0 }}>
                      <Select
                        allowClear
                        showSearch
                        placeholder="可选：从数据总线点位回填 voltage_cmd"
                        options={dataBusEndpointOptions}
                        value={groupTagPickerValues.voltage_cmd}
                        loading={dataBusEndpointLoading}
                        notFoundContent="暂无可选点位，可继续手动输入"
                        onChange={(value) => handleSelectGroupEndpoint('voltage_cmd', value)}
                        filterOption={(input, option) =>
                          String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                        }
                      />
                    </Form.Item>
                  </div>
                  <div style={{ width: 140 }}>
                    <Form.Item name={['voltage_cmd', 'unit']} label="unit">
                      <Input placeholder="kV" />
                    </Form.Item>
                  </div>
                  <div style={{ width: 140 }}>
                    <Form.Item name={['voltage_cmd', 'scale']} label="scale">
                      <InputNumber step={0.01} style={{ width: '100%' }} />
                    </Form.Item>
                  </div>
                  <div style={{ width: 140 }}>
                    <Form.Item name={['voltage_cmd', 'offset']} label="offset">
                      <InputNumber step={0.01} style={{ width: '100%' }} />
                    </Form.Item>
                  </div>
                </div>
              </Card>

              <Card title="voltage_control" size="small" bordered style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 16 }}>
                  <div style={{ flex: 1 }}>
                    <Form.Item name={['voltage_control', 'kp']} label="kp">
                      <InputNumber step={0.01} style={{ width: '100%' }} />
                    </Form.Item>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Form.Item name={['voltage_control', 'deadband']} label="deadband">
                      <InputNumber step={0.01} style={{ width: '100%' }} />
                    </Form.Item>
                  </div>
                </div>
              </Card>
            </>
          ) : (
            <Card title="q_total_cmd" size="small" bordered style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <Form.Item name={['q_total_cmd', 'signal', 'tag']} label="tag">
                    <Input placeholder="q_total_cmd" />
                  </Form.Item>
                  <Form.Item label="从数据总线快速选择" style={{ marginTop: -8, marginBottom: 0 }}>
                    <Select
                      allowClear
                      showSearch
                      placeholder="可选：从数据总线点位回填 q_total_cmd"
                      options={dataBusEndpointOptions}
                      value={groupTagPickerValues.q_total_cmd}
                      loading={dataBusEndpointLoading}
                      notFoundContent="暂无可选点位，可继续手动输入"
                      onChange={(value) => handleSelectGroupEndpoint('q_total_cmd', value)}
                      filterOption={(input, option) =>
                        String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                      }
                    />
                  </Form.Item>
                </div>
                <div style={{ width: 140 }}>
                  <Form.Item name={['q_total_cmd', 'signal', 'unit']} label="unit">
                    <Input placeholder="kVar" />
                  </Form.Item>
                </div>
                <div style={{ width: 140 }}>
                  <Form.Item name={['q_total_cmd', 'signal', 'scale']} label="scale">
                    <InputNumber step={0.01} style={{ width: '100%' }} />
                  </Form.Item>
                </div>
                <div style={{ width: 140 }}>
                  <Form.Item name={['q_total_cmd', 'signal', 'offset']} label="offset">
                    <InputNumber step={0.01} style={{ width: '100%' }} />
                  </Form.Item>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16 }}>
                <div style={{ width: 260 }}>
                  <Form.Item name={['q_total_cmd', 'mode']} label="mode">
                    <Select
                      options={Object.entries(VALUE_MODE_LABELS).map(([value, label]) => ({
                        value: Number(value),
                        label,
                      }))}
                    />
                  </Form.Item>
                </div>
                {qTotalMode === 2 ? (
                  <>
                    <div style={{ width: 260 }}>
                      <Form.Item name={['q_total_cmd', 'delta_base']} label="delta_base">
                        <Select
                          options={Object.entries(DELTA_BASE_LABELS).map(([value, label]) => ({
                            value: Number(value),
                            label,
                          }))}
                        />
                      </Form.Item>
                    </div>
                    {qTotalDeltaBase === 3 ? (
                      <div style={{ flex: 1 }}>
                        <Form.Item name={['q_total_cmd', 'base_tag']} label="base_tag">
                          <Input placeholder="q_total_base_tag" />
                        </Form.Item>
                        <Form.Item label="从数据总线快速选择" style={{ marginTop: -8, marginBottom: 0 }}>
                          <Select
                            allowClear
                            showSearch
                            placeholder="可选：从数据总线点位回填 base_tag"
                            options={dataBusEndpointOptions}
                            value={groupTagPickerValues.q_total_base_tag}
                            loading={dataBusEndpointLoading}
                            notFoundContent="暂无可选点位，可继续手动输入"
                            onChange={(value) => handleSelectGroupEndpoint('q_total_base_tag', value)}
                            filterOption={(input, option) =>
                              String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                            }
                          />
                        </Form.Item>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </Card>
          )}

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
              scroll={{ x: 1240 }}
              locale={{ emptyText: '暂无成员，请添加' }}
            />
          </Card>
        </Form>
      </Modal>

      <Modal
        title="重命名 AVC 控制组"
        open={renameModalOpen}
        onOk={() => void handleRenameGroup()}
        onCancel={() => setRenameModalOpen(false)}
        width={520}
        destroyOnClose
      >
        <Form form={renameForm} layout="vertical" size="small">
          <Form.Item name="old_group_name" label="old_group_name">
            <Input disabled />
          </Form.Item>
          <Form.Item
            name="new_group_name"
            label="new_group_name"
            rules={[{ required: true, message: '请输入新的控制组名称' }]}
          >
            <Input placeholder="请输入新的 AVC 控制组名称" />
          </Form.Item>
          <Text type="secondary">
            仅 STOPPED 状态允许重命名；成功后会保留原 conn_id。
          </Text>
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
            可从数据总线快速选择成员点位来回填 tag。最终路由关系仍需在数据总线中配置。
          </Text>

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
              <Form.Item name="weight" label="weight">
                <InputNumber style={{ width: '100%' }} step={0.1} min={0} />
              </Form.Item>
            </div>
            <div style={{ flex: 1 }}>
              <Form.Item name="q_min_kvar" label="q_min_kvar">
                <InputNumber style={{ width: '100%' }} step={0.1} />
              </Form.Item>
            </div>
            <div style={{ flex: 1 }}>
              <Form.Item name="q_max_kvar" label="q_max_kvar">
                <InputNumber style={{ width: '100%' }} step={0.1} />
              </Form.Item>
            </div>
          </div>

          <Card title="q_meas" size="small" bordered style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <Form.Item name={['q_meas', 'tag']} label="tag">
                  <Input placeholder="pcs_1_q_meas" />
                </Form.Item>
                <Form.Item label="从数据总线快速选择" style={{ marginTop: -8, marginBottom: 0 }}>
                  <Select
                    allowClear
                    showSearch
                    placeholder="可选：从数据总线点位回填 q_meas"
                    options={dataBusEndpointOptions}
                    value={memberTagPickerValues.q_meas}
                    loading={dataBusEndpointLoading}
                    notFoundContent="暂无可选点位，可继续手动输入"
                    onChange={(value) => handleSelectMemberEndpoint('q_meas', value)}
                    filterOption={(input, option) =>
                      String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['q_meas', 'unit']} label="unit">
                  <Input placeholder="kVar" />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['q_meas', 'scale']} label="scale">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </div>
              <div style={{ width: 140 }}>
                <Form.Item name={['q_meas', 'offset']} label="offset">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </div>
            </div>
          </Card>

          {memberControllable ? (
            <Card title="q_set" size="small" bordered>
              <div style={{ display: 'flex', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <Form.Item name={['q_set', 'signal', 'tag']} label="tag">
                    <Input placeholder="pcs_1_q_set" />
                  </Form.Item>
                  <Form.Item label="从数据总线快速选择" style={{ marginTop: -8, marginBottom: 0 }}>
                    <Select
                      allowClear
                      showSearch
                      placeholder="可选：从数据总线点位回填 q_set"
                      options={dataBusEndpointOptions}
                      value={memberTagPickerValues.q_set}
                      loading={dataBusEndpointLoading}
                      notFoundContent="暂无可选点位，可继续手动输入"
                      onChange={(value) => handleSelectMemberEndpoint('q_set', value)}
                      filterOption={(input, option) =>
                        String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                      }
                    />
                  </Form.Item>
                </div>
                <div style={{ width: 140 }}>
                  <Form.Item name={['q_set', 'signal', 'unit']} label="unit">
                    <Input placeholder="kVar" />
                  </Form.Item>
                </div>
                <div style={{ width: 140 }}>
                  <Form.Item name={['q_set', 'signal', 'scale']} label="scale">
                    <InputNumber step={0.01} style={{ width: '100%' }} />
                  </Form.Item>
                </div>
                <div style={{ width: 140 }}>
                  <Form.Item name={['q_set', 'signal', 'offset']} label="offset">
                    <InputNumber step={0.01} style={{ width: '100%' }} />
                  </Form.Item>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16 }}>
                <div style={{ width: 260 }}>
                  <Form.Item name={['q_set', 'mode']} label="mode">
                    <Select
                      options={Object.entries(VALUE_MODE_LABELS).map(([value, label]) => ({
                        value: Number(value),
                        label,
                      }))}
                    />
                  </Form.Item>
                </div>
                {memberQSetMode === 2 ? (
                  <>
                    <div style={{ width: 260 }}>
                      <Form.Item name={['q_set', 'delta_base']} label="delta_base">
                        <Select
                          options={Object.entries(DELTA_BASE_LABELS).map(([value, label]) => ({
                            value: Number(value),
                            label,
                          }))}
                        />
                      </Form.Item>
                    </div>
                    {memberQSetDeltaBase === 3 ? (
                      <div style={{ flex: 1 }}>
                        <Form.Item name={['q_set', 'base_tag']} label="base_tag">
                          <Input placeholder="q_base_tag" />
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
                ) : null}
              </div>
            </Card>
          ) : (
            <Card title="q_set" size="small" bordered>
              <Text type="secondary">当前成员为不可控成员，不需要配置 q_set。</Text>
            </Card>
          )}
        </Form>
      </Modal>
    </div>
  );
};

export default AVC;
