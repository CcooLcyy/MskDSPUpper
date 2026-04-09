import React from 'react';
import { Button, Card, Popconfirm, Space } from 'antd';
import { DisconnectOutlined, LinkOutlined } from '@ant-design/icons';

interface Props {
  selectedConn: string | null;
  onStart: () => void;
  onStop: () => void;
  extraAction?: React.ReactNode;
}

const OperationsPanel: React.FC<Props> = ({ selectedConn, onStart, onStop, extraAction }) => {
  const disabled = !selectedConn;

  return (
    <Card title="运行操作" size="small" bordered>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button
          type="primary"
          block
          disabled={disabled}
          icon={<LinkOutlined />}
          style={{ background: '#4caf50', borderColor: '#4caf50' }}
          onClick={onStart}
        >
          启动连接功能
        </Button>
        <Popconfirm title="确认停止连接功能？" onConfirm={onStop} disabled={disabled}>
          <Button block danger disabled={disabled} icon={<DisconnectOutlined />}>
            停止连接功能
          </Button>
        </Popconfirm>
        {extraAction ? <div style={{ width: '100%' }}>{extraAction}</div> : null}
      </Space>
    </Card>
  );
};

export default OperationsPanel;
