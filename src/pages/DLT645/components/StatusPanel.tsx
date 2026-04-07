import React from 'react';
import { Card, Descriptions, Tag, Typography } from 'antd';
import type { Dlt645LinkInfo } from '../../../adapters';

const { Text } = Typography;

const STATE_MAP: Record<number, { label: string; color: string }> = {
  0: { label: '未知', color: 'default' },
  1: { label: '已停止', color: 'red' },
  2: { label: '运行中', color: 'green' },
  3: { label: '待删除', color: 'orange' },
};

interface Props {
  link: Dlt645LinkInfo | null;
}

const StatusPanel: React.FC<Props> = ({ link }) => {
  const state = STATE_MAP[link?.state ?? 0] ?? STATE_MAP[0];

  return (
    <Card title="运行状态" size="small" bordered>
      <Descriptions size="small" column={1} colon={false}>
        <Descriptions.Item label="当前状态">
          <Tag color={state.color}>{state.label}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="最近错误">
          <Text>{link?.last_error || 'None'}</Text>
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
};

export default StatusPanel;
