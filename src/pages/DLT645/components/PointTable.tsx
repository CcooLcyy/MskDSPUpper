import React from 'react';
import { Button, Card, Popconfirm, Space, Table, Tabs, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { DcPointUpdate, Dlt645Point, Dlt645Block, Dlt645BlockItem } from '../../../adapters';
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

interface Props {
  points: Dlt645Point[];
  blocks: Dlt645Block[];
  selectedConn: string | null;
  realtimeByTag: Record<string, DcPointUpdate>;
  realtimeRevisionByTag: Record<string, ProtocolRealtimeCellRevision>;
  realtimeLoading: boolean;
  onAddPoint: () => void;
  onEditPoint: (index: number) => void;
  onDeletePoint: (index: number) => void;
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
  onAddPoint,
  onEditPoint,
  onDeletePoint,
  onAddBlock,
  onEditBlock,
  onDeleteBlock,
}) => {
  const pointColumns: ColumnsType<Dlt645Point> = [
    {
      title: '标签',
      dataIndex: 'tag',
      key: 'tag',
      width: 140,
      render: (value: string) => <Text strong>{value}</Text>,
    },
    { title: 'DI', dataIndex: 'di', key: 'di', width: 120 },
    { title: '数据长度', dataIndex: 'data_len', key: 'data_len', width: 80 },
    {
      title: '数据类型',
      dataIndex: 'data_type',
      key: 'data_type',
      width: 100,
      render: (value: number) => DATA_TYPE_LABELS[value] ?? '未指定',
    },
    {
      title: '实时值',
      key: 'realtime_value',
      width: 160,
      render: (_value: unknown, record: Dlt645Point) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeValueCell(update, realtimeRevisionByTag[record.tag]?.value);
      },
    },
    {
      title: '时间',
      key: 'realtime_ts',
      width: 130,
      render: (_value: unknown, record: Dlt645Point) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeTimestampCell(update, realtimeRevisionByTag[record.tag]?.timestamp);
      },
    },
    {
      title: '质量',
      key: 'realtime_quality',
      width: 100,
      render: (_value: unknown, record: Dlt645Point) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeQualityCell(update, realtimeRevisionByTag[record.tag]?.quality);
      },
    },
    {
      title: '读写属性',
      dataIndex: 'access',
      key: 'access',
      width: 80,
      render: (value: number) => ACCESS_MODE_LABELS[value] ?? '未指定',
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_value: unknown, _record: Dlt645Point, index: number) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => onEditPoint(index)}>
            编辑
          </Button>
          <Popconfirm title="确认删除该点位？" onConfirm={() => onDeletePoint(index)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const blockColumns: ColumnsType<Dlt645Block> = [
    {
      title: '块 DI',
      dataIndex: 'block_di',
      key: 'block_di',
      width: 120,
      render: (value: string) => <Text strong>{value}</Text>,
    },
    { title: '块数据长度', dataIndex: 'block_data_len', key: 'block_data_len', width: 100 },
    {
      title: '子项数量',
      key: 'items_count',
      width: 80,
      render: (_value: unknown, record: Dlt645Block) => record.items.length,
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_value: unknown, _record: Dlt645Block, index: number) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => onEditBlock(index)}>
            编辑
          </Button>
          <Popconfirm title="确认删除该数据块？" onConfirm={() => onDeleteBlock(index)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const blockItemColumns: ColumnsType<Dlt645BlockItem> = [
    { title: '标签', dataIndex: 'tag', key: 'tag', width: 140 },
    { title: '数据长度', dataIndex: 'data_len', key: 'data_len', width: 80 },
    {
      title: '数据类型',
      dataIndex: 'data_type',
      key: 'data_type',
      width: 100,
      render: (value: number) => DATA_TYPE_LABELS[value] ?? '未指定',
    },
    {
      title: '读写属性',
      dataIndex: 'access',
      key: 'access',
      width: 80,
      render: (value: number) => ACCESS_MODE_LABELS[value] ?? '未指定',
    },
    {
      title: '实时值',
      key: 'realtime_value',
      width: 160,
      render: (_value: unknown, record: Dlt645BlockItem) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeValueCell(update, realtimeRevisionByTag[record.tag]?.value);
      },
    },
    {
      title: '时间',
      key: 'realtime_ts',
      width: 130,
      render: (_value: unknown, record: Dlt645BlockItem) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeTimestampCell(update, realtimeRevisionByTag[record.tag]?.timestamp);
      },
    },
    {
      title: '质量',
      key: 'realtime_quality',
      width: 100,
      render: (_value: unknown, record: Dlt645BlockItem) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeQualityCell(update, realtimeRevisionByTag[record.tag]?.quality);
      },
    },
  ];

  const expandedBlockRow = (record: Dlt645Block): React.ReactNode => (
    <Table<Dlt645BlockItem>
      rowKey={(item, index) => `${item.tag}-${index ?? 0}`}
      columns={blockItemColumns}
      dataSource={record.items}
      pagination={false}
      size="small"
    />
  );

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
              dataSource={points}
              loading={realtimeLoading}
              pagination={false}
              size="small"
              scroll={{ x: 1010 }}
              locale={{ emptyText: selectedConn ? '暂无点位' : '请先选择连接' }}
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
              dataSource={blocks}
              loading={realtimeLoading}
              pagination={false}
              size="small"
              scroll={{ x: 500 }}
              expandable={{ expandedRowRender: expandedBlockRow }}
              locale={{ emptyText: selectedConn ? '暂无数据块' : '请先选择连接' }}
            />
          </div>
        </div>
      ),
    },
  ];

  return (
    <Card
      title="点表配置 (Tag -> DI)"
      size="small"
      bordered
      className="protocol-point-card"
      extra={(
        <Space>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={onAddPoint} disabled={!selectedConn}>
            添加点位
          </Button>
          <Button size="small" icon={<PlusOutlined />} onClick={onAddBlock} disabled={!selectedConn}>
            添加数据块
          </Button>
        </Space>
      )}
    >
      <Tabs items={tabItems} size="small" />
    </Card>
  );
};

export default PointTable;
