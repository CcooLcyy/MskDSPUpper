import React from 'react';
import { Button, Card, List, Popconfirm, Space, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';

const { Text } = Typography;

export interface ProtocolConnectionListItemBase {
  config: {
    conn_name: string;
  } | null;
  conn_id: number;
  state: number;
}

interface ProtocolConnectionListProps<T extends ProtocolConnectionListItemBase> {
  title: React.ReactNode;
  addButtonText: React.ReactNode;
  emptyText?: React.ReactNode;
  loading: boolean;
  links: T[];
  selectedConn: string | null;
  onSelect: (connName: string) => void;
  onCreate: () => void;
  onCopy?: (connName: string) => void;
  onDelete: (connName: string) => void;
  onRefresh: () => void;
  getStateColor: (item: T) => string;
  getConnName?: (item: T) => string;
  getDeleteTitle?: (connName: string) => React.ReactNode;
}

const defaultGetConnName = <T extends ProtocolConnectionListItemBase>(item: T): string =>
  item.config?.conn_name ?? `conn_${item.conn_id}`;

function ProtocolConnectionList<T extends ProtocolConnectionListItemBase>({
  title,
  addButtonText,
  emptyText = '\u6682\u65e0\u8fde\u63a5',
  loading,
  links,
  selectedConn,
  onSelect,
  onCreate,
  onCopy,
  onDelete,
  onRefresh,
  getStateColor,
  getConnName = defaultGetConnName,
  getDeleteTitle = () => '\u786e\u8ba4\u5220\u9664\u8be5\u8fde\u63a5\uff1f',
}: ProtocolConnectionListProps<T>) {
  return (
    <Card
      title={title}
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
          locale={{ emptyText }}
          renderItem={(item) => {
            const connName = getConnName(item);
            const isSelected = selectedConn === connName;
            const stateColor = getStateColor(item);

            return (
              <List.Item key={connName} style={{ padding: '4px 0', borderBlockEnd: 'none' }}>
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
                          background: stateColor,
                          boxShadow: `0 0 10px ${stateColor}`,
                          flexShrink: 0,
                        }}
                      />
                      <Text strong style={{ color: '#fff' }} ellipsis>
                        {connName}
                      </Text>
                    </Space>
                    <Space size={4}>
                      {onCopy ? (
                        <Button
                          type="text"
                          size="small"
                          icon={<CopyOutlined />}
                          aria-label={`复制连接 ${connName}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onCopy(connName);
                          }}
                        />
                      ) : null}
                      <Popconfirm
                        title={getDeleteTitle(connName)}
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
                  </Space>
                </div>
              </List.Item>
            );
          }}
        />
      </div>
      <div style={{ padding: '8px' }}>
        <Button type="primary" block icon={<PlusOutlined />} onClick={onCreate}>
          {addButtonText}
        </Button>
      </div>
    </Card>
  );
}

export default ProtocolConnectionList;
