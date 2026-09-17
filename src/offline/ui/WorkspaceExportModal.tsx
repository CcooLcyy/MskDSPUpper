import React, { useCallback, useMemo, useState } from 'react';
import { App, Button, Modal, Space, Tag, Typography } from 'antd';
import { save } from '@tauri-apps/plugin-dialog';
import type { ConfigExportSectionId, FullConfigExportSnapshot } from '../../adapters/types.ts';
import { api as tauriApi } from '../../adapters/tauri.ts';
import { getConfigSectionLabel, getConfigSectionOptions } from '../../utils/config-export.ts';
import { useAppMode } from '../app-mode-context.ts';
import { ALL_CONFIG_SECTION_IDS, buildWorkspaceExportFileName } from '../workspace/sections.ts';
import { selfCheckSnapshot, type SelfCheckIssue } from '../workspace/self-check.ts';
import { workspaceToSnapshot } from '../workspace/snapshot.ts';
import ConfigSectionPickerModal from '../../pages/Settings/components/ConfigSectionPickerModal.tsx';

const { Text, Paragraph } = Typography;

interface WorkspaceExportModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 离线导出流程：选择分区 → 自检 → 写文件 → 交付提示。
 *
 * 自检出现 error 时阻断导出；warning 允许继续但要求确认。
 */
const WorkspaceExportModal: React.FC<WorkspaceExportModalProps> = ({ open, onClose }) => {
  const { workspace } = useAppMode();
  const { message } = App.useApp();
  const [sections, setSections] = useState<ConfigExportSectionId[]>([]);
  const [issues, setIssues] = useState<SelfCheckIssue[]>([]);
  const [snapshot, setSnapshot] = useState<FullConfigExportSnapshot | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const sectionOptions = useMemo(() => getConfigSectionOptions(), []);
  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');

  const defaultSections = useCallback((): ConfigExportSectionId[] => {
    const included = workspace?.metadata.included_sections ?? [];

    return included.length > 0 ? [...included] : [...ALL_CONFIG_SECTION_IDS];
  }, [workspace]);

  const handleOpenSections = useCallback(() => {
    setSections((current) => (current.length > 0 ? current : defaultSections()));
    setIssues([]);
    setSnapshot(null);
    setExportedPath(null);
  }, [defaultSections]);

  const buildSnapshot = useCallback((): FullConfigExportSnapshot | null => {
    if (!workspace) {
      message.error('未打开离线工作区');

      return null;
    }

    return workspaceToSnapshot(workspace, {
      sections,
      exportedAtIso: new Date().toISOString(),
    });
  }, [message, sections, workspace]);

  const handleSelfCheck = useCallback(() => {
    try {
      const built = buildSnapshot();

      if (!built) {
        return;
      }

      const found = selfCheckSnapshot(built, { baselineConnTags: workspace?.base.conn_tags ?? [] });

      setSnapshot(built);
      setIssues(found);
      console.info('[离线工作区] 导出自检完成', {
        sections,
        errors: found.filter((issue) => issue.level === 'error').length,
        warnings: found.filter((issue) => issue.level === 'warning').length,
      });
    } catch (error) {
      message.error(`自检失败：${String(error)}`);
    }
  }, [buildSnapshot, message, sections, workspace]);

  const handleExport = useCallback(async () => {
    if (!workspace || !snapshot) {
      return;
    }

    setWorking(true);

    try {
      const defaultFileName = buildWorkspaceExportFileName(
        workspace.workspace_name,
        snapshot.exported_at,
        sections,
      );
      const selectedPath = await save({
        title: '导出配置供现场导入',
        defaultPath: defaultFileName,
        filters: [{ name: 'MskDSP 配置', extensions: ['mskcfg'] }],
      });

      if (!selectedPath) {
        return;
      }

      const finalPath = /\.mskcfg$/i.test(selectedPath) ? selectedPath : `${selectedPath}.mskcfg`;
      const savedPath = await tauriApi.saveFullConfigExport(finalPath, snapshot);

      setExportedPath(savedPath);
      message.success('配置已导出，请交给现场导入');
    } catch (error) {
      message.error(`导出失败：${String(error)}`);
    } finally {
      setWorking(false);
    }
  }, [message, sections, snapshot, workspace]);

  const deliveryText = useMemo(() => {
    if (!exportedPath || !snapshot) {
      return '';
    }

    const routeCount = snapshot.config.data_bus.routes.items.length;
    const moduleList = snapshot.module_startup.modules.join('、') || '（无）';
    const sectionList = sections.map((section) => getConfigSectionLabel(section)).join('、');
    const includeReplace = routeCount > 0 || snapshot.config.data_bus.connections.length > 0;

    const lines = [
      `文件：${exportedPath}`,
      `包含分区：${sectionList}`,
      `需要在线模块：${moduleList}`,
      `建议导入方式：${includeReplace ? '覆盖（replace）' : '合并（merge）'}`,
      includeReplace
        ? `覆盖会以文件中的点表、标签与路由重建目标态；文件包含 ${routeCount} 条路由和 ${snapshot.config.data_bus.connections.length} 个连接。`
        : '文件未包含数据总线路由，合并即可。',
      '导入前：先在现场导出一次现状备份，并确认相关链路与控制组已停止。',
    ];

    if (warnings.length > 0) {
      lines.push('导入前请逐条确认下列提醒：');
      lines.push(...warnings.map((issue) => `- ${issue.message}`));
    }

    return lines.join('\n');
  }, [exportedPath, sections, snapshot, warnings]);

  const handleClose = useCallback(() => {
    setSections([]);
    setIssues([]);
    setSnapshot(null);
    setExportedPath(null);
    onClose();
  }, [onClose]);

  if (exportedPath) {
    return (
      <Modal
        open={open}
        title="导出完成：交付提示"
        width={720}
        onCancel={handleClose}
        footer={<Button type="primary" onClick={handleClose}>关闭</Button>}
      >
        <Paragraph copyable={{ text: deliveryText, tooltips: ['复制交付提示', '已复制'] }}>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{deliveryText}</pre>
        </Paragraph>
      </Modal>
    );
  }

  if (snapshot) {
    return (
      <Modal
        open={open}
        title="导出前自检"
        width={720}
        okText={errors.length > 0 ? '返回修改' : '确认导出'}
        cancelText="返回分区选择"
        okButtonProps={{ disabled: false }}
        confirmLoading={working}
        onCancel={() => setSnapshot(null)}
        onOk={() => {
          if (errors.length > 0) {
            setSnapshot(null);

            return;
          }

          void handleExport();
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={8}>
            <Tag color={errors.length > 0 ? 'red' : 'green'}>错误 {errors.length}</Tag>
            <Tag color={warnings.length > 0 ? 'gold' : 'default'}>提醒 {warnings.length}</Tag>
          </Space>

          {errors.length === 0 && warnings.length === 0 ? (
            <Text type="secondary">未发现配置问题。</Text>
          ) : null}

          {errors.length > 0 ? (
            <div>
              <Text strong>阻断问题（必须先修正）</Text>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {errors.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    <Text type="danger">{issue.message}</Text>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {warnings.length > 0 ? (
            <div>
              <Text strong>提醒（可继续导出）</Text>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {warnings.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    <Text type="warning">{issue.message}</Text>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Space>
      </Modal>
    );
  }

  return (
    <ConfigSectionPickerModal
      open={open}
      title="选择要导出的模块"
      confirmText="开始自检"
      options={sectionOptions}
      selectedKeys={sections}
      onCancel={handleClose}
      onChange={setSections}
      onConfirm={() => {
        handleOpenSections();
        handleSelfCheck();
      }}
      extra={
        <Text type="secondary">
          导出会生成 `.mskcfg` 文件交给现场导入；未选中的分区不会被文件包含。
        </Text>
      }
    />
  );
};

export default WorkspaceExportModal;
