import React, { useCallback, useEffect, useState } from 'react';
import { App, Button, Input, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FolderOpenOutlined } from '@ant-design/icons';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { WorkspaceSummary } from '../../adapters/types.ts';
import { api as tauriApi } from '../../adapters/tauri.ts';
import { useAppMode } from '../app-mode-context.ts';
import { deleteWorkspaceFile } from '../workspace/store.ts';
import { WORKSPACE_FILE_EXTENSION, type OfflineWorkspace } from '../workspace/types.ts';

const { Text } = Typography;

interface WorkspaceManagerModalProps {
  open: boolean;
  onClose: () => void;
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes <= 0) {
    return '-';
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

function formatTime(updatedAtMs: number): string {
  if (!updatedAtMs) {
    return '-';
  }

  return new Date(updatedAtMs).toLocaleString('zh-CN');
}

/** 工作区是否还没有任何配置：用于判断导入现存配置前是否需要二次确认。 */
function isWorkspaceEmpty(workspace: OfflineWorkspace): boolean {
  const config = workspace.config;

  return config.iec104.links.length === 0
    && config.modbus_rtu.links.length === 0
    && config.modbus_tcp.links.length === 0
    && config.dlt645.links.length === 0
    && config.agc.groups.length === 0
    && config.avc.groups.length === 0
    && config.calc.groups.length === 0
    && config.data_bus.connections.length === 0
    && config.data_bus.conn_tags.length === 0
    && config.data_bus.routes.items.length === 0
    && workspace.agc_control_profiles.length === 0;
}

/** 工作区管理：新建 / 打开 / 另存为 / 导入现有配置 / 删除。 */
const WorkspaceManagerModal: React.FC<WorkspaceManagerModalProps> = ({ open: isOpen, onClose }) => {
  const {
    workspace,
    workspaceFilePath,
    listWorkspaces,
    createWorkspace,
    openWorkspaceFile,
    seedWorkspaceFromSnapshotFile,
    saveWorkspaceAs,
  } = useAppMode();
  const { message, modal } = App.useApp();
  const [files, setFiles] = useState<WorkspaceSummary[]>([]);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);

    try {
      setFiles(await listWorkspaces());
    } catch (error) {
      message.error(`读取工作区列表失败：${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [listWorkspaces, message]);

  useEffect(() => {
    if (isOpen) {
      void refresh();
    }
  }, [isOpen, refresh]);

  const handleNew = useCallback(() => {
    createWorkspace(newName.trim() || '未命名工作区');
    setNewName('');
    message.success('已新建工作区，请使用“另存为”保存到文件');
  }, [createWorkspace, message, newName]);

  const handleOpen = useCallback(async (filePath: string) => {
    setBusy(true);

    try {
      await openWorkspaceFile(filePath);
      message.success('工作区已打开');
    } catch (error) {
      message.error(`打开工作区失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [message, openWorkspaceFile]);

  const handleSelectFile = useCallback(async () => {
    const selected = await open({
      title: '打开离线工作区',
      multiple: false,
      directory: false,
      filters: [{ name: 'MskDSP 工作区', extensions: [WORKSPACE_FILE_EXTENSION] }],
    });

    if (typeof selected !== 'string') {
      return;
    }

    await handleOpen(selected);
  }, [handleOpen]);

  const handleSaveAs = useCallback(async () => {
    const selected = await save({
      title: '另存离线工作区',
      defaultPath: `${workspace?.workspace_name ?? '未命名工作区'}.${WORKSPACE_FILE_EXTENSION}`,
      filters: [{ name: 'MskDSP 工作区', extensions: [WORKSPACE_FILE_EXTENSION] }],
    });

    if (typeof selected !== 'string') {
      return;
    }

    setBusy(true);

    try {
      const savedPath = await saveWorkspaceAs(selected);

      message.success(`工作区已保存：${savedPath}`);
      await refresh();
    } catch (error) {
      message.error(`保存工作区失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [message, refresh, saveWorkspaceAs, workspace]);

  const runImportExistingConfig = useCallback(async () => {
    const selected = await open({
      title: '选择要导入的现有配置（.mskcfg）',
      multiple: false,
      directory: false,
      filters: [{ name: 'MskDSP 配置', extensions: ['mskcfg'] }],
    });

    if (typeof selected !== 'string') {
      return;
    }

    setBusy(true);

    try {
      const savedPath = await seedWorkspaceFromSnapshotFile(selected);

      message.success(`已导入现有配置，工作区已保存：${savedPath}`);
      await refresh();
    } catch (error) {
      message.error(`导入现有配置失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [message, refresh, seedWorkspaceFromSnapshotFile]);

  // 导入会用所选配置替换当前工作区内容，非空工作区先确认一次。
  const handleImportExistingConfig = useCallback(() => {
    if (!workspace || isWorkspaceEmpty(workspace)) {
      void runImportExistingConfig();

      return;
    }

    modal.confirm({
      title: '导入现有配置？',
      content: `导入会用所选 .mskcfg 替换当前工作区「${workspace.workspace_name}」的配置，并另存为新的工作区文件；当前工作区里未保存到文件的改动会丢失。`,
      okText: '继续导入',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => runImportExistingConfig(),
    });
  }, [modal, runImportExistingConfig, workspace]);

  const handleDelete = useCallback(async (filePath: string) => {
    try {
      await deleteWorkspaceFile(filePath);
      message.success('工作区文件已删除');
      await refresh();
    } catch (error) {
      message.error(`删除工作区失败：${String(error)}`);
    }
  }, [message, refresh]);

  // 直接打开默认工作区目录：列表为空或需要手工备份/放入文件时最省事。
  const handleOpenWorkspaceDirectory = useCallback(async () => {
    try {
      await tauriApi.openRuntimeDirectory('workspaces');
    } catch (error) {
      message.error(`打开工作区目录失败：${String(error)}`);
    }
  }, [message]);

  const columns: ColumnsType<WorkspaceSummary> = [
    {
      title: '文件名',
      dataIndex: 'file_name',
      key: 'file_name',
      render: (fileName: string, record) => (
        <Space size={8}>
          <Text strong>{fileName}</Text>
          {record.file_path === workspaceFilePath ? <Tag color="gold">当前</Tag> : null}
        </Space>
      ),
    },
    {
      title: '修改时间',
      dataIndex: 'updated_at_ms',
      key: 'updated_at_ms',
      width: 180,
      render: (value: number) => <Text type="secondary">{formatTime(value)}</Text>,
    },
    {
      title: '大小',
      dataIndex: 'size_bytes',
      key: 'size_bytes',
      width: 100,
      render: (value: number) => <Text type="secondary">{formatSize(value)}</Text>,
    },
    {
      title: '操作',
      key: 'action',
      width: 160,
      render: (_: unknown, record) => (
        <Space size={8}>
          <Button size="small" onClick={() => void handleOpen(record.file_path)} loading={busy}>
            打开
          </Button>
          <Popconfirm
            title="确认删除该工作区文件？"
            description="删除后无法从本机恢复。"
            onConfirm={() => void handleDelete(record.file_path)}
          >
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Modal open={isOpen} title="离线工作区" width={760} onCancel={onClose} footer={null}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div>
          <Text type="secondary">当前工作区：</Text>
          <Text strong>{workspace?.workspace_name ?? '未打开'}</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {workspaceFilePath ?? '尚未保存到文件'}
            </Text>
          </div>
        </div>

        <Space wrap>
          <Input
            placeholder="新工作区名称"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            style={{ width: 200 }}
          />
          <Button onClick={handleNew}>新建</Button>
          <Button onClick={() => void handleSelectFile()} loading={busy}>打开文件…</Button>
          <Button onClick={() => void handleSaveAs()} loading={busy}>另存为…</Button>
          <Button onClick={handleImportExistingConfig} loading={busy}>导入现有配置…</Button>
          <Button onClick={() => void refresh()} loading={loading}>刷新列表</Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => void handleOpenWorkspaceDirectory()}>
            打开工作区目录
          </Button>
        </Space>

        <Table
          rowKey="file_path"
          size="small"
          columns={columns}
          dataSource={files}
          loading={loading}
          pagination={false}
          locale={{ emptyText: '工作区目录下暂无文件' }}
        />
      </Space>
    </Modal>
  );
};

export default WorkspaceManagerModal;
