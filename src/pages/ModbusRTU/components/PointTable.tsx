import React from 'react';
import { Button, Card, Popconfirm, Space, Table, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { DcPointUpdate, ModbusPoint } from '../../../adapters';
import {
  type ProtocolRealtimeCellRevision,
  renderProtocolRealtimeQualityCell,
  renderProtocolRealtimeTimestampCell,
  renderProtocolRealtimeValueCell,
} from '../../../components/protocol/protocol-realtime';

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

interface Props {
  points: ModbusPoint[];
  selectedConn: string | null;
  realtimeByTag: Record<string, DcPointUpdate>;
  realtimeRevisionByTag: Record<string, ProtocolRealtimeCellRevision>;
  realtimeLoading: boolean;
  onAdd: () => void;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
}

const PointTable: React.FC<Props> = ({
  points,
  selectedConn,
  realtimeByTag,
  realtimeRevisionByTag,
  realtimeLoading,
  onAdd,
  onEdit,
  onDelete,
}) => {
  const columns: ColumnsType<ModbusPoint> = [
    {
      title: '标签',
      dataIndex: 'tag',
      key: 'tag',
      width: 140,
      render: (value: string) => <Text strong>{value}</Text>,
    },
    {
      title: '功能码',
      dataIndex: 'function',
      key: 'function',
      width: 200,
      render: (value: number) => FUNCTION_CODE_LABELS[value] ?? '未指定',
    },
    { title: '地址', dataIndex: 'address', key: 'address', width: 100 },
    { title: '寄存器数', dataIndex: 'reg_count', key: 'reg_count', width: 90 },
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
      width: 100,
      render: (_value: unknown, _record: ModbusPoint, index: number) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => onEdit(index)}>
            编辑
          </Button>
          <Popconfirm title="确认删除该点位？" onConfirm={() => onDelete(index)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="点表配置 (Tag -> Address)"
      size="small"
      bordered
      className="protocol-point-card"
      extra={(
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={onAdd} disabled={!selectedConn}>
          添加点位
        </Button>
      )}
    >
      <div className="protocol-table-scroll">
        <Table<ModbusPoint>
          rowKey={(record, index) => `${record.tag}-${record.address}-${index ?? 0}`}
          columns={columns}
          dataSource={points}
          loading={realtimeLoading}
          pagination={false}
          size="small"
          scroll={{ x: 1290 }}
          locale={{ emptyText: selectedConn ? '暂无点位' : '请先选择连接' }}
        />
      </div>
    </Card>
  );
};

export default PointTable;
