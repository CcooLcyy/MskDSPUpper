import React from 'react';
import { Button, Empty, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

type ControlEmptyStateProps = {
  moduleName: 'AGC' | 'AVC';
  onCreate: () => void;
};

const ControlEmptyState: React.FC<ControlEmptyStateProps> = ({ moduleName, onCreate }) => (
  <div className="control-empty-state">
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={<Typography.Text type="secondary">暂无 {moduleName} 控制组</Typography.Text>}
    >
      <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
        新增 {moduleName} 控制组
      </Button>
    </Empty>
  </div>
);

export default ControlEmptyState;
