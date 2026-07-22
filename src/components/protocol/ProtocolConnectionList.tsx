import React from 'react';
import { Button, Card, List, Popconfirm, Space, Tooltip, Typography } from 'antd';
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
  width?: number | string;
  loading: boolean;
  links: T[];
  selectedConn: string | null;
  onSelect: (connName: string) => void;
  onCreate: () => void;
  onCopy?: (connName: string) => void;
  onDelete: (connName: string) => void;
  onRefresh: () => void;
  getStateColor: (item: T) => string;
  getStateLabel?: (item: T) => string;
  getDescription?: (item: T) => React.ReactNode;
  actionsDisabled?: boolean;
  getConnName?: (item: T) => string;
  getDeleteTitle?: (connName: string) => React.ReactNode;
}

const defaultGetConnName = <T extends ProtocolConnectionListItemBase>(item: T): string =>
  item.config?.conn_name ?? `conn_${item.conn_id}`;

function ProtocolConnectionList<T extends ProtocolConnectionListItemBase>({
  title,
  addButtonText,
  emptyText = '\u6682\u65e0\u8fde\u63a5',
  width = 240,
  loading,
  links,
  selectedConn,
  onSelect,
  onCreate,
  onCopy,
  onDelete,
  onRefresh,
  getStateColor,
  getStateLabel,
  getDescription,
  actionsDisabled = false,
  getConnName = defaultGetConnName,
  getDeleteTitle = () => '\u786e\u8ba4\u5220\u9664\u8be5\u8fde\u63a5\uff1f',
}: ProtocolConnectionListProps<T>) {
  return (
    <Card
      title={title}
      size="small"
      bordered
      style={{ width, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
      styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', padding: '8px 0' } }}
      extra={(
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined />}
          aria-label="刷新连接列表"
          title="刷新连接列表"
          loading={loading}
          disabled={actionsDisabled}
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
                  className={`protocol-connection-item${isSelected ? ' is-selected' : ''}`}
                >
                  <div
                    className="protocol-connection-item-main"
                    role="button"
                    tabIndex={actionsDisabled ? -1 : 0}
                    aria-disabled={actionsDisabled}
                    onClick={() => {
                      if (!actionsDisabled) {
                        onSelect(connName);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (!actionsDisabled && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        onSelect(connName);
                      }
                    }}
                  >
                    <Space size={8} align="start">
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
                      <div style={{ minWidth: 0 }}>
                        <Text strong style={{ display: 'block', color: '#fff' }} ellipsis>
                          {connName}
                        </Text>
                        {getDescription || getStateLabel ? (
                          <Text type="secondary" style={{ display: 'block', fontSize: 12 }} ellipsis>
                            {getDescription?.(item) ?? getStateLabel?.(item)}
                          </Text>
                        ) : null}
                      </div>
                    </Space>
                  </div>
                  <Space size={2} className="protocol-connection-item-actions">
                    {onCopy ? (
                      <Tooltip title="复制连接">
                        <Button
                          type="text"
                          size="small"
                          icon={<CopyOutlined />}
                          aria-label={`复制连接 ${connName}`}
                          disabled={actionsDisabled}
                          onClick={() => onCopy(connName)}
                        />
                      </Tooltip>
                    ) : null}
                    <Popconfirm
                      title={getDeleteTitle(connName)}
                      onConfirm={() => onDelete(connName)}
                    >
                      <Tooltip title="删除连接">
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          aria-label={`删除连接 ${connName}`}
                          disabled={actionsDisabled}
                        />
                      </Tooltip>
                    </Popconfirm>
                  </Space>
                </div>
              </List.Item>
            );
          }}
        />
      </div>
      <div style={{ padding: '8px' }}>
        <Button type="primary" block icon={<PlusOutlined />} onClick={onCreate} disabled={actionsDisabled}>
          {addButtonText}
        </Button>
      </div>
    </Card>
  );
}

export default ProtocolConnectionList;
