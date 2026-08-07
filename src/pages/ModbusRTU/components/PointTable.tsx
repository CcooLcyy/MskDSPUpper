import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import {
  ClearOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FilterOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { DcSourcePointUpdate, ModbusPoint, ModbusReadPlan } from '../../../adapters';
import {
  type ProtocolRealtimeCellRevision,
  renderProtocolRealtimeQualityCell,
  renderProtocolRealtimeTimestampCell,
  renderProtocolRealtimeValueCell,
} from '../../../components/protocol/protocol-realtime';
import {
  MODBUS_FUNCTION,
  buildReadPlanBlocks,
  getCoveredReadPlanTags,
  getMinimumAddress,
  isExplicitReadFunction,
} from '../modbus-form-rules';

const { Text } = Typography;

const FUNCTION_CODE_LABELS: Record<number, string> = {
  0: '未指定',
  1: '0x01 读线圈',
  2: '0x03 读保持寄存器',
  3: '0x04 读输入寄存器',
  4: '0x06 写单寄存器',
  5: '0x10 写多寄存器',
};

const DATA_TYPE_LABELS: Record<number, string> = {
  0: '未指定',
  1: 'BOOL',
  2: 'UINT16',
  3: 'UINT32',
  4: 'INT16',
  5: 'INT32',
};

const WORD_ORDER_LABELS: Record<number, string> = { 0: '默认 (HL)', 1: 'HL', 2: 'LH' };
const BYTE_ORDER_LABELS: Record<number, string> = { 0: '默认 (AB)', 1: 'AB', 2: 'BA' };
const READ_PLAN_COLLAPSE_THRESHOLD = 4;
const MODBUS_MAX_ADDRESS = 65535;
const MODBUS_MAX_READ_QUANTITY = 125;

type PointTableView = 'config' | 'runtime';

interface ReadPlanValidation {
  invalidIndexes: Set<number>;
  overlapIndexes: Set<number>;
  issuesByIndex: Map<number, string[]>;
}

interface Props {
  points: ModbusPoint[];
  selectedConn: string | null;
  realtimeByTag: Record<string, DcSourcePointUpdate>;
  realtimeRevisionByTag: Record<string, ProtocolRealtimeCellRevision>;
  realtimeLoading: boolean;
  pointsLoading: boolean;
  actionsDisabled: boolean;
  readPlan: ModbusReadPlan | null;
  addressBase: number;
  readPlanSaving: boolean;
  runtimeRunning: boolean;
  onReadPlanSave: (readPlan: ModbusReadPlan) => Promise<boolean>;
  onReadPlanDirtyChange?: (dirty: boolean) => void;
  onAdd: () => void;
  onEdit: (index: number) => void;
  onCopy: (index: number) => void;
  onDelete: (index: number) => void;
  onDeleteAll: () => void;
}

const PointTable: React.FC<Props> = ({
  points,
  selectedConn,
  realtimeByTag,
  realtimeRevisionByTag,
  realtimeLoading,
  pointsLoading,
  actionsDisabled,
  readPlan,
  addressBase,
  readPlanSaving,
  runtimeRunning,
  onReadPlanSave,
  onReadPlanDirtyChange,
  onAdd,
  onEdit,
  onCopy,
  onDelete,
  onDeleteAll,
}) => {
  const [functionFilter, setFunctionFilter] = useState<number>();
  const [dataTypeFilter, setDataTypeFilter] = useState<number>();
  const [tagSearch, setTagSearch] = useState('');
  const [tableView, setTableView] = useState<PointTableView>('config');
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [filterExpanded, setFilterExpanded] = useState(false);
  const savedReadPlan = useMemo<ModbusReadPlan>(
    () => ({
      mode: readPlan?.mode || 1,
      blocks: (readPlan?.blocks ?? []).map((block) => ({ ...block })),
    }),
    [readPlan],
  );
  const savedReadPlanSignature = JSON.stringify(savedReadPlan);
  const draftSourceKey = `${selectedConn ?? ''}|${addressBase}|${savedReadPlanSignature}`;
  const [activeDraftSourceKey, setActiveDraftSourceKey] = useState(draftSourceKey);
  const [draftReadPlanMode, setDraftReadPlanMode] = useState(savedReadPlan.mode || 1);
  const [draftReadPlanBlocks, setDraftReadPlanBlocks] = useState(savedReadPlan.blocks.map((block) => ({ ...block })));
  const [draftReadPlanEditorExpanded, setDraftReadPlanEditorExpanded] = useState(
    savedReadPlan.blocks.length <= READ_PLAN_COLLAPSE_THRESHOLD,
  );
  const draftIsCurrent = activeDraftSourceKey === draftSourceKey;
  // A connection/address-base change is an external boundary. Derive the current view from
  // external state immediately instead of applying an old local draft to the new connection.
  const readPlanMode = draftIsCurrent ? draftReadPlanMode : (savedReadPlan.mode || 1);
  const readPlanBlocks = draftIsCurrent ? draftReadPlanBlocks : savedReadPlan.blocks;
  const readPlanEditorExpanded = draftIsCurrent
    ? draftReadPlanEditorExpanded
    : savedReadPlan.blocks.length <= READ_PLAN_COLLAPSE_THRESHOLD;

  const registerPoints = useMemo(
    () => points.filter((point) => isExplicitReadFunction(point.function)),
    [points],
  );
  const coveredTags = useMemo(
    () => getCoveredReadPlanTags(registerPoints, readPlanBlocks),
    [readPlanBlocks, registerPoints],
  );
  const uncoveredPoints = registerPoints.filter((point) => !coveredTags.includes(point.tag));
  const nonRegisterPointCount = points.length - registerPoints.length;
  const readPlanValidation = useMemo<ReadPlanValidation>(() => {
    const invalidIndexes = new Set<number>();
    const overlapIndexes = new Set<number>();
    const issuesByIndex = new Map<number, string[]>();
    const minAddress = getMinimumAddress(addressBase);

    const addIssue = (index: number, issue: string): void => {
      const issues = issuesByIndex.get(index) ?? [];
      issues.push(issue);
      issuesByIndex.set(index, issues);
    };

    readPlanBlocks.forEach((block, index) => {
      const start = Number(block.start);
      const quantity = Number(block.quantity);
      const end = start + quantity - 1;
      const validRange = Number.isInteger(start)
        && Number.isInteger(quantity)
        && start >= minAddress
        && start <= MODBUS_MAX_ADDRESS
        && quantity >= 1
        && quantity <= MODBUS_MAX_READ_QUANTITY
        && end <= MODBUS_MAX_ADDRESS;

      if (!validRange) {
        invalidIndexes.add(index);
        addIssue(index, `地址范围无效（${start} - ${end}）`);
      }
    });

    for (let leftIndex = 0; leftIndex < readPlanBlocks.length; leftIndex += 1) {
      const left = readPlanBlocks[leftIndex];
      const leftStart = Number(left.start);
      const leftEnd = leftStart + Number(left.quantity) - 1;
      if (invalidIndexes.has(leftIndex)) {
        continue;
      }
      for (let rightIndex = leftIndex + 1; rightIndex < readPlanBlocks.length; rightIndex += 1) {
        const right = readPlanBlocks[rightIndex];
        if (right.function !== left.function || invalidIndexes.has(rightIndex)) {
          continue;
        }
        const rightStart = Number(right.start);
        const rightEnd = rightStart + Number(right.quantity) - 1;
        if (leftStart <= rightEnd && rightStart <= leftEnd) {
          overlapIndexes.add(leftIndex);
          overlapIndexes.add(rightIndex);
          addIssue(leftIndex, `与第 ${rightIndex + 1} 个区间重叠`);
          addIssue(rightIndex, `与第 ${leftIndex + 1} 个区间重叠`);
        }
      }
    }

    return { invalidIndexes, overlapIndexes, issuesByIndex };
  }, [addressBase, readPlanBlocks]);
  const currentReadPlan = useMemo<ModbusReadPlan>(
    () => ({ mode: readPlanMode, blocks: readPlanBlocks }),
    [readPlanBlocks, readPlanMode],
  );
  const readPlanStale = readPlanMode === 2 && uncoveredPoints.length > 0;
  const readPlanInvalid = readPlanMode === 2 && readPlanValidation.invalidIndexes.size > 0;
  const readPlanDirty = JSON.stringify(currentReadPlan) !== savedReadPlanSignature
    || readPlanStale
    || readPlanInvalid;

  useEffect(() => {
    onReadPlanDirtyChange?.(readPlanDirty);
    return () => onReadPlanDirtyChange?.(false);
  }, [onReadPlanDirtyChange, readPlanDirty]);

  const setReadPlanBlocks = (
    next: ModbusReadPlan['blocks'] | ((current: ModbusReadPlan['blocks']) => ModbusReadPlan['blocks']),
  ): void => {
    setActiveDraftSourceKey(draftSourceKey);
    setDraftReadPlanBlocks((current) => {
      const base = activeDraftSourceKey === draftSourceKey ? current : savedReadPlan.blocks;
      return typeof next === 'function' ? next(base) : next;
    });
  };

  const setReadPlanMode = (next: number): void => {
    setActiveDraftSourceKey(draftSourceKey);
    setDraftReadPlanMode(next);
  };

  const updateDraftExpanded = (next: boolean | ((current: boolean) => boolean)): void => {
    setActiveDraftSourceKey(draftSourceKey);
    setDraftReadPlanEditorExpanded((current) => {
      const base = activeDraftSourceKey === draftSourceKey
        ? current
        : savedReadPlan.blocks.length <= READ_PLAN_COLLAPSE_THRESHOLD;
      return typeof next === 'function' ? next(base) : next;
    });
  };

  const persistReadPlan = async (nextReadPlan: ModbusReadPlan) => {
    const saved = await onReadPlanSave(nextReadPlan);
    if (saved) {
      setActiveDraftSourceKey(draftSourceKey);
      setDraftReadPlanMode(nextReadPlan.mode);
      setDraftReadPlanBlocks(nextReadPlan.blocks.map((block) => ({ ...block })));
    }
  };

  const requestReadPlanApply = (nextReadPlan: ModbusReadPlan, title: string) => {
    const apply = () => persistReadPlan(nextReadPlan);
    if (runtimeRunning) {
      Modal.confirm({
        title,
        content: '当前连接正在运行，应用策略会短暂停止并重新启动连接。',
        okText: '应用并重启',
        cancelText: '取消',
        onOk: apply,
      });
      return;
    }
    apply();
  };

  const updateReadPlanBlock = (index: number, patch: Partial<ModbusReadPlan['blocks'][number]>) => {
    setReadPlanBlocks((current) => current.map((block, blockIndex) => (
      blockIndex === index ? { ...block, ...patch } : block
    )));
  };

  const generateReadPlan = () => {
    setReadPlanBlocks(buildReadPlanBlocks(points));
  };

  const openReadPlanPreview = () => {
    setReadPlanBlocks(buildReadPlanBlocks(points));
    setReadPlanMode(2);
    updateDraftExpanded(true);
  };

  const restorePointReadPlan = () => {
    requestReadPlanApply(
      { mode: 1, blocks: [] },
      '恢复逐点读取？',
    );
  };

  const applyReadPlan = () => {
    const apply = () => requestReadPlanApply(
      currentReadPlan,
      readPlanMode === 2 ? '应用区间读取策略？' : '应用逐点读取策略？',
    );

    if (readPlanInvalid) {
      return;
    }

    if (readPlanStale) {
      Modal.confirm({
        title: '仍有寄存器点位未覆盖',
        content: `当前区间未覆盖 ${uncoveredPoints.length} 个寄存器点位，应用后这些点位不会从批量响应中解析。`,
        okText: '仍然应用',
        cancelText: '返回调整',
        onOk: apply,
      });
      return;
    }

    apply();
  };

  const visiblePoints = useMemo(
    () => {
      const normalizedSearch = tagSearch.trim().toLocaleLowerCase();
      return points.filter((point) => (
        (functionFilter === undefined || point.function === functionFilter)
        && (dataTypeFilter === undefined || point.data_type === dataTypeFilter)
        && (
          normalizedSearch.length === 0
          || point.tag.toLocaleLowerCase().includes(normalizedSearch)
          || String(point.address).includes(normalizedSearch)
        )
      ));
    },
    [dataTypeFilter, functionFilter, points, tagSearch],
  );
  const hasFilters = Boolean(tagSearch.trim() || functionFilter !== undefined || dataTypeFilter !== undefined);
  const filterCount = Number(Boolean(tagSearch.trim()))
    + Number(functionFilter !== undefined)
    + Number(dataTypeFilter !== undefined);
  const clearFilters = (): void => {
    setTagSearch('');
    setFunctionFilter(undefined);
    setDataTypeFilter(undefined);
  };

  const functionOptions = Object.entries(FUNCTION_CODE_LABELS).map(([value, label]) => ({
    value: Number(value),
    label,
  }));
  const dataTypeOptions = Object.entries(DATA_TYPE_LABELS).map(([value, label]) => ({
    value: Number(value),
    label,
  }));

  const columns = useMemo<ColumnsType<ModbusPoint>>(() => {
    const tagColumn = {
      title: '标签',
      dataIndex: 'tag',
      key: 'tag',
      width: 140,
      fixed: 'left' as const,
      render: (value: string) => <Text strong>{value}</Text>,
    };
    const functionColumn = {
      title: '功能码',
      dataIndex: 'function',
      key: 'function',
      width: 200,
      render: (value: number) => FUNCTION_CODE_LABELS[value] ?? '未指定',
    };
    const addressColumn = {
      title: '地址',
      dataIndex: 'address',
      key: 'address',
      width: 100,
      sorter: (left: ModbusPoint, right: ModbusPoint) => left.address - right.address,
    };
    const registerCountColumn = { title: '寄存器数', dataIndex: 'reg_count', key: 'reg_count', width: 90 };
    const bitIndexColumn = {
      title: '位索引',
      dataIndex: 'bit_index',
      key: 'bit_index',
      width: 90,
      render: (value: number | null | undefined) => value ?? '-',
    };
    const dataTypeColumn = {
      title: '数据类型',
      dataIndex: 'data_type',
      key: 'data_type',
      width: 120,
      render: (value: number) => DATA_TYPE_LABELS[value] ?? '未指定',
    };
    const realtimeValueColumn = {
      title: '实时值',
      key: 'realtime_value',
      width: 160,
      render: (_value: unknown, record: ModbusPoint) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeValueCell(update, realtimeRevisionByTag[record.tag]?.value);
      },
    };
    const realtimeTimestampColumn = {
      title: '时间',
      key: 'realtime_ts',
      width: 130,
      render: (_value: unknown, record: ModbusPoint) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeTimestampCell(update, realtimeRevisionByTag[record.tag]?.timestamp);
      },
    };
    const realtimeQualityColumn = {
      title: '质量',
      key: 'realtime_quality',
      width: 100,
      render: (_value: unknown, record: ModbusPoint) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeQualityCell(update, realtimeRevisionByTag[record.tag]?.quality);
      },
    };
    const wordOrderColumn = {
      title: '字序',
      dataIndex: 'word_order',
      key: 'word_order',
      width: 80,
      render: (value: number) => WORD_ORDER_LABELS[value] ?? '默认 (HL)',
    };
    const byteOrderColumn = {
      title: '字节序',
      dataIndex: 'byte_order',
      key: 'byte_order',
      width: 80,
      render: (value: number) => BYTE_ORDER_LABELS[value] ?? '默认 (AB)',
    };
    const actionColumn = {
      title: '操作',
      key: 'action',
      width: 112,
      fixed: 'right' as const,
      render: (_value: unknown, record: ModbusPoint) => {
        const originalIndex = points.indexOf(record);
        if (originalIndex < 0) {
          return null;
        }
        return (
          <Space size={4}>
            <Tooltip title="编辑点位">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                aria-label={`编辑点位 ${record.tag}`}
                disabled={actionsDisabled}
                onClick={() => onEdit(originalIndex)}
              />
            </Tooltip>
            <Tooltip title="复制点位并递增地址">
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                aria-label={`复制点位 ${record.tag}`}
                disabled={actionsDisabled}
                onClick={() => onCopy(originalIndex)}
              />
            </Tooltip>
            <Popconfirm title="确认删除该点位？" onConfirm={() => onDelete(originalIndex)}>
              <Tooltip title="删除点位">
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={`删除点位 ${record.tag}`}
                  disabled={actionsDisabled}
                />
              </Tooltip>
            </Popconfirm>
          </Space>
        );
      },
    };

    if (tableView === 'runtime') {
      return [
        tagColumn,
        functionColumn,
        addressColumn,
        dataTypeColumn,
        realtimeValueColumn,
        realtimeTimestampColumn,
        realtimeQualityColumn,
      ];
    }

    return [
      tagColumn,
      functionColumn,
      addressColumn,
      registerCountColumn,
      bitIndexColumn,
      dataTypeColumn,
      ...(showAdvancedConfig ? [wordOrderColumn, byteOrderColumn] : []),
      actionColumn,
    ];
  }, [
    actionsDisabled,
    points,
    realtimeByTag,
    realtimeRevisionByTag,
    showAdvancedConfig,
    tableView,
    onCopy,
    onDelete,
    onEdit,
  ]);

  const tableEmptyText = selectedConn ? (
    points.length > 0 ? (
      <Space direction="vertical" size={4}>
        <Text type="secondary">没有符合当前筛选条件的点位</Text>
        {hasFilters ? (
          <Button type="link" size="small" onClick={clearFilters}>
            清除筛选
          </Button>
        ) : null}
      </Space>
    ) : (
      <Space direction="vertical" size={6}>
        <Text type="secondary">暂无点位</Text>
        <Button type="primary" size="small" icon={<PlusOutlined />} disabled={actionsDisabled} onClick={onAdd}>
          添加第一点位
        </Button>
      </Space>
    )
  ) : (
    <Text type="secondary">请先选择连接</Text>
  );

  const readPlanScrollX = tableView === 'runtime' ? 1080 : (showAdvancedConfig ? 1030 : 870);
  const getReadPlanMaxStart = (quantity: number): number => Math.max(
    getMinimumAddress(addressBase),
    MODBUS_MAX_ADDRESS - Math.max(quantity, 1) + 1,
  );
  const getReadPlanMaxQuantity = (start: number): number => Math.max(
    1,
    Math.min(MODBUS_MAX_READ_QUANTITY, MODBUS_MAX_ADDRESS - Math.max(start, 0) + 1),
  );

  return (
    <Card
      title={(
        <Space size={8} wrap>
          <span>点表配置</span>
          {selectedConn ? <Text type="secondary">{selectedConn} · 显示 {visiblePoints.length}/{points.length} 个点位</Text> : null}
          {realtimeLoading && selectedConn ? <Text type="secondary">实时数据连接中</Text> : null}
        </Space>
      )}
      size="small"
      bordered
      className="protocol-point-card"
      extra={(
        <Space wrap>
          <Segmented<PointTableView>
            size="small"
            value={tableView}
            options={[
              { label: '配置视图', value: 'config' },
              { label: '运行视图', value: 'runtime' },
            ]}
            onChange={setTableView}
          />
          <span
            className={`modbus-point-advanced-toggle-slot${tableView === 'config' ? '' : ' is-hidden'}`}
            aria-hidden={tableView !== 'config'}
          >
            <Button
              type="text"
              size="small"
              tabIndex={tableView === 'config' ? undefined : -1}
              disabled={tableView !== 'config'}
              icon={showAdvancedConfig ? <EyeInvisibleOutlined /> : <EyeOutlined />}
              onClick={() => setShowAdvancedConfig((visible) => !visible)}
            >
              {showAdvancedConfig ? '隐藏字序/字节序' : '显示字序/字节序'}
            </Button>
          </span>
          <Button
            size="small"
            icon={<FilterOutlined />}
            aria-expanded={filterExpanded}
            aria-controls="modbus-point-filters"
            type={filterExpanded || hasFilters ? 'default' : 'text'}
            onClick={() => setFilterExpanded((expanded) => !expanded)}
          >
            筛选{filterCount > 0 ? ` (${filterCount})` : ''}
          </Button>
          <Popconfirm
            title="确认删除全部点位？"
            description={`当前连接的 ${points.length} 个点位将被清空。运行中的连接会先停止，清空后不会自动恢复；如需继续采集，请重新配置点位后手动启动。`}
            onConfirm={onDeleteAll}
            disabled={!selectedConn || points.length === 0}
          >
            <Button
              danger
              size="small"
              icon={<DeleteOutlined />}
              disabled={!selectedConn || points.length === 0 || actionsDisabled}
            >
              删除全部点位
            </Button>
          </Popconfirm>
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={onAdd}
            disabled={!selectedConn || actionsDisabled}
          >
            添加点位
          </Button>
        </Space>
      )}
    >
      {filterExpanded ? (
        <div className="protocol-point-filter-panel" id="modbus-point-filters">
          <Input
            allowClear
            size="small"
            prefix={<SearchOutlined />}
            placeholder="搜索 Tag 或地址"
            value={tagSearch}
            disabled={!selectedConn || points.length === 0}
            onChange={(event) => setTagSearch(event.target.value)}
            style={{ width: 180 }}
          />
          <Select<number>
            allowClear
            size="small"
            placeholder="全部功能码"
            value={functionFilter}
            options={functionOptions}
            onChange={setFunctionFilter}
            disabled={!selectedConn || points.length === 0 || actionsDisabled}
            style={{ width: 170 }}
          />
          <Select<number>
            allowClear
            size="small"
            placeholder="全部数据类型"
            value={dataTypeFilter}
            options={dataTypeOptions}
            onChange={setDataTypeFilter}
            disabled={!selectedConn || points.length === 0}
            style={{ width: 130 }}
          />
          <Button
            type="text"
            size="small"
            icon={<ClearOutlined />}
            disabled={!hasFilters}
            onClick={clearFilters}
          >
            清除筛选
          </Button>
        </div>
      ) : null}
      <div className="protocol-read-plan-toolbar">
        <div className="protocol-read-plan-heading">
          <Text strong>读取策略</Text>
          {readPlanMode === 1 ? (
            <>
              <Text type="secondary">逐点读取</Text>
              <Text type="secondary">按点位逐条读取，适合地址分散的设备。</Text>
              <Button
                size="small"
                disabled={actionsDisabled || points.length === 0}
                onClick={openReadPlanPreview}
              >
                生成批量方案
              </Button>
            </>
          ) : (
            <>
              <Text type={readPlanDirty ? 'warning' : 'success'}>
                {readPlanDirty ? '批量读取预览' : '批量读取已启用'}
              </Text>
              <Text type="secondary">按寄存器区间批量读取，适合地址连续的设备。</Text>
              <Button
                size="small"
                disabled={actionsDisabled}
                onClick={restorePointReadPlan}
              >
                恢复逐点读取
              </Button>
              {readPlanDirty ? (
                <Button
                  type="primary"
                  size="small"
                  disabled={actionsDisabled || readPlanBlocks.length === 0}
                  loading={readPlanSaving}
                  onClick={applyReadPlan}
                >
                  {savedReadPlan.mode === 2 ? '应用批量方案' : '启用批量读取'}
                </Button>
              ) : null}
            </>
          )}
        </div>

        {readPlanMode === 2 ? (
          <div className="protocol-read-plan-editor">
            <div className="protocol-read-plan-summary">
              <Space size={10} wrap>
                <Text strong>批量读取区间</Text>
                <Text type="secondary">共 {readPlanBlocks.length} 个</Text>
                <Text type={uncoveredPoints.length > 0 ? 'warning' : 'secondary'}>
                  已覆盖 {coveredTags.length}/{registerPoints.length} 个寄存器点位
                  {uncoveredPoints.length > 0 ? `，未覆盖 ${uncoveredPoints.length} 个` : ''}
                </Text>
                {nonRegisterPointCount > 0 ? (
                  <Text type="secondary">另有 {nonRegisterPointCount} 个线圈/写点不参与区间读取</Text>
                ) : null}
              </Space>
              <Button
                type="text"
                size="small"
                icon={<DownOutlined rotate={readPlanEditorExpanded ? 180 : 0} />}
                aria-expanded={readPlanEditorExpanded}
                aria-controls="modbus-read-plan-blocks"
                onClick={() => updateDraftExpanded((expanded) => !expanded)}
              >
                {readPlanEditorExpanded ? '收起区间编辑' : '展开区间编辑'}
              </Button>
            </div>
            {readPlanStale ? (
              <Alert
                type="warning"
                showIcon
                message="读取区间已过期"
                description="建议重新生成区间，或手工补齐后再应用。"
                className="protocol-read-plan-alert"
              />
            ) : null}
            {readPlanInvalid ? (
              <Alert
                type="error"
                showIcon
                message="读取区间超出地址范围"
                description="请调整起始地址、数量或地址基准，确保每个区间的结束地址不超过 65535。"
                className="protocol-read-plan-alert"
              />
            ) : null}
            {readPlanValidation.overlapIndexes.size > 0 ? (
              <Alert
                type="warning"
                showIcon
                message="读取区间存在重叠"
                description="相同功能码的重叠区间会重复读取，建议合并或调整区间。"
                className="protocol-read-plan-alert"
              />
            ) : null}
            <div
              className="protocol-read-plan-block-list"
              id="modbus-read-plan-blocks"
              hidden={!readPlanEditorExpanded}
            >
              {readPlanBlocks.map((block, index) => (
                <div
                  className="protocol-read-plan-block"
                  key={`read-plan-block-${index}`}
                  style={{
                    borderColor: readPlanValidation.invalidIndexes.has(index)
                      ? '#ff4d4f'
                      : readPlanValidation.overlapIndexes.has(index)
                        ? '#faad14'
                        : undefined,
                  }}
                >
                  <Select<number>
                    size="small"
                    value={block.function}
                    options={[
                      { value: MODBUS_FUNCTION.READ_HOLDING_REGISTERS, label: '0x03 保持寄存器' },
                      { value: MODBUS_FUNCTION.READ_INPUT_REGISTERS, label: '0x04 输入寄存器' },
                    ]}
                    status={readPlanValidation.overlapIndexes.has(index) ? 'warning' : undefined}
                    disabled={actionsDisabled}
                    onChange={(value) => updateReadPlanBlock(index, { function: value })}
                    style={{ width: 190 }}
                  />
                  <InputNumber
                    size="small"
                    min={getMinimumAddress(addressBase)}
                    max={getReadPlanMaxStart(block.quantity)}
                    precision={0}
                    value={block.start}
                    status={readPlanValidation.invalidIndexes.has(index) ? 'error' : undefined}
                    disabled={actionsDisabled}
                    onChange={(value) => updateReadPlanBlock(index, { start: value ?? getMinimumAddress(addressBase) })}
                    addonBefore="起始"
                  />
                  <InputNumber
                    size="small"
                    min={1}
                    max={getReadPlanMaxQuantity(block.start)}
                    precision={0}
                    value={block.quantity}
                    status={readPlanValidation.invalidIndexes.has(index) ? 'error' : undefined}
                    disabled={actionsDisabled}
                    onChange={(value) => updateReadPlanBlock(index, { quantity: value ?? 1 })}
                    addonBefore="数量"
                  />
                  <Text
                    type={readPlanValidation.invalidIndexes.has(index) ? 'danger' : 'secondary'}
                    style={{ fontSize: 12 }}
                  >
                    结束地址 {Number(block.start) + Number(block.quantity) - 1}
                    {readPlanValidation.issuesByIndex.get(index)?.length
                      ? ` · ${readPlanValidation.issuesByIndex.get(index)?.join('；')}`
                      : ''}
                  </Text>
                  <Tooltip title="删除读取区间">
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      aria-label={`删除第 ${index + 1} 个读取区间`}
                      disabled={actionsDisabled}
                      onClick={() => setReadPlanBlocks((current) => current.filter((_item, itemIndex) => itemIndex !== index))}
                    />
                  </Tooltip>
                </div>
              ))}
            </div>
            <div className="protocol-read-plan-actions" hidden={!readPlanEditorExpanded}>
              <Space wrap>
                <Button
                  type="dashed"
                  size="small"
                  icon={<PlusOutlined />}
                  disabled={actionsDisabled}
                  onClick={() => setReadPlanBlocks((current) => ([
                    ...current,
                    {
                      function: MODBUS_FUNCTION.READ_HOLDING_REGISTERS,
                      start: getMinimumAddress(addressBase),
                      quantity: 1,
                    },
                  ]))}
                >
                  添加读取区间
                </Button>
                <Popconfirm
                  title="重新生成区间？"
                  description="这会替换当前手工编辑的区间。"
                  okText="重新生成"
                  cancelText="取消"
                  onConfirm={generateReadPlan}
                  disabled={actionsDisabled || points.length === 0}
                >
                  <Button size="small" disabled={actionsDisabled || points.length === 0}>
                    重新生成区间
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          </div>
        ) : null}
      </div>
      <div className="protocol-table-scroll">
        <Table<ModbusPoint>
          columns={columns}
          dataSource={visiblePoints}
          loading={pointsLoading}
          pagination={false}
          size="small"
          rowKey={(record) => record.tag}
          scroll={{ x: readPlanScrollX }}
          locale={{
            emptyText: tableEmptyText,
          }}
        />
      </div>
    </Card>
  );
};

export default PointTable;
