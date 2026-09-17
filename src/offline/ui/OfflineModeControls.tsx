import React, { useCallback, useState } from 'react';
import { App, Button, Space, Tag, Tooltip, Typography } from 'antd';
import { FolderOpenOutlined, RollbackOutlined, SaveOutlined } from '@ant-design/icons';
import { useAppMode } from '../app-mode-context.ts';
import WorkspaceExportModal from './WorkspaceExportModal.tsx';
import WorkspaceManagerModal from './WorkspaceManagerModal.tsx';

const { Text } = Typography;

/**
 * 顶部模式控件。
 *
 * 在线模式：只显示一个"离线工作区"入口；
 * 离线模式：显示常驻状态条（工作区名 + 未下发提示 + 导出/工作区/切回在线）。
 */
const OfflineModeControls: React.FC = () => {
  const {
    mode,
    workspace,
    workspaceFilePath,
    switching,
    desktopRuntime,
    enterOfflineMode,
    exitOfflineMode,
  } = useAppMode();
  const { message } = App.useApp();
  const [managerOpen, setManagerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const handleEnter = useCallback(async () => {
    try {
      await enterOfflineMode();
      message.success('已进入离线工作区，此模式下的改动不会自动下发到设备');
    } catch (error) {
      message.error(String(error));
    }
  }, [enterOfflineMode, message]);

  const handleExit = useCallback(async () => {
    try {
      await exitOfflineMode();
      message.success('已切回在线模式，工作区内容不会被自动下发');
    } catch (error) {
      message.error(String(error));
    }
  }, [exitOfflineMode, message]);

  if (mode === 'online') {
    return (
      <Tooltip title={desktopRuntime ? '不连接下位机也可以编辑配置并导出 .mskcfg' : '离线工作区仅桌面版可用'}>
        <Button
          size="small"
          icon={<FolderOpenOutlined />}
          onClick={() => void handleEnter()}
          loading={switching}
          disabled={!desktopRuntime}
        >
          离线工作区
        </Button>
      </Tooltip>
    );
  }

  return (
    <>
      <Space size={8} wrap>
        <Tag color="gold">离线工作区</Tag>
        <Text strong>{workspace?.workspace_name ?? '未命名工作区'}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {workspaceFilePath ? '未下发到设备' : '尚未保存到文件'}
        </Text>
        <Button size="small" icon={<SaveOutlined />} onClick={() => setManagerOpen(true)}>
          工作区
        </Button>
        <Button size="small" type="primary" disabled={!workspace} onClick={() => setExportOpen(true)}>
          导出 .mskcfg
        </Button>
        <Button size="small" icon={<RollbackOutlined />} onClick={() => void handleExit()} loading={switching}>
          切回在线
        </Button>
      </Space>

      <WorkspaceManagerModal open={managerOpen} onClose={() => setManagerOpen(false)} />
      <WorkspaceExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
    </>
  );
};

export default OfflineModeControls;
