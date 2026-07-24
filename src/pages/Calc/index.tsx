import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
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
import { api } from '../../adapters';
import type {
  CalcGroupInfo,
  CalcItemConfig,
  CalcOperandSpec,
  DcRoute,
} from '../../adapters';
import ResizableSplit from '../../components/layout/ResizableSplit';
import { formatErrorText, runWithRuntimeRestart } from '../../utils/runtime-restart';
import './index.css';

const { Text, Paragraph } = Typography;

const GROUP_STATE: Record<number, { label: string; color: string }> = {
  0: { label: '未指定', color: 'default' },
  1: { label: '已停止', color: 'default' },
  2: { label: '运行中', color: 'success' },
  3: { label: '待删除', color: 'warning' },
};

const OPERATOR_OPTIONS = [
  { label: '加法（+）', value: 1, group: '数值' },
  { label: '减法（-）', value: 2, group: '数值' },
  { label: '乘法（×）', value: 3, group: '数值' },
  { label: '除法（÷）', value: 4, group: '数值' },
  { label: '非（NOT）', value: 5, group: '逻辑' },
  { label: '与（AND）', value: 6, group: '逻辑' },
  { label: '或（OR）', value: 7, group: '逻辑' },
  { label: '异或（XOR）', value: 8, group: '逻辑' },
  { label: '求和（SUM）', value: 9, group: '聚合' },
  { label: '求平均（AVERAGE）', value: 10, group: '聚合' },
];

const NUMERIC_OPERATOR_KINDS = new Set([1, 2, 3, 4, 9, 10]);
const LOGIC_OPERATOR_KINDS = new Set([5, 6, 7, 8]);
const AGGREGATE_OPERATOR_KINDS = new Set([9, 10]);

type ConstantType = 'bool' | 'int' | 'double';
type OperandDraft = {
  sourceKind: number;
  constantType: ConstantType;
  constantValue: boolean | number;
};

type ItemDraft = {
  itemName: string;
  operatorKind: number;
  left: OperandDraft;
  right: OperandDraft;
  operands: OperandDraft[];
  decimalPlaces?: number;
};

const defaultOperand = (): OperandDraft => ({
  sourceKind: 1,
  constantType: 'double',
  constantValue: 0,
});

const defaultItem = (): ItemDraft => ({
  itemName: '',
  operatorKind: 1,
  left: defaultOperand(),
  right: defaultOperand(),
  operands: [defaultOperand(), defaultOperand()],
});

const operatorLabel = (operatorKind: number): string =>
  OPERATOR_OPTIONS.find((option) => option.value === operatorKind)?.label ?? `未知运算符 (${operatorKind})`;

const sourceLabel = (operand: CalcOperandSpec | null | undefined): string => {
  if (!operand || operand.source_kind === 1) return '数据总线点位';
  if (operand.source_kind !== 2 || !operand.constant) return '常量';
  const constant = operand.constant;
  if (constant.bool_value !== undefined) return `常量：${constant.bool_value ? '真' : '假'}`;
  if (constant.int_value !== undefined) return `常量：${constant.int_value}`;
  if (constant.double_value !== undefined) return `常量：${constant.double_value}`;
  return '常量';
};

const draftFromOperand = (operand: CalcOperandSpec | null | undefined): OperandDraft => {
  const constant = operand?.constant;
  if (constant?.bool_value !== undefined) {
    return { sourceKind: operand?.source_kind ?? 2, constantType: 'bool', constantValue: constant.bool_value };
  }
  if (constant?.int_value !== undefined) {
    return { sourceKind: operand?.source_kind ?? 2, constantType: 'int', constantValue: constant.int_value };
  }
  return {
    sourceKind: operand?.source_kind ?? 1,
    constantType: 'double',
    constantValue: constant?.double_value ?? 0,
  };
};

const draftFromItem = (item: CalcItemConfig): ItemDraft => ({
  itemName: item.item_name,
  operatorKind: item.operator_kind,
  left: draftFromOperand(item.left_operand),
  right: draftFromOperand(item.right_operand),
  operands: (item.operands?.length ? item.operands : [item.left_operand, item.right_operand].filter(Boolean) as CalcOperandSpec[]).map(draftFromOperand),
  decimalPlaces: item.decimal_places,
});

const normalizeConstantValue = (draft: OperandDraft): CalcOperandSpec => {
  if (draft.sourceKind !== 2) return { source_kind: 1, constant: null };
  if (draft.constantType === 'bool') {
    return { source_kind: 2, constant: { bool_value: Boolean(draft.constantValue) } };
  }
  if (draft.constantType === 'int') {
    return { source_kind: 2, constant: { int_value: Number(draft.constantValue) || 0 } };
  }
  return { source_kind: 2, constant: { double_value: Number(draft.constantValue) || 0 } };
};

const itemToConfig = (draft: ItemDraft): CalcItemConfig => ({
  item_name: draft.itemName.trim(),
  operator_kind: draft.operatorKind,
  left_operand: AGGREGATE_OPERATOR_KINDS.has(draft.operatorKind) ? null : normalizeConstantValue(draft.left),
  right_operand: AGGREGATE_OPERATOR_KINDS.has(draft.operatorKind) || draft.operatorKind === 5
    ? null
    : normalizeConstantValue(draft.right),
  operands: AGGREGATE_OPERATOR_KINDS.has(draft.operatorKind)
    ? draft.operands.map(normalizeConstantValue)
    : [],
  decimal_places: draft.operatorKind === 10 ? draft.decimalPlaces : undefined,
});

const draftKey = (draft: ItemDraft): string => JSON.stringify(draft);

const calcEndpointPath = (groupName: string, itemName: string, tag: string): string => (
  `Calc/${groupName}/${itemName}/${tag}`
);

const routeEndpointLabel = (endpoint: DcRoute['src']): string => (
  `${endpoint.module_name}/${endpoint.conn_name}/${endpoint.tag}`
);

const CalcPage: React.FC = () => {
  const [groups, setGroups] = useState<CalcGroupInfo[]>([]);
  const [routes, setRoutes] = useState<DcRoute[]>([]);
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupModalMode, setGroupModalMode] = useState<'create' | 'rename'>('create');
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [groupInitialDraft, setGroupInitialDraft] = useState<string | null>(null);
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItemIndex, setEditingItemIndex] = useState<number | null>(null);
  const [itemDraft, setItemDraft] = useState<ItemDraft>(defaultItem);
  const [itemInitialSnapshot, setItemInitialSnapshot] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const selectedGroup = useMemo(
    () => groups.find((group) => group.config?.group_name === selectedGroupName) ?? null,
    [groups, selectedGroupName],
  );
  const selectedConfig = selectedGroup?.config ?? null;

  const getGroupState = useCallback(async (groupName: string): Promise<number | null> => {
    const group = await api.calcGetGroup(groupName);
    return group.state;
  }, []);

  const runSelectedGroupStopped = useCallback(
    async (
      operation: () => Promise<void>,
      options?: {
        initialState?: number | null;
        originalGroupName?: string;
        restartGroupName?: string;
      },
    ) => {
      const originalGroupName = options?.originalGroupName ?? selectedGroupName;
      if (!originalGroupName) {
        await operation();
        return {
          stoppedBeforeRun: false,
          restartedAfterRun: false,
          retriedAfterRunningPrecondition: false,
          restartError: null,
        };
      }

      const restartGroupName = options?.restartGroupName ?? originalGroupName;
      return runWithRuntimeRestart({
        initialState: options?.initialState ?? selectedGroup?.state ?? null,
        loadState: () => getGroupState(originalGroupName),
        stop: () => api.calcStopGroup(originalGroupName),
        run: operation,
        start: () => api.calcStartGroup(restartGroupName),
        restoreStart: () => api.calcStartGroup(originalGroupName),
        failOnRestartError: false,
      });
    },
    [getGroupState, selectedGroup?.state, selectedGroupName],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextGroups, nextRoutes] = await Promise.all([
        api.calcListGroups(),
        api.dcListRoutes(0, '', 0, '').catch(() => []),
      ]);
      setGroups(nextGroups);
      setRoutes(nextRoutes);
      setSelectedGroupName((current) => {
        if (current && nextGroups.some((group) => group.config?.group_name === current)) return current;
        return nextGroups[0]?.config?.group_name ?? null;
      });
    } catch (error) {
      messageApi.error(`刷新数值计算分组失败：${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openCreateGroup = () => {
    setGroupModalMode('create');
    const draft = `计算组${groups.length + 1}`;
    setGroupNameDraft(draft);
    setGroupInitialDraft(draft);
    setGroupModalOpen(true);
  };

  const openRenameGroup = () => {
    if (!selectedConfig) return;
    setGroupModalMode('rename');
    setGroupNameDraft(selectedConfig.group_name);
    setGroupInitialDraft(selectedConfig.group_name);
    setGroupModalOpen(true);
  };

  const groupNameError = useMemo(() => {
    const name = groupNameDraft.trim();
    if (!name) return '请输入分组名称';
    const duplicate = groups.some((group) => {
      const currentName = group.config?.group_name;
      return currentName === name && (groupModalMode === 'create' || currentName !== selectedConfig?.group_name);
    });
    return duplicate ? '分组名称已存在' : undefined;
  }, [groupNameDraft, groupModalMode, groups, selectedConfig?.group_name]);

  const closeGroupModal = () => {
    if (groupInitialDraft !== null && groupNameDraft !== groupInitialDraft) {
      Modal.confirm({
        title: '放弃未保存修改？',
        content: '当前分组名称尚未保存，确定关闭吗？',
        okText: '放弃修改',
        cancelText: '继续编辑',
        onOk: () => {
          setGroupModalOpen(false);
          setGroupInitialDraft(null);
        },
      });
      return;
    }
    setGroupModalOpen(false);
    setGroupInitialDraft(null);
  };

  const saveGroup = async () => {
    const name = groupNameDraft.trim();
    if (groupNameError) {
      messageApi.warning(groupNameError);
      return;
    }
    try {
      if (groupModalMode === 'create') {
        await api.calcUpsertGroup({
          group_name: name,
          items: [{
            item_name: '计算项1',
            operator_kind: 1,
            left_operand: { source_kind: 1, constant: null },
            right_operand: { source_kind: 2, constant: { double_value: 0 } },
            operands: [],
          }],
        }, true);
        messageApi.success('计算分组已创建');
      } else if (selectedConfig && name !== selectedConfig.group_name) {
        const oldName = selectedConfig.group_name;
        const restartResult = await runSelectedGroupStopped(
          () => api.calcRenameGroup(oldName, name).then(() => undefined),
          { originalGroupName: oldName, restartGroupName: name },
        );
        console.info('Calc 计算分组重命名完成', {
          groupName: oldName,
          nextGroupName: name,
          restarted: restartResult.restartedAfterRun,
        });
        if (restartResult.restartError) {
          messageApi.warning(`计算分组已重命名，但重新启动失败：${formatErrorText(restartResult.restartError)}`);
        } else if (restartResult.stoppedBeforeRun) {
          messageApi.success('计算分组已重命名并重新启动');
        } else {
          messageApi.success('计算分组已重命名');
        }
      }
      setGroupModalOpen(false);
      setGroupInitialDraft(null);
      setSelectedGroupName(name);
      await refresh();
    } catch (error) {
      messageApi.error(`保存分组失败：${formatErrorText(error)}`);
    }
  };

  const deleteGroup = async () => {
    if (!selectedConfig) return;
    try {
      await api.calcDeleteGroup(selectedConfig.group_name);
      messageApi.success('计算分组已删除');
      await refresh();
    } catch (error) {
      messageApi.error(`删除分组失败：${String(error)}`);
    }
  };

  const toggleGroup = async () => {
    if (!selectedConfig || !selectedGroup) return;
    try {
      if (selectedGroup.state === 2) {
        await api.calcStopGroup(selectedConfig.group_name);
        messageApi.success('计算分组已停止');
      } else {
        await api.calcStartGroup(selectedConfig.group_name);
        messageApi.success('计算分组已启动');
      }
      await refresh();
    } catch (error) {
      messageApi.error(`切换分组状态失败：${String(error)}`);
    }
  };

  const openCreateItem = () => {
    if (!selectedConfig) return;
    setEditingItemIndex(null);
    const draft = { ...defaultItem(), itemName: `计算项${selectedConfig.items.length + 1}` };
    setItemDraft(draft);
    setItemInitialSnapshot(draftKey(draft));
    setItemModalOpen(true);
  };

  const openEditItem = (index: number) => {
    const item = selectedConfig?.items[index];
    if (!item) return;
    setEditingItemIndex(index);
    const draft = draftFromItem(item);
    setItemDraft(draft);
    setItemInitialSnapshot(draftKey(draft));
    setItemModalOpen(true);
  };

  const itemNameError = useMemo(() => {
    const name = itemDraft.itemName.trim();
    if (!name) return '请输入计算项名称';
    const duplicate = selectedConfig?.items.some((item, index) => item.item_name === name && index !== editingItemIndex);
    return duplicate ? '同一分组内计算项名称不能重复' : undefined;
  }, [editingItemIndex, itemDraft.itemName, selectedConfig]);

  const isAggregate = AGGREGATE_OPERATOR_KINDS.has(itemDraft.operatorKind);
  const usesRightOperand = itemDraft.operatorKind !== 5 && !isAggregate;
  const draftOperands = isAggregate ? itemDraft.operands : [itemDraft.left, ...(usesRightOperand ? [itemDraft.right] : [])];
  const hasExternalInput = draftOperands.some((operand) => operand.sourceKind === 1);
  const inputRequirementError = isAggregate || hasExternalInput ? undefined : '至少保留一侧使用数据总线点位';
  const divisorError = itemDraft.operatorKind === 4
    && itemDraft.right.sourceKind === 2
    && Number(itemDraft.right.constantValue) === 0
    ? '除数不能为 0'
    : undefined;

  const operandTypeError = (operand: OperandDraft, operatorKind = itemDraft.operatorKind): string | undefined => {
    if (operand.sourceKind !== 2) return undefined;
    if (LOGIC_OPERATOR_KINDS.has(operatorKind) && operand.constantType !== 'bool') {
      return '逻辑运算的常量必须是 bool';
    }
    if (NUMERIC_OPERATOR_KINDS.has(operatorKind) && operand.constantType === 'bool') {
      return '数值运算的常量必须是 int64 或 double';
    }
    return undefined;
  };

  const closeItemModal = () => {
    if (itemInitialSnapshot !== null && draftKey(itemDraft) !== itemInitialSnapshot) {
      Modal.confirm({
        title: '放弃未保存修改？',
        content: '当前计算项尚未保存，确定关闭吗？',
        okText: '放弃修改',
        cancelText: '继续编辑',
        onOk: () => {
          setItemModalOpen(false);
          setItemInitialSnapshot(null);
        },
      });
      return;
    }
    setItemModalOpen(false);
    setItemInitialSnapshot(null);
  };

  const saveItem = async () => {
    if (!selectedConfig) return;
    const item = itemToConfig(itemDraft);
    if (itemNameError) {
      messageApi.warning(itemNameError);
      return;
    }
    if (NUMERIC_OPERATOR_KINDS.has(item.operator_kind)) {
      const operands = isAggregate ? item.operands : [item.left_operand, item.right_operand];
      const valid = operands.every((operand) => {
        if (!operand || operand.source_kind !== 2) return true;
        return Boolean(operand.constant?.int_value !== undefined || operand.constant?.double_value !== undefined);
      });
      if (!valid) {
        messageApi.warning('数值运算的常量必须是 int64 或 double');
        return;
      }
    }
    if (LOGIC_OPERATOR_KINDS.has(item.operator_kind)) {
      const valid = [item.left_operand, item.right_operand].filter(Boolean).every((operand) => {
        if (!operand || operand.source_kind !== 2) return true;
        return operand.constant?.bool_value !== undefined;
      });
      if (!valid) {
        messageApi.warning('逻辑运算的常量必须是 bool');
        return;
      }
    }
    if (isAggregate && item.operands.length < 2) {
      messageApi.warning('求和/求平均至少需要两个操作数');
      return;
    }
    if (item.operator_kind === 10 && item.decimal_places !== undefined && (item.decimal_places < 0 || item.decimal_places > 15)) {
      messageApi.warning('平均值小数位数必须为 0 到 15');
      return;
    }
    if (inputRequirementError) {
      messageApi.warning(inputRequirementError);
      return;
    }
    if (divisorError) {
      messageApi.warning(divisorError);
      return;
    }
    const items = [...selectedConfig.items];
    if (editingItemIndex === null) items.push(item);
    else items[editingItemIndex] = item;
    try {
      const restartResult = await runSelectedGroupStopped(
        () => api.calcUpsertGroup({ ...selectedConfig, items }, false).then(() => undefined),
      );
      console.info('Calc 计算项保存完成', {
        groupName: selectedConfig.group_name,
        itemName: item.item_name,
        restarted: restartResult.restartedAfterRun,
      });
      setItemModalOpen(false);
      setItemInitialSnapshot(null);
      if (restartResult.restartError) {
        messageApi.warning(`计算项已保存，但重新启动失败：${formatErrorText(restartResult.restartError)}`);
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success(editingItemIndex === null ? '计算项已添加并重新启动' : '计算项已更新并重新启动');
      } else {
        messageApi.success(editingItemIndex === null ? '计算项已添加' : '计算项已更新');
      }
      await refresh();
    } catch (error) {
      messageApi.error(`保存计算项失败：${formatErrorText(error)}`);
    }
  };

  const deleteItem = async (index: number) => {
    if (!selectedConfig) return;
    if (selectedConfig.items.length <= 1) {
      messageApi.warning('计算分组至少保留一个计算项');
      return;
    }
    const items = selectedConfig.items.filter((_, itemIndex) => itemIndex !== index);
    try {
      const restartResult = await runSelectedGroupStopped(
        () => api.calcUpsertGroup({ ...selectedConfig, items }, false).then(() => undefined),
      );
      console.info('Calc 计算项删除完成', {
        groupName: selectedConfig.group_name,
        deletedItemIndex: index,
        restarted: restartResult.restartedAfterRun,
      });
      if (restartResult.restartError) {
        messageApi.warning(`计算项已删除，但重新启动失败：${formatErrorText(restartResult.restartError)}`);
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success('计算项已删除并重新启动');
      } else {
        messageApi.success('计算项已删除');
      }
      await refresh();
    } catch (error) {
      messageApi.error(`删除计算项失败：${formatErrorText(error)}`);
    }
  };

  const updateOperand = (index: number, patch: Partial<OperandDraft>) => {
    setItemDraft((current) => {
      if (AGGREGATE_OPERATOR_KINDS.has(current.operatorKind)) {
        return {
          ...current,
          operands: current.operands.map((operand, operandIndex) => operandIndex === index ? { ...operand, ...patch } : operand),
        };
      }
      const side = index === 0 ? 'left' : 'right';
      return { ...current, [side]: { ...current[side], ...patch } };
    });
  };

  const updateOperator = (operatorKind: number) => {
    setItemDraft((current) => {
      const nextIsLogic = LOGIC_OPERATOR_KINDS.has(operatorKind);
      const normalize = (operand: OperandDraft): OperandDraft => {
        if (operand.sourceKind !== 2) return operand;
        if (nextIsLogic) return { ...operand, constantType: 'bool', constantValue: false };
        if (operand.constantType === 'bool') return { ...operand, constantType: 'double', constantValue: 0 };
        return operand;
      };
      const normalizedOperands = current.operands.map(normalize);
      return {
        ...current,
        operatorKind,
        left: normalize(current.left),
        right: normalize(current.right),
        operands: normalizedOperands.length >= 2
          ? normalizedOperands
          : [normalize(current.left), normalize(current.right)],
      };
    });
  };

  const itemInfoByName = useMemo(
    () => new Map((selectedGroup?.items ?? []).flatMap((item) => (
      item.config ? [[item.config.item_name, item] as const] : []
    ))),
    [selectedGroup],
  );

  const findInputRoute = useCallback((groupName: string, tag: string): DcRoute | undefined => (
    routes.find((route) => (
      route.dst.module_name === 'Calc'
      && route.dst.conn_name === groupName
      && route.dst.tag === tag
    ))
  ), [routes]);

  const findOutputRoute = useCallback((groupName: string, tag: string): DcRoute | undefined => (
    routes.find((route) => (
      route.src.module_name === 'Calc'
      && route.src.conn_name === groupName
      && route.src.tag === tag
    ))
  ), [routes]);

  const configuredOperands = (item: CalcItemConfig): CalcOperandSpec[] => {
    if (AGGREGATE_OPERATOR_KINDS.has(item.operator_kind)) return item.operands ?? [];
    return [item.left_operand, ...(item.operator_kind === 5 ? [] : [item.right_operand])].filter(Boolean) as CalcOperandSpec[];
  };

  const renderBoundInput = (item: CalcItemConfig, index: number): React.ReactNode => {
    const operand = configuredOperands(item)[index];
    if (!operand) return <Text type="secondary">未配置</Text>;
    if (operand.source_kind !== 1) return sourceLabel(operand);
    const info = itemInfoByName.get(item.item_name);
    const fallbackTag = index === 0 ? info?.left_input_tag : index === 1 ? info?.right_input_tag : undefined;
    const tag = info?.input_tags?.[index] ?? fallbackTag;
    const status = info?.operand_status?.find((value) => value.index === index);
    const route = selectedConfig && tag ? findInputRoute(selectedConfig.group_name, tag) : undefined;
    if (status && !status.ready) {
      return <Space size={4} wrap>
        {!route ? <Tag color="orange">未绑定</Tag> : <Tag color="red">未就绪</Tag>}
        <Text type="danger">{!route ? '未配置路由；' : ''}{status.reason || '尚未收到输入'}</Text>
      </Space>;
    }
    return route
      ? <Space size={4} wrap><Tag color="green">已绑定</Tag><Text ellipsis={{ tooltip: routeEndpointLabel(route.src) }}>{routeEndpointLabel(route.src)}</Text></Space>
      : <Space size={4} wrap><Tag color="orange">未绑定</Tag>{tag ? <Text type="secondary">目标：{tag}</Text> : null}</Space>;
  };

  const renderBoundInputs = (item: CalcItemConfig): React.ReactNode => (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      {configuredOperands(item).map((_, index) => (
        <Space key={`${item.item_name}-${index}`} size={4} align="start">
          <Text type="secondary">输入{index + 1}</Text>
          {renderBoundInput(item, index)}
        </Space>
      ))}
    </Space>
  );

  const renderBoundOutput = (item: CalcItemConfig): React.ReactNode => {
    const info = itemInfoByName.get(item.item_name);
    const route = selectedConfig && info ? findOutputRoute(selectedConfig.group_name, info.result_tag) : undefined;
    return route
      ? <Space size={4}><Tag color="green">已绑定</Tag><Text ellipsis={{ tooltip: routeEndpointLabel(route.dst) }}>{routeEndpointLabel(route.dst)}</Text></Space>
      : <Tag color="orange">未绑定</Tag>;
  };

  const itemColumns: ColumnsType<CalcItemConfig> = [
    { title: '计算项', dataIndex: 'item_name', key: 'item_name', width: 150, render: (name: string) => <Text strong>{name}</Text> },
    { title: '运算', dataIndex: 'operator_kind', key: 'operator_kind', width: 130, render: (kind: number) => operatorLabel(kind) },
    { title: '输入点 / 状态', key: 'inputs', width: 300, render: (_, item) => renderBoundInputs(item) },
    { title: '诊断', key: 'diagnostic', width: 220, render: (_, item) => {
      const info = itemInfoByName.get(item.item_name);
      return info?.last_error ? <Text type="danger" ellipsis={{ tooltip: info.last_error }}>{info.last_error}</Text> : <Text type="secondary">输入已就绪或尚未运行</Text>;
    } },
    { title: '结果输出点', key: 'result_output', width: 230, render: (_, item) => renderBoundOutput(item) },
    {
      title: '操作', key: 'actions', width: 140, render: (_, item) => {
        const index = selectedConfig?.items.indexOf(item) ?? -1;
        return <Space><Button size="small" icon={<EditOutlined />} onClick={() => openEditItem(index)}>编辑</Button><Popconfirm title="确认删除此计算项？" onConfirm={() => void deleteItem(index)}><Button size="small" danger icon={<DeleteOutlined />} /></Popconfirm></Space>;
      },
    },
  ];

  const renderOperand = (index: number, label: string) => {
    const aggregate = AGGREGATE_OPERATOR_KINDS.has(itemDraft.operatorKind);
    const operand = aggregate ? itemDraft.operands[index] : index === 0 ? itemDraft.left : itemDraft.right;
    if (!operand) return null;
    const isLogic = LOGIC_OPERATOR_KINDS.has(itemDraft.operatorKind);
    const effectiveType: ConstantType = isLogic ? 'bool' : operand.constantType === 'bool' ? 'double' : operand.constantType;
    const side = index === 0 ? 'left' : 'right';
    const endpoint = selectedConfig && itemDraft.itemName.trim()
      ? calcEndpointPath(selectedConfig.group_name, itemDraft.itemName.trim(), aggregate ? `input_${index + 1}` : `${side}_input`)
      : null;
    const itemInfo = itemInfoByName.get(itemDraft.itemName.trim());
    const inputTag = itemInfo?.input_tags?.[index] ?? (side === 'left' ? itemInfo?.left_input_tag : itemInfo?.right_input_tag);
    const boundRoute = selectedConfig && inputTag ? findInputRoute(selectedConfig.group_name, inputTag) : undefined;
    const typeError = operandTypeError(operand);
    const sourceError = inputRequirementError && index === 0 ? inputRequirementError : undefined;
    const endpointRole = aggregate ? `输入${index + 1}` : side === 'left' ? '左输入点' : '右输入点';
    return <div className="calc-operand-editor">
      <Text strong>{label}</Text>
      <Form.Item
        validateStatus={sourceError ? 'error' : undefined}
        help={sourceError}
        style={{ marginBottom: 0 }}
      >
        <Select value={operand.sourceKind} onChange={(value) => updateOperand(index, { sourceKind: value })} options={[{ label: '数据总线点位', value: 1 }, { label: '常量', value: 2 }]} />
      </Form.Item>
      {operand.sourceKind === 2 ? <>
        <Form.Item
          validateStatus={typeError ? 'error' : undefined}
          help={typeError}
          style={{ marginBottom: 0 }}
        >
          <Select value={effectiveType} onChange={(value: ConstantType) => updateOperand(index, { constantType: value, constantValue: value === 'bool' ? false : 0 })} options={isLogic ? [{ label: 'bool', value: 'bool' }] : [{ label: 'int64', value: 'int' }, { label: 'double', value: 'double' }]} />
        </Form.Item>
        {effectiveType === 'bool' ? <Select value={Boolean(operand.constantValue)} onChange={(value) => updateOperand(index, { constantValue: value })} options={[{ label: '真', value: true }, { label: '假', value: false }]} /> : <InputNumber style={{ width: '100%' }} value={Number(operand.constantValue)} precision={effectiveType === 'int' ? 0 : undefined} status={index === 1 && divisorError ? 'error' : undefined} onChange={(value) => updateOperand(index, { constantValue: value ?? 0 })} />}
        {index === 1 && divisorError ? <Text type="danger">{divisorError}</Text> : null}
      </> : <Space direction="vertical" size={4} className="calc-endpoint-info">
        <Space size={6} wrap>
          <Text type="secondary">{endpointRole}</Text>
          {boundRoute ? <Tag color="green">已绑定：{routeEndpointLabel(boundRoute.src)}</Tag> : <Tag color="orange">未绑定</Tag>}
        </Space>
        {endpoint ? <Text type="secondary">数据总线目标槽位：<Text code copyable={{ text: endpoint }}>{endpoint}</Text></Text> : <Text type="secondary">填写计算项名称后生成内部点路径</Text>}
      </Space>}
    </div>;
  };

  const renderAggregateOperand = (index: number): React.ReactNode => {
    const operand = itemDraft.operands[index];
    if (!operand) return null;
    const itemInfo = itemInfoByName.get(itemDraft.itemName.trim());
    const inputTag = itemInfo?.input_tags?.[index] ?? `${itemDraft.itemName.trim()}/input_${index + 1}`;
    const boundRoute = selectedConfig && inputTag ? findInputRoute(selectedConfig.group_name, inputTag) : undefined;
    const status = itemInfo?.operand_status?.find((value) => value.index === index);
    const typeError = operandTypeError(operand);
    const effectiveType: ConstantType = operand.constantType === 'bool' ? 'double' : operand.constantType;
    const endpoint = selectedConfig && itemDraft.itemName.trim()
      ? calcEndpointPath(selectedConfig.group_name, itemDraft.itemName.trim(), `input_${index + 1}`)
      : null;
    return <div className="calc-aggregate-row">
      <span className="calc-aggregate-index">{String(index + 1).padStart(2, '0')}</span>
      <Select
        className="calc-aggregate-source"
        value={operand.sourceKind}
        onChange={(value) => updateOperand(index, { sourceKind: value })}
        options={[{ label: '数据总线点位', value: 1 }, { label: '常量', value: 2 }]}
      />
      {operand.sourceKind === 2 ? <Space className="calc-aggregate-value" size={8} wrap>
        <Select
          className="calc-aggregate-type"
          value={effectiveType}
          onChange={(value: ConstantType) => updateOperand(index, { constantType: value, constantValue: value === 'bool' ? false : 0 })}
          options={[{ label: 'int64', value: 'int' }, { label: 'double', value: 'double' }]}
        />
        <InputNumber
          className="calc-aggregate-number"
          value={Number(operand.constantValue)}
          precision={effectiveType === 'int' ? 0 : undefined}
          onChange={(value) => updateOperand(index, { constantValue: value ?? 0 })}
        />
      </Space> : <div className="calc-aggregate-route">
        <Text type="secondary" ellipsis={{ tooltip: endpoint ?? undefined }}>{endpoint ?? '填写计算项名称后生成目标槽位'}</Text>
        {boundRoute ? <Tag color="green">已绑定：{routeEndpointLabel(boundRoute.src)}</Tag> : <Tag color="orange">未绑定</Tag>}
      </div>}
      <div className="calc-aggregate-status">
        {typeError ? <Text type="danger">{typeError}</Text> : status && !status.ready ? <Text type="danger">{status.reason || '尚未收到输入'}</Text> : null}
      </div>
      {index >= 2 ? <Button
        type="text"
        danger
        aria-label={`移除输入${index + 1}`}
        icon={<DeleteOutlined />}
        onClick={() => setItemDraft((current) => ({ ...current, operands: current.operands.filter((__, operandIndex) => operandIndex !== index) }))}
      /> : <span className="calc-aggregate-action-placeholder" />}
    </div>;
  };

  return <div className="calc-page">
    {contextHolder}
    <Card className="calc-toolbar" size="small">
      <Space wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreateGroup}>新建分组</Button>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>刷新</Button>
        {selectedConfig ? <><Button icon={<EditOutlined />} onClick={openRenameGroup}>重命名</Button><Popconfirm title="确认删除该计算分组？" onConfirm={() => void deleteGroup()}><Button danger icon={<DeleteOutlined />}>删除分组</Button></Popconfirm><Button type={selectedGroup?.state === 2 ? 'default' : 'primary'} icon={selectedGroup?.state === 2 ? <PauseCircleOutlined /> : <PlayCircleOutlined />} onClick={() => void toggleGroup()}>{selectedGroup?.state === 2 ? '停止分组' : '启动分组'}</Button></> : null}
      </Space>
    </Card>
    <ResizableSplit
      className="calc-content"
      defaultSize={400}
      minSize={280}
      maxSize={620}
      storageKey="mskdsp.layout.calc-groups"
    >
      <Card
        title="计算分组"
        size="small"
        className="calc-groups-card"
        style={{ width: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}
        styles={{ body: { flex: 1, minHeight: 0, padding: 0, overflow: 'auto' } }}
      >
        <Table<CalcGroupInfo> rowKey={(record) => record.config?.group_name ?? String(record.conn_id)} size="small" loading={loading} pagination={false} dataSource={groups} rowClassName={(record) => record.config?.group_name === selectedGroupName ? 'calc-selected-row' : ''} onRow={(record) => ({ onClick: () => setSelectedGroupName(record.config?.group_name ?? null) })} columns={[{ title: '名称', key: 'name', render: (_, record) => record.config?.group_name ?? '-' }, { title: '状态', key: 'state', width: 90, render: (_, record) => { const state = GROUP_STATE[record.state] ?? GROUP_STATE[0]; return <Tag color={state.color}>{state.label}</Tag>; } }, { title: '项数', key: 'items', width: 60, render: (_, record) => record.config?.items.length ?? 0 }]} />
      </Card>
      <Card
        title={selectedConfig ? `${selectedConfig.group_name} · 计算项` : '请选择计算分组'}
        size="small"
        className="calc-items-card"
        style={{ width: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}
        styles={{ body: { flex: 1, minHeight: 0, overflow: 'auto' } }}
        extra={selectedConfig ? <Text type="secondary">conn_id: {selectedGroup?.conn_id}</Text> : null}
      >
        {selectedConfig ? <>
          {selectedGroup?.last_error ? <Paragraph type="danger" className="calc-error">{selectedGroup.last_error}</Paragraph> : null}
          <Paragraph type="secondary">数据总线绑定状态会显示在输入点和结果输出点旁；点击“刷新”可同步最新路由。</Paragraph>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateItem}>新增计算项</Button>
          <Divider style={{ margin: '12px 0' }} />
          <Table<CalcItemConfig> rowKey="item_name" size="small" dataSource={selectedConfig.items} columns={itemColumns} pagination={false} scroll={{ x: 1170 }} locale={{ emptyText: '暂无计算项，请新增一项运算' }} />
        </> : <div className="calc-empty">暂无计算分组，请先新建。</div>}
      </Card>
    </ResizableSplit>
    <Modal title={groupModalMode === 'create' ? '新建计算分组' : '重命名计算分组'} open={groupModalOpen} onCancel={closeGroupModal} onOk={() => void saveGroup()} okText="保存" cancelText="取消">
      <Form layout="vertical"><Form.Item label="分组名称" required validateStatus={groupNameError ? 'error' : undefined} help={groupNameError}><Input autoFocus value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} onPressEnter={() => void saveGroup()} /></Form.Item></Form>
    </Modal>
    <Modal className="calc-item-modal" centered title={editingItemIndex === null ? '新增计算项' : '编辑计算项'} open={itemModalOpen} width="min(920px, calc(100vw - 32px))" styles={{ body: { maxHeight: 'min(680px, calc(100vh - 220px))', overflowY: 'auto', paddingInline: 24 } }} onCancel={closeItemModal} onOk={() => void saveItem()} okText="保存" cancelText="取消">
      <Form layout="vertical">
        <Row gutter={16}><Col span={12}><Form.Item label="计算项名称" required validateStatus={itemNameError ? 'error' : undefined} help={itemNameError}><Input placeholder="例如：总功率" value={itemDraft.itemName} onChange={(event) => setItemDraft((current) => ({ ...current, itemName: event.target.value }))} /></Form.Item></Col><Col span={12}><Form.Item label="运算符" required><Select value={itemDraft.operatorKind} onChange={updateOperator} options={OPERATOR_OPTIONS.map(({ label, value }) => ({ label, value }))} /></Form.Item></Col></Row>
        {isAggregate ? <>
          <div className="calc-section-heading"><Text strong>输入配置</Text><Text type="secondary">{itemDraft.operands.length} 个操作数</Text></div>
          {itemDraft.operatorKind === 10 ? <Form.Item className="calc-average-precision" label="平均值小数位数" help="不填写表示不主动舍入，范围 0 到 15"><InputNumber min={0} max={15} precision={0} value={itemDraft.decimalPlaces} placeholder="不舍入" style={{ width: 180 }} onChange={(value) => setItemDraft((current) => ({ ...current, decimalPlaces: value === null ? undefined : value }))} /></Form.Item> : null}
          <div className="calc-aggregate-list">
            <div className="calc-aggregate-list-header"><span>序号</span><span>输入来源</span><span>值 / 目标槽位</span><span>状态</span><span /></div>
            {itemDraft.operands.map((_, index) => <React.Fragment key={`operand-${index}`}>{renderAggregateOperand(index)}</React.Fragment>)}
          </div>
          <Button icon={<PlusOutlined />} onClick={() => setItemDraft((current) => ({ ...current, operands: [...current.operands, defaultOperand()] }))}>增加操作数</Button>
          <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>求和和求平均会等待所有数据总线输入到齐；常量可以与路由输入混合，也可以全部使用常量。</Paragraph>
        </> : <Row gutter={16}><Col xs={24} sm={12}>{renderOperand(0, '左输入点')}</Col><Col xs={24} sm={12}>{itemDraft.operatorKind === 5 ? <div className="calc-operand-editor"><Text strong>右输入点</Text><Text type="secondary">NOT 为单目运算，右输入点不会参与计算。</Text></div> : renderOperand(1, '右输入点')}</Col></Row>}
        {selectedConfig && itemDraft.itemName.trim() ? (() => {
          const itemInfo = itemInfoByName.get(itemDraft.itemName.trim());
          const resultRoute = itemInfo ? findOutputRoute(selectedConfig.group_name, itemInfo.result_tag) : undefined;
          const resultEndpoint = calcEndpointPath(selectedConfig.group_name, itemDraft.itemName.trim(), 'result');
          return <div className="calc-result-settings">
            <div className="calc-section-heading"><Text strong>输出设置</Text><Text type="secondary">结果点</Text></div>
            <div className="calc-result-endpoint">
            <Space size={8} wrap>
              <Text type="secondary">结果输出点</Text>
              {resultRoute ? <Tag color="green">已绑定：{routeEndpointLabel(resultRoute.dst)}</Tag> : <Tag color="orange">未绑定</Tag>}
              <Text type="secondary">数据总线源点：</Text>
              <Text code copyable={{ text: resultEndpoint }}>{resultEndpoint}</Text>
            </Space>
            </div>
          </div>;
        })() : null}
      </Form>
    </Modal>
  </div>;
};

export default CalcPage;
