import React from 'react';
import { Button, Card, List, Popconfirm, Space, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ModbusLinkInfo } from '../../../adapters';

const { Text } = Typography;

const STATE_COLOR_MAP: Record<number, string> = {
  1: '#f44336',
  2: '#4caf50',
  3: '#ff9800',
};

interface Props {
  links: ModbusLinkInfo[];
  selectedConn: string | null;
  loading: boolean;
  onSelect: (connName: string) => void;
  onCreate: () => void;
  onDelete: (connName: string) => void;
  onRefresh: () => void;
}

const ConnectionList: React.FC<Props> = ({
  links,
  selectedConn,
  loading,
  onSelect,
  onCreate,
  onDelete,
  onRefresh,
}) => {
  return (
    <Card
      title="连接列表"
      size="small"
      bordered
      style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
      styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', padding: '8px 0' } }}
      extra={(
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={onRefresh}
        />
      )}
    >
      <div style={{ flex: 1, overflow: 'auto', padding: '0 8px' }}>
        <List
          dataSource={links}
          locale={{ emptyText: '暂无连接' }}
          renderItem={(item) => {
            const connName = item.config?.conn_name ?? `链路-${item.conn_id}`;
            const isSelected = selectedConn === connName;

            return (
              <List.Item style={{ padding: '4px 0', borderBlockEnd: 'none' }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(connName)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(connName);
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 6,
                    background: isSelected ? '#37373d' : '#2b2b31',
                    border: '1px solid #3d3d45',
                    cursor: 'pointer',
                  }}
                >
                  <Space style={{ width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Space size={8}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: STATE_COLOR_MAP[item.state] ?? '#8c8c8c',
                          boxShadow: `0 0 10px ${STATE_COLOR_MAP[item.state] ?? '#8c8c8c'}`,
                          flexShrink: 0,
                        }}
                      />
                      <Text strong style={{ color: '#fff' }} ellipsis>
                        {connName}
                      </Text>
                    </Space>
                    <Popconfirm
                      title="确认删除该连接？"
                      onConfirm={(event) => {
                        event?.stopPropagation();
                        onDelete(connName);
                      }}
                    >
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </Popconfirm>
                  </Space>
                </div>
              </List.Item>
            );
          }}
        />
      </div>
      <div style={{ padding: '8px' }}>
        <Button type="primary" block icon={<PlusOutlined />} onClick={onCreate}>
          新增连接
        </Button>
      </div>
    </Card>
  );
};

export default ConnectionList;
