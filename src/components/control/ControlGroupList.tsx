import React from 'react';
import { Button, Card, List, Space, Tag, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';

const { Text } = Typography;

export type ControlGroupListItem = {
  name: string;
  connId: number;
  stateLabel: string;
  stateColor: string;
  stateTagColor: string;
  commandMode: string;
  memberCount: number;
  defaultPointCount: number;
};

type ControlGroupListProps = {
  items: ControlGroupListItem[];
  loading: boolean;
  selectedName: string | null;
  emptyText: string;
  onReload: () => void;
  onSelect: (name: string) => void;
  onCreate: () => void;
};

const ControlGroupList: React.FC<ControlGroupListProps> = ({
  items,
  loading,
  selectedName,
  emptyText,
  onReload,
  onSelect,
  onCreate,
}) => (
  <Card
    title="控制组列表"
    size="small"
    bordered
    style={{ width: '100%', minWidth: 0, minHeight: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    styles={{ body: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '8px 0' } }}
    extra={
      <Button
        type="text"
        size="small"
        icon={<ReloadOutlined />}
        loading={loading}
        onClick={onReload}
      />
    }
  >
    <div style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable' }}>
      <List
        dataSource={items}
        locale={{ emptyText }}
        renderItem={(item) => {
          const isActive = item.name === selectedName;
          return (
            <List.Item
              onClick={() => onSelect(item.name)}
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
                        background: item.stateColor,
                      }}
                    />
                    <Text style={{ color: '#fff' }}>{item.name}</Text>
                  </Space>
                  <Tag color={item.stateTagColor} style={{ marginInlineEnd: 0 }}>
                    {item.stateLabel}
                  </Tag>
                </Space>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  conn_id={item.connId} | {item.commandMode} | 成员 {item.memberCount} | 默认点 {item.defaultPointCount}
                </Text>
              </Space>
            </List.Item>
          );
        }}
      />
    </div>
    <div style={{ padding: '8px 12px', borderTop: '1px solid #3e3e42' }}>
      <Button block icon={<PlusOutlined />} onClick={onCreate}>
        + 新增控制组
      </Button>
    </div>
  </Card>
);

export default ControlGroupList;
