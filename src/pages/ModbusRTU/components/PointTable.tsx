import React, { useMemo, useState } from 'react';
import { Alert, Button, Card, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tooltip, Typography } from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { DcPointUpdate, ModbusPoint, ModbusReadPlan } from '../../../adapters';
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

interface Props {
  points: ModbusPoint[];
  selectedConn: string | null;
  realtimeByTag: Record<string, DcPointUpdate>;
  realtimeRevisionByTag: Record<string, ProtocolRealtimeCellRevision>;
  realtimeLoading: boolean;
  pointsLoading: boolean;
  actionsDisabled: boolean;
  readPlan: ModbusReadPlan | null;
  addressBase: number;
  readPlanSaving: boolean;
  runtimeRunning: boolean;
  onReadPlanSave: (readPlan: ModbusReadPlan) => Promise<boolean>;
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
  onAdd,
  onEdit,
  onCopy,
  onDelete,
  onDeleteAll,
}) => {
  const [functionFilter, setFunctionFilter] = useState<number>();
  const [dataTypeFilter, setDataTypeFilter] = useState<number>();
  const [tagSearch, setTagSearch] = useState('');
  const savedReadPlan = readPlan ?? { mode: 1, blocks: [] };
  const [readPlanMode, setReadPlanMode] = useState(savedReadPlan.mode || 1);
  const [readPlanBlocks, setReadPlanBlocks] = useState(savedReadPlan.blocks.map((block) => ({ ...block })));
  const [readPlanEditorExpanded, setReadPlanEditorExpanded] = useState(
    savedReadPlan.blocks.length <= READ_PLAN_COLLAPSE_THRESHOLD,
  );

  const registerPoints = useMemo(
    () => points.filter((point) => isExplicitReadFunction(point.function)),
    [points],
  );
  const coveredTags = useMemo(
    () => getCoveredReadPlanTags(registerPoints, readPlanBlocks),
    [readPlanBlocks, registerPoints],
  );
  const uncoveredPoints = registerPoints.filter((point) => !coveredTags.includes(point.tag));
  const currentReadPlan = useMemo<ModbusReadPlan>(
    () => ({ mode: readPlanMode, blocks: readPlanBlocks }),
    [readPlanBlocks, readPlanMode],
  );
  const readPlanStale = readPlanMode === 2 && uncoveredPoints.length > 0;
  const readPlanDirty = JSON.stringify(currentReadPlan) !== JSON.stringify(savedReadPlan) || readPlanStale;

  const persistReadPlan = async (nextReadPlan: ModbusReadPlan) => {
    const saved = await onReadPlanSave(nextReadPlan);
    if (saved) {
      setReadPlanMode(nextReadPlan.mode);
      setReadPlanBlocks(nextReadPlan.blocks.map((block) => ({ ...block })));
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
    setReadPlanEditorExpanded(true);
  };

  const restorePointReadPlan = () => {
    requestReadPlanApply(
      { mode: 1, blocks: readPlanBlocks.map((block) => ({ ...block })) },
      '恢复逐点读取？',
    );
  };

  const applyReadPlan = () => {
    const apply = () => requestReadPlanApply(
      currentReadPlan,
      readPlanMode === 2 ? '应用区间读取策略？' : '应用逐点读取策略？',
    );

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

  const functionOptions = Object.entries(FUNCTION_CODE_LABELS).map(([value, label]) => ({
    value: Number(value),
    label,
  }));
  const dataTypeOptions = Object.entries(DATA_TYPE_LABELS).map(([value, label]) => ({
    value: Number(value),
    label,
  }));

  const columns: ColumnsType<ModbusPoint> = [
    {
      title: '标签',
      dataIndex: 'tag',
      key: 'tag',
      width: 140,
      fixed: 'left',
      render: (value: string) => <Text strong>{value}</Text>,
    },
    {
      title: '功能码',
      dataIndex: 'function',
      key: 'function',
      width: 200,
      render: (value: number) => FUNCTION_CODE_LABELS[value] ?? '未指定',
    },
    {
      title: '地址',
      dataIndex: 'address',
      key: 'address',
      width: 100,
      sorter: (left, right) => left.address - right.address,
    },
    { title: '寄存器数', dataIndex: 'reg_count', key: 'reg_count', width: 90 },
    {
      title: '位索引',
      dataIndex: 'bit_index',
      key: 'bit_index',
      width: 90,
      render: (value: number | null | undefined) => value ?? '-',
    },
    {
      title: '数据类型',
      dataIndex: 'data_type',
      key: 'data_type',
      width: 120,
      render: (value: number) => DATA_TYPE_LABELS[value] ?? '未指定',
    },
    {
      title: '实时值',
      key: 'realtime_value',
      width: 160,
      render: (_value: unknown, record: ModbusPoint) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeValueCell(update, realtimeRevisionByTag[record.tag]?.value);
      },
    },
    {
      title: '时间',
      key: 'realtime_ts',
      width: 130,
      render: (_value: unknown, record: ModbusPoint) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeTimestampCell(update, realtimeRevisionByTag[record.tag]?.timestamp);
      },
    },
    {
      title: '质量',
      key: 'realtime_quality',
      width: 100,
      render: (_value: unknown, record: ModbusPoint) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeQualityCell(update, realtimeRevisionByTag[record.tag]?.quality);
      },
    },
    {
      title: '字序',
      dataIndex: 'word_order',
      key: 'word_order',
      width: 80,
      render: (value: number) => WORD_ORDER_LABELS[value] ?? '默认 (HL)',
    },
    {
      title: '字节序',
      dataIndex: 'byte_order',
      key: 'byte_order',
      width: 80,
      render: (value: number) => BYTE_ORDER_LABELS[value] ?? '默认 (AB)',
    },
    {
      title: '操作',
      key: 'action',
      width: 112,
      fixed: 'right',
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
    },
  ];

  return (
    <Card
      title={(
        <Space size={8} wrap>
          <span>点表配置</span>
          {selectedConn ? <Text type="secondary">{selectedConn} · {points.length} 个点位</Text> : null}
          {realtimeLoading && selectedConn ? <Text type="secondary">实时数据连接中</Text> : null}
        </Space>
      )}
      size="small"
      bordered
      className="protocol-point-card"
      extra={(
        <Space wrap>
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
          <Popconfirm
            title="确认删除全部点位？"
            description={`当前连接的 ${points.length} 个点位将被清空`}
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
              </Space>
              <Button
                type="text"
                size="small"
                icon={<DownOutlined rotate={readPlanEditorExpanded ? 180 : 0} />}
                aria-expanded={readPlanEditorExpanded}
                aria-controls="modbus-read-plan-blocks"
                onClick={() => setReadPlanEditorExpanded((expanded) => !expanded)}
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
            <div
              className="protocol-read-plan-block-list"
              id="modbus-read-plan-blocks"
              hidden={!readPlanEditorExpanded}
            >
              {readPlanBlocks.map((block, index) => (
                <div className="protocol-read-plan-block" key={`read-plan-block-${index}`}>
                  <Select<number>
                    size="small"
                    value={block.function}
                    options={[
                      { value: MODBUS_FUNCTION.READ_HOLDING_REGISTERS, label: '0x03 保持寄存器' },
                      { value: MODBUS_FUNCTION.READ_INPUT_REGISTERS, label: '0x04 输入寄存器' },
                    ]}
                    disabled={actionsDisabled}
                    onChange={(value) => updateReadPlanBlock(index, { function: value })}
                    style={{ width: 190 }}
                  />
                  <InputNumber
                    size="small"
                    min={getMinimumAddress(addressBase)}
                    max={65535}
                    precision={0}
                    value={block.start}
                    disabled={actionsDisabled}
                    onChange={(value) => updateReadPlanBlock(index, { start: value ?? getMinimumAddress(addressBase) })}
                    addonBefore="起始"
                  />
                  <InputNumber
                    size="small"
                    min={1}
                    max={125}
                    precision={0}
                    value={block.quantity}
                    disabled={actionsDisabled}
                    onChange={(value) => updateReadPlanBlock(index, { quantity: value ?? 1 })}
                    addonBefore="数量"
                  />
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
          rowKey={(record) => `${record.tag}-${record.address}-${points.indexOf(record)}`}
          columns={columns}
          dataSource={visiblePoints}
          loading={pointsLoading}
          pagination={false}
          size="small"
          scroll={{ x: 1360 }}
          locale={{
            emptyText: selectedConn
              ? (points.length > 0 ? '没有符合当前筛选条件的点位' : '暂无点位')
              : '请先选择连接',
          }}
        />
      </div>
    </Card>
  );
};

export default PointTable;
