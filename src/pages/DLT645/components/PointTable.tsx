import React, { useMemo, useState } from 'react';
import {
  Button,
  Card,
  Input,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Table,
  Tabs,
  Tooltip,
  Typography,
} from 'antd';
import {
  ClearOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FilterOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { DcSourcePointUpdate, Dlt645Point, Dlt645Block, Dlt645BlockItem } from '../../../adapters';
import {
  type ProtocolRealtimeCellRevision,
  renderProtocolRealtimeQualityCell,
  renderProtocolRealtimeTimestampCell,
  renderProtocolRealtimeValueCell,
} from '../../../components/protocol/protocol-realtime';

const { Text } = Typography;

const DATA_TYPE_LABELS: Record<number, string> = {
  0: '未指定',
  1: 'BOOL',
  2: 'UINT16',
  3: 'UINT32',
  4: 'FLOAT',
  5: 'STRING',
  6: 'BCD',
};

const ACCESS_MODE_LABELS: Record<number, string> = {
  0: '未指定',
  1: '只读',
  2: '只写',
  3: '读写',
};

type PointTableView = 'config' | 'runtime';

function renderBitPosition(record: { byte_index?: number | null; bit_index?: number | null }): React.ReactNode {
  if (record.bit_index == null) {
    return '-';
  }
  return `B${record.byte_index ?? 0}.b${record.bit_index}`;
}

interface Props {
  points: Dlt645Point[];
  blocks: Dlt645Block[];
  selectedConn: string | null;
  realtimeByTag: Record<string, DcSourcePointUpdate>;
  realtimeRevisionByTag: Record<string, ProtocolRealtimeCellRevision>;
  realtimeLoading: boolean;
  pointsLoading?: boolean;
  actionsDisabled?: boolean;
  onAddPoint: () => void;
  onEditPoint: (index: number) => void;
  onCopyPoint: (index: number) => void;
  onDeletePoint: (index: number) => void;
  onDeleteAllPoints: () => void;
  onAddBlock: () => void;
  onEditBlock: (index: number) => void;
  onDeleteBlock: (index: number) => void;
}

const PointTable: React.FC<Props> = ({
  points,
  blocks,
  selectedConn,
  realtimeByTag,
  realtimeRevisionByTag,
  realtimeLoading,
  pointsLoading = false,
  actionsDisabled = false,
  onAddPoint,
  onEditPoint,
  onCopyPoint,
  onDeletePoint,
  onDeleteAllPoints,
  onAddBlock,
  onEditBlock,
  onDeleteBlock,
}) => {
  const [tableView, setTableView] = useState<PointTableView>('config');
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [diSearch, setDiSearch] = useState('');
  const [dataTypeFilter, setDataTypeFilter] = useState<number>();
  const [accessFilter, setAccessFilter] = useState<number>();

  const normalizedTagSearch = tagSearch.trim().toLocaleLowerCase();
  const normalizedDiSearch = diSearch.trim().toLocaleLowerCase();
  const hasFilters = Boolean(
    normalizedTagSearch || normalizedDiSearch || dataTypeFilter !== undefined || accessFilter !== undefined,
  );
  const filterCount = Number(Boolean(normalizedTagSearch))
    + Number(Boolean(normalizedDiSearch))
    + Number(dataTypeFilter !== undefined)
    + Number(accessFilter !== undefined);

  const visiblePoints = useMemo(
    () => points.filter((point) => (
      (!normalizedTagSearch || point.tag.toLocaleLowerCase().includes(normalizedTagSearch))
      && (!normalizedDiSearch || point.di.toLocaleLowerCase().includes(normalizedDiSearch))
      && (dataTypeFilter === undefined || point.data_type === dataTypeFilter)
      && (accessFilter === undefined || point.access === accessFilter)
    )),
    [accessFilter, dataTypeFilter, normalizedDiSearch, normalizedTagSearch, points],
  );

  const visibleBlockItems = (block: Dlt645Block): Dlt645BlockItem[] => block.items.filter((item) => (
    (!normalizedTagSearch || item.tag.toLocaleLowerCase().includes(normalizedTagSearch))
    && (dataTypeFilter === undefined || item.data_type === dataTypeFilter)
    && (accessFilter === undefined || item.access === accessFilter)
  ));

  const visibleBlocks = blocks.filter((block) => {
    const diMatches = !normalizedDiSearch || block.block_di.toLocaleLowerCase().includes(normalizedDiSearch);
    if (!diMatches) {
      return false;
    }
    if (!normalizedTagSearch && dataTypeFilter === undefined && accessFilter === undefined) {
      return true;
    }
    return visibleBlockItems(block).length > 0;
  });

  const clearFilters = (): void => {
    setTagSearch('');
    setDiSearch('');
    setDataTypeFilter(undefined);
    setAccessFilter(undefined);
  };

  const renderRealtimeValue = (tag: string): React.ReactNode => {
    const update = realtimeByTag[tag];
    return renderProtocolRealtimeValueCell(update, realtimeRevisionByTag[tag]?.value);
  };
  const renderRealtimeTimestamp = (tag: string): React.ReactNode => {
    const update = realtimeByTag[tag];
    return renderProtocolRealtimeTimestampCell(update, realtimeRevisionByTag[tag]?.timestamp);
  };
  const renderRealtimeQuality = (tag: string): React.ReactNode => {
    const update = realtimeByTag[tag];
    return renderProtocolRealtimeQualityCell(update, realtimeRevisionByTag[tag]?.quality);
  };

  const pointColumns: ColumnsType<Dlt645Point> = (() => {
    const tagColumn = {
      title: '标签',
      dataIndex: 'tag',
      key: 'tag',
      width: 140,
      fixed: 'left' as const,
      render: (value: string) => <Text strong>{value}</Text>,
    };
    const diColumn = { title: 'DI', dataIndex: 'di', key: 'di', width: 120, fixed: 'left' as const };
    const dataLengthColumn = { title: '数据长度', dataIndex: 'data_len', key: 'data_len', width: 80 };
    const bitPositionColumn = {
      title: '位解析',
      key: 'bit_position',
      width: 90,
      render: (_value: unknown, record: Dlt645Point) => renderBitPosition(record),
    };
    const dataTypeColumn = {
      title: '数据类型',
      dataIndex: 'data_type',
      key: 'data_type',
      width: 100,
      render: (value: number) => DATA_TYPE_LABELS[value] ?? '未指定',
    };
    const accessColumn = {
      title: '读写属性',
      dataIndex: 'access',
      key: 'access',
      width: 80,
      render: (value: number) => ACCESS_MODE_LABELS[value] ?? '未指定',
    };
    const realtimeValueColumn = {
      title: '实时值',
      key: 'realtime_value',
      width: 160,
      render: (_value: unknown, record: Dlt645Point) => renderRealtimeValue(record.tag),
    };
    const realtimeTimestampColumn = {
      title: '时间',
      key: 'realtime_ts',
      width: 130,
      render: (_value: unknown, record: Dlt645Point) => renderRealtimeTimestamp(record.tag),
    };
    const realtimeQualityColumn = {
      title: '质量',
      key: 'realtime_quality',
      width: 100,
      render: (_value: unknown, record: Dlt645Point) => renderRealtimeQuality(record.tag),
    };
    const actionColumn = {
      title: '操作',
      key: 'action',
      width: 112,
      fixed: 'right' as const,
      render: (_value: unknown, record: Dlt645Point) => {
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
                onClick={() => onEditPoint(originalIndex)}
              />
            </Tooltip>
            <Tooltip title="复制点位">
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                aria-label={`复制点位 ${record.tag}`}
                disabled={actionsDisabled}
                onClick={() => onCopyPoint(originalIndex)}
              />
            </Tooltip>
            <Popconfirm
              title="确认删除该点位？"
              onConfirm={() => onDeletePoint(originalIndex)}
              disabled={actionsDisabled}
            >
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
      return [tagColumn, diColumn, dataTypeColumn, realtimeValueColumn, realtimeTimestampColumn, realtimeQualityColumn];
    }
    return [tagColumn, diColumn, dataLengthColumn, bitPositionColumn, dataTypeColumn, accessColumn, actionColumn];
  })();

  const blockItemColumns: ColumnsType<Dlt645BlockItem> = (() => {
    const tagColumn = {
      title: '标签',
      dataIndex: 'tag',
      key: 'tag',
      width: 140,
      fixed: 'left' as const,
      render: (value: string) => <Text strong>{value}</Text>,
    };
    const dataLengthColumn = { title: '数据长度', dataIndex: 'data_len', key: 'data_len', width: 80 };
    const bitPositionColumn = {
      title: '位解析',
      key: 'bit_position',
      width: 90,
      render: (_value: unknown, record: Dlt645BlockItem) => renderBitPosition(record),
    };
    const dataTypeColumn = {
      title: '数据类型',
      dataIndex: 'data_type',
      key: 'data_type',
      width: 100,
      render: (value: number) => DATA_TYPE_LABELS[value] ?? '未指定',
    };
    const accessColumn = {
      title: '读写属性',
      dataIndex: 'access',
      key: 'access',
      width: 80,
      render: (value: number) => ACCESS_MODE_LABELS[value] ?? '未指定',
    };
    const realtimeValueColumn = {
      title: '实时值',
      key: 'realtime_value',
      width: 160,
      render: (_value: unknown, record: Dlt645BlockItem) => renderRealtimeValue(record.tag),
    };
    const realtimeTimestampColumn = {
      title: '时间',
      key: 'realtime_ts',
      width: 130,
      render: (_value: unknown, record: Dlt645BlockItem) => renderRealtimeTimestamp(record.tag),
    };
    const realtimeQualityColumn = {
      title: '质量',
      key: 'realtime_quality',
      width: 100,
      render: (_value: unknown, record: Dlt645BlockItem) => renderRealtimeQuality(record.tag),
    };
    if (tableView === 'runtime') {
      return [tagColumn, dataTypeColumn, realtimeValueColumn, realtimeTimestampColumn, realtimeQualityColumn];
    }
    return [tagColumn, dataLengthColumn, bitPositionColumn, dataTypeColumn, accessColumn];
  })();

  const blockColumns: ColumnsType<Dlt645Block> = (() => {
    const blockDiColumn = {
      title: '块 DI',
      dataIndex: 'block_di',
      key: 'block_di',
      width: 120,
      fixed: 'left' as const,
      render: (value: string) => <Text strong>{value}</Text>,
    };
    const dataLengthColumn = { title: '块数据长度', dataIndex: 'block_data_len', key: 'block_data_len', width: 100 };
    const itemsCountColumn = {
      title: '子项数量',
      key: 'items_count',
      width: 80,
      render: (_value: unknown, record: Dlt645Block) => record.items.length,
    };
    const actionColumn = {
      title: '操作',
      key: 'action',
      width: 80,
      fixed: 'right' as const,
      render: (_value: unknown, record: Dlt645Block) => {
        const originalIndex = blocks.indexOf(record);
        if (originalIndex < 0) {
          return null;
        }
        return (
          <Space size={4}>
            <Tooltip title="编辑数据块">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                aria-label={`编辑数据块 ${record.block_di}`}
                disabled={actionsDisabled}
                onClick={() => onEditBlock(originalIndex)}
              />
            </Tooltip>
            <Popconfirm
              title="确认删除该数据块？"
              onConfirm={() => onDeleteBlock(originalIndex)}
              disabled={actionsDisabled}
            >
              <Tooltip title="删除数据块">
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={`删除数据块 ${record.block_di}`}
                  disabled={actionsDisabled}
                />
              </Tooltip>
            </Popconfirm>
          </Space>
        );
      },
    };
    return tableView === 'runtime'
      ? [blockDiColumn, dataLengthColumn, itemsCountColumn]
      : [blockDiColumn, dataLengthColumn, itemsCountColumn, actionColumn];
  })();

  const expandedBlockRow = (record: Dlt645Block): React.ReactNode => (
    <Table<Dlt645BlockItem>
      rowKey={(item, index) => `${item.tag}-${index ?? 0}`}
      columns={blockItemColumns}
      dataSource={visibleBlockItems(record)}
      pagination={false}
      size="small"
      scroll={{ x: tableView === 'runtime' ? 650 : 490 }}
      locale={{ emptyText: hasFilters ? '没有符合当前筛选条件的子项' : '暂无子项' }}
    />
  );

  const pointEmptyText = selectedConn ? (
    points.length > 0 ? (
      <Space direction="vertical" size={4}>
        <Text type="secondary">没有符合当前筛选条件的点位</Text>
        {hasFilters ? <Button type="link" size="small" onClick={clearFilters}>清除筛选</Button> : null}
      </Space>
    ) : (
      <Space direction="vertical" size={6}>
        <Text type="secondary">暂无点位</Text>
        <Button type="primary" size="small" icon={<PlusOutlined />} disabled={actionsDisabled} onClick={onAddPoint}>
          添加第一个点位
        </Button>
      </Space>
    )
  ) : <Text type="secondary">请先选择连接</Text>;

  const blockEmptyText = selectedConn ? (
    blocks.length > 0 ? (
      <Space direction="vertical" size={4}>
        <Text type="secondary">没有符合当前筛选条件的数据块</Text>
        {hasFilters ? <Button type="link" size="small" onClick={clearFilters}>清除筛选</Button> : null}
      </Space>
    ) : (
      <Space direction="vertical" size={6}>
        <Text type="secondary">暂无数据块</Text>
        <Button type="primary" size="small" icon={<PlusOutlined />} disabled={actionsDisabled} onClick={onAddBlock}>
          添加第一个数据块
        </Button>
      </Space>
    )
  ) : <Text type="secondary">请先选择连接</Text>;

  const loading = pointsLoading || (tableView === 'runtime' && realtimeLoading);
  const pointScrollX = tableView === 'runtime' ? 820 : 850;
  const blockScrollX = tableView === 'runtime' ? 440 : 500;
  const dataTypeOptions = Object.entries(DATA_TYPE_LABELS).map(([value, label]) => ({ value: Number(value), label }));
  const accessOptions = Object.entries(ACCESS_MODE_LABELS).map(([value, label]) => ({ value: Number(value), label }));
  const tabItems = [
    {
      key: 'points',
      label: `单点配置 (${points.length})`,
      children: (
        <div className="protocol-tabs-pane">
          <div className="protocol-table-scroll">
            <Table<Dlt645Point>
              rowKey={(record, index) => `${record.tag}-${record.di}-${index ?? 0}`}
              columns={pointColumns}
              dataSource={visiblePoints}
              loading={loading}
              pagination={false}
              size="small"
              scroll={{ x: pointScrollX }}
              locale={{ emptyText: pointEmptyText }}
            />
          </div>
        </div>
      ),
    },
    {
      key: 'blocks',
      label: `数据块配置 (${blocks.length})`,
      children: (
        <div className="protocol-tabs-pane">
          <div className="protocol-table-scroll">
            <Table<Dlt645Block>
              rowKey={(record, index) => `${record.block_di}-${index ?? 0}`}
              columns={blockColumns}
              dataSource={visibleBlocks}
              loading={loading}
              pagination={false}
              size="small"
              scroll={{ x: blockScrollX }}
              expandable={{ expandedRowRender: expandedBlockRow }}
              locale={{ emptyText: blockEmptyText }}
            />
          </div>
        </div>
      ),
    },
  ];

  return (
    <Card
      title={(
        <Space size={8} wrap>
          <span>点表配置 (Tag -&gt; DI)</span>
          {selectedConn ? (
            <Text type="secondary">
              显示 {visiblePoints.length}/{points.length} 个点位 · {visibleBlocks.length}/{blocks.length} 个数据块
            </Text>
          ) : null}
        </Space>
      )}
      size="small"
      bordered
      className="protocol-point-card"
      extra={(
        <div className="dlt645-point-toolbar" role="toolbar" aria-label="点表工具栏">
          <div className="dlt645-point-toolbar-main">
            <Space className="dlt645-point-toolbar__group dlt645-point-toolbar__view" size={8} wrap>
              <Segmented<PointTableView>
                size="small"
                value={tableView}
                options={[{ label: '配置视图', value: 'config' }, { label: '运行视图', value: 'runtime' }]}
                onChange={setTableView}
              />
            </Space>
            <Space className="dlt645-point-toolbar__group dlt645-point-toolbar__filter" size={8} wrap>
              <Button
                type={filterExpanded || hasFilters ? 'default' : 'text'}
                size="small"
                icon={<FilterOutlined />}
                aria-expanded={filterExpanded}
                aria-controls="dlt645-point-filters"
                onClick={() => setFilterExpanded((expanded) => !expanded)}
              >
                筛选{filterCount > 0 ? ` (${filterCount})` : ''}
              </Button>
            </Space>
          </div>
          <Space
            className="dlt645-point-secondary-actions dlt645-point-toolbar__group dlt645-point-toolbar__bulk-actions"
            size={8}
            wrap
          >
            <Popconfirm
              title="确认删除全部点位？"
              description={`当前连接的 ${points.length} 个点位将被清空，数据块配置会保留`}
              onConfirm={onDeleteAllPoints}
              disabled={!selectedConn || points.length === 0 || actionsDisabled}
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
            <Button size="small" icon={<PlusOutlined />} onClick={onAddBlock} disabled={!selectedConn || actionsDisabled}>
              添加数据块
            </Button>
          </Space>
          <Space className="dlt645-point-primary-actions dlt645-point-toolbar__group" size={8} wrap>
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={onAddPoint}
              disabled={!selectedConn || actionsDisabled}
            >
              添加点位
            </Button>
          </Space>
        </div>
      )}
    >
      {filterExpanded ? (
        <div
          className="protocol-point-filter-panel dlt645-point-filter-panel"
          id="dlt645-point-filters"
        >
          <Input
            allowClear
            size="small"
            prefix={<SearchOutlined />}
            placeholder="搜索 Tag"
            value={tagSearch}
            disabled={!selectedConn || (points.length === 0 && blocks.length === 0)}
            onChange={(event) => setTagSearch(event.target.value)}
            style={{ width: 150 }}
          />
          <Input
            allowClear
            size="small"
            prefix={<SearchOutlined />}
            placeholder="搜索 DI"
            value={diSearch}
            disabled={!selectedConn || (points.length === 0 && blocks.length === 0)}
            onChange={(event) => setDiSearch(event.target.value)}
            style={{ width: 150 }}
          />
          <Select<number>
            allowClear
            size="small"
            placeholder="全部数据类型"
            value={dataTypeFilter}
            options={dataTypeOptions}
            onChange={setDataTypeFilter}
            disabled={!selectedConn || (points.length === 0 && blocks.length === 0)}
            style={{ width: 130 }}
          />
          <Select<number>
            allowClear
            size="small"
            placeholder="全部读写属性"
            value={accessFilter}
            options={accessOptions}
            onChange={setAccessFilter}
            disabled={!selectedConn || (points.length === 0 && blocks.length === 0)}
            style={{ width: 130 }}
          />
          <Button type="text" size="small" icon={<ClearOutlined />} disabled={!hasFilters} onClick={clearFilters}>
            清除筛选
          </Button>
        </div>
      ) : null}
      <Tabs className="app-view-tabs" items={tabItems} size="small" />
    </Card>
  );
};

export default PointTable;
