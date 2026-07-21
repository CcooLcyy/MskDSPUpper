import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Descriptions, message, Modal, Popconfirm, Radio, Space, Typography } from 'antd';
import { DeleteOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { api } from '../../adapters';
import type { ConfigExportSectionId, RuntimeDirectoryKind, RuntimePaths } from '../../adapters';
import {
  applyConfigImport,
  applyFullConfigImport,
  buildConfigExportSnapshot,
  buildFullConfigExportSnapshot,
  getConfigImportModeLabel,
  getConfigImportModeOptions,
  getConfigSectionLabel,
  getConfigSectionOptions,
  getIncludedConfigSections,
  saveFullConfigExport,
  selectFullConfigImport,
} from '../../utils/config-export';
import type {
  ConfigImportMode,
  ConfigImportModeOption,
  FullConfigImportResult,
  FullConfigImportSelection,
} from '../../utils/config-export';
import ConfigSectionPickerModal from './components/ConfigSectionPickerModal';

const { Paragraph, Text } = Typography;

const DEFAULT_IMPORT_MODE: ConfigImportMode = 'merge';
const IMPORT_MODE_OPTIONS: ConfigImportModeOption[] = getConfigImportModeOptions();

function formatSectionNames(sections: readonly ConfigExportSectionId[]): string {
  return sections.map((section) => getConfigSectionLabel(section)).join('、');
}

function formatImportSummary(result: FullConfigImportResult): string {
  const parts: string[] = [];

  if (result.sections.includes('iec104')) {
    parts.push(`IEC104 ${result.summary.iec104Links}`);
  }

  if (result.sections.includes('modbus_rtu')) {
    parts.push(`ModbusRTU ${result.summary.modbusRtuLinks}`);
  }

  if (result.sections.includes('dlt645')) {
    parts.push(`DLT645 ${result.summary.dlt645Links}`);
  }

  if (result.sections.includes('agc')) {
    parts.push(`AGC ${result.summary.agcGroups}`);
  }

  if (result.sections.includes('avc')) {
    parts.push(`AVC ${result.summary.avcGroups}`);
  }

  if (result.sections.includes('data_bus')) {
    parts.push(`DataBus ${result.summary.dataBusRoutes}`);
  }

  return parts.join(' / ');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

const Settings: React.FC = () => {
  const [isExportingConfig, setIsExportingConfig] = useState(false);
  const [isImportingConfig, setIsImportingConfig] = useState(false);
  const [isFullImportModalOpen, setIsFullImportModalOpen] = useState(false);
  const [isApplyingFullImport, setIsApplyingFullImport] = useState(false);
  const [fullImportSelection, setFullImportSelection] = useState<FullConfigImportSelection | null>(null);
  const [fullImportMode, setFullImportMode] = useState<ConfigImportMode>(DEFAULT_IMPORT_MODE);
  const [isModuleExportModalOpen, setIsModuleExportModalOpen] = useState(false);
  const [isModuleExporting, setIsModuleExporting] = useState(false);
  const [selectedExportSections, setSelectedExportSections] = useState<ConfigExportSectionId[]>([]);
  const [isPreparingModuleImport, setIsPreparingModuleImport] = useState(false);
  const [isModuleImportModalOpen, setIsModuleImportModalOpen] = useState(false);
  const [isApplyingModuleImport, setIsApplyingModuleImport] = useState(false);
  const [selectedImportSections, setSelectedImportSections] = useState<ConfigExportSectionId[]>([]);
  const [moduleImportSelection, setModuleImportSelection] = useState<FullConfigImportSelection | null>(null);
  const [moduleImportMode, setModuleImportMode] = useState<ConfigImportMode>(DEFAULT_IMPORT_MODE);
  const [runtimePaths, setRuntimePaths] = useState<RuntimePaths | null>(null);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [modal, modalContextHolder] = Modal.useModal();

  const exportSectionOptions = useMemo(() => getConfigSectionOptions(), []);
  const fullImportSections = useMemo(
    () => (fullImportSelection ? getIncludedConfigSections(fullImportSelection.snapshot) : []),
    [fullImportSelection],
  );
  const importSectionOptions = useMemo(
    () => (moduleImportSelection ? getConfigSectionOptions(moduleImportSelection.snapshot) : []),
    [moduleImportSelection],
  );

  useEffect(() => {
    void api.getRuntimePaths()
      .then(setRuntimePaths)
      .catch((error) => messageApi.error(`读取本地目录失败: ${error}`));
  }, [messageApi]);

  const handleOpenRuntimeDirectory = useCallback(async (kind: RuntimeDirectoryKind) => {
    try {
      await api.openRuntimeDirectory(kind);
    } catch (error) {
      messageApi.error(`打开目录失败: ${error}`);
    }
  }, [messageApi]);

  const handleClearLowerUpdateCache = useCallback(async () => {
    setIsClearingCache(true);
    try {
      const result = await api.clearLowerUpdateCache();
      messageApi.success(`已清理 ${result.removed_files} 个文件，释放 ${formatBytes(result.reclaimed_bytes)}`);
    } catch (error) {
      messageApi.error(`清理更新缓存失败: ${error}`);
    } finally {
      setIsClearingCache(false);
    }
  }, [messageApi]);

  const showImportResult = useCallback(
    (result: FullConfigImportResult, successMessage: string) => {
      messageApi.success(successMessage);

      if (result.warnings.length === 0 && result.startedModules.length === 0) {
        return;
      }

      modal.info({
        title: '导入完成',
        width: 680,
        content: (
          <div style={{ marginTop: 12 }}>
            <Paragraph style={{ marginBottom: 8 }}>
              文件: <Text code>{result.filePath}</Text>
            </Paragraph>
            <Paragraph style={{ marginBottom: 8 }}>模块范围: {formatSectionNames(result.sections)}</Paragraph>
            <Paragraph style={{ marginBottom: 8 }}>导入方式: {getConfigImportModeLabel(result.mode)}</Paragraph>
            {result.startedModules.length > 0 ? (
              <Paragraph style={{ marginBottom: 8 }}>启动模块: {result.startedModules.join(', ')}</Paragraph>
            ) : null}
            {result.warnings.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {result.warnings.map((warning) => (
                  <Text key={warning} type="warning">
                    {warning}
                  </Text>
                ))}
              </div>
            ) : null}
          </div>
        ),
      });
    },
    [messageApi, modal],
  );

  const handleExportConfig = useCallback(async () => {
    setIsExportingConfig(true);

    try {
      const snapshot = await buildFullConfigExportSnapshot();
      const savedPath = await saveFullConfigExport(snapshot);

      if (savedPath) {
        messageApi.success(`全部配置已导出到: ${savedPath}`);
      }
    } catch (error) {
      messageApi.error(`导出全部配置失败: ${error}`);
    } finally {
      setIsExportingConfig(false);
    }
  }, [messageApi]);

  const handleImportConfig = useCallback(async () => {
    setIsImportingConfig(true);

    try {
      const selection = await selectFullConfigImport();
      if (!selection) {
        return;
      }

      setFullImportSelection(selection);
      setFullImportMode(DEFAULT_IMPORT_MODE);
      setIsFullImportModalOpen(true);
    } catch (error) {
      messageApi.error(`导入配置失败: ${error}`);
    } finally {
      setIsImportingConfig(false);
    }
  }, [messageApi]);

  const handleCancelFullImport = useCallback(() => {
    if (isApplyingFullImport) {
      return;
    }

    setIsFullImportModalOpen(false);
    setFullImportSelection(null);
    setFullImportMode(DEFAULT_IMPORT_MODE);
  }, [isApplyingFullImport]);

  const handleConfirmFullImport = useCallback(async () => {
    if (!fullImportSelection) {
      return;
    }

    setIsApplyingFullImport(true);

    try {
      const result = await applyFullConfigImport(fullImportSelection, {
        mode: fullImportMode,
      });

      showImportResult(result, `配置已导入: ${formatImportSummary(result)}`);
      setIsFullImportModalOpen(false);
      setFullImportSelection(null);
      setFullImportMode(DEFAULT_IMPORT_MODE);
    } catch (error) {
      messageApi.error(`导入配置失败: ${error}`);
    } finally {
      setIsApplyingFullImport(false);
    }
  }, [fullImportMode, fullImportSelection, messageApi, showImportResult]);

  const handleOpenModuleExport = useCallback(() => {
    setSelectedExportSections([]);
    setIsModuleExportModalOpen(true);
  }, []);

  const handleCancelModuleExport = useCallback(() => {
    if (isModuleExporting) {
      return;
    }

    setIsModuleExportModalOpen(false);
    setSelectedExportSections([]);
  }, [isModuleExporting]);

  const handleConfirmModuleExport = useCallback(async () => {
    if (selectedExportSections.length === 0) {
      messageApi.warning('请至少选择一个模块');
      return;
    }

    setIsModuleExporting(true);

    try {
      const snapshot = await buildConfigExportSnapshot(selectedExportSections);
      const savedPath = await saveFullConfigExport(snapshot);

      if (savedPath) {
        messageApi.success(`模块配置已导出到: ${savedPath}`);
        setIsModuleExportModalOpen(false);
        setSelectedExportSections([]);
      }
    } catch (error) {
      messageApi.error(`导出模块配置失败: ${error}`);
    } finally {
      setIsModuleExporting(false);
    }
  }, [messageApi, selectedExportSections]);

  const handleOpenModuleImport = useCallback(async () => {
    setIsPreparingModuleImport(true);

    try {
      const selection = await selectFullConfigImport();
      if (!selection) {
        return;
      }

      const includedSections = getIncludedConfigSections(selection.snapshot);
      setModuleImportSelection(selection);
      setSelectedImportSections(includedSections);
      setModuleImportMode(DEFAULT_IMPORT_MODE);
      setIsModuleImportModalOpen(true);
    } catch (error) {
      messageApi.error(`读取配置文件失败: ${error}`);
    } finally {
      setIsPreparingModuleImport(false);
    }
  }, [messageApi]);

  const handleCancelModuleImport = useCallback(() => {
    if (isApplyingModuleImport) {
      return;
    }

    setIsModuleImportModalOpen(false);
    setSelectedImportSections([]);
    setModuleImportSelection(null);
    setModuleImportMode(DEFAULT_IMPORT_MODE);
  }, [isApplyingModuleImport]);

  const handleConfirmModuleImport = useCallback(async () => {
    if (!moduleImportSelection) {
      return;
    }

    if (selectedImportSections.length === 0) {
      messageApi.warning('请至少选择一个模块');
      return;
    }

    setIsApplyingModuleImport(true);

    try {
      const result = await applyConfigImport(moduleImportSelection, {
        sections: selectedImportSections,
        mode: moduleImportMode,
      });

      showImportResult(result, `模块配置已导入: ${formatImportSummary(result)}`);
      setIsModuleImportModalOpen(false);
      setSelectedImportSections([]);
      setModuleImportSelection(null);
      setModuleImportMode(DEFAULT_IMPORT_MODE);
    } catch (error) {
      messageApi.error(`导入模块配置失败: ${error}`);
    } finally {
      setIsApplyingModuleImport(false);
    }
  }, [messageApi, moduleImportMode, moduleImportSelection, selectedImportSections, showImportResult]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {contextHolder}
      {modalContextHolder}

      <Card title="本地数据" size="small" bordered loading={!runtimePaths}>
        {runtimePaths ? (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="配置目录">
                <Text code copyable>{runtimePaths.data_dir}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="日志目录">
                <Text code copyable>{runtimePaths.log_dir}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="缓存目录">
                <Text code copyable>{runtimePaths.cache_dir}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="存储位置">
                {runtimePaths.using_fallback ? '当前用户 LocalAppData' : '上位机程序目录'}
              </Descriptions.Item>
            </Descriptions>
            <Space wrap style={{ marginTop: 12 }}>
              <Button icon={<FolderOpenOutlined />} onClick={() => void handleOpenRuntimeDirectory('data')}>
                打开配置目录
              </Button>
              <Button icon={<FolderOpenOutlined />} onClick={() => void handleOpenRuntimeDirectory('logs')}>
                打开日志目录
              </Button>
              <Button icon={<FolderOpenOutlined />} onClick={() => void handleOpenRuntimeDirectory('cache')}>
                打开缓存目录
              </Button>
              <Popconfirm
                title="清理下位机更新缓存"
                description="将删除已下载的下位机更新包和未完成的下载文件。"
                okText="清理"
                cancelText="取消"
                onConfirm={() => void handleClearLowerUpdateCache()}
              >
                <Button danger icon={<DeleteOutlined />} loading={isClearingCache}>
                  清理更新缓存
                </Button>
              </Popconfirm>
            </Space>
          </>
        ) : null}
      </Card>

      <Card title="配置导入 / 导出" size="small" bordered>
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          可以导出完整配置快照，也可以只导出单独模块的配置文件。导入时会在选中文件后提示选择“合并”或“覆盖”。
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          完整导出不会写入当前 manager 地址；完整导入和模块级导入都不会修改 manager 地址。
        </Paragraph>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Space wrap>
            <Button type="primary" ghost onClick={handleOpenModuleExport}>
              导出模块配置
            </Button>
            <Button onClick={() => void handleOpenModuleImport()} loading={isPreparingModuleImport}>
              导入模块配置
            </Button>
          </Space>
          <Space wrap>
            <Button type="primary" onClick={() => void handleExportConfig()} loading={isExportingConfig}>
              导出全部配置
            </Button>
            <Button onClick={() => void handleImportConfig()} loading={isImportingConfig}>
              导入全部配置
            </Button>
          </Space>
        </div>
      </Card>

      <Modal
        open={isFullImportModalOpen}
        title="选择导入方式"
        okText="开始导入"
        cancelText="取消"
        okButtonProps={{ disabled: !fullImportSelection }}
        confirmLoading={isApplyingFullImport}
        onCancel={handleCancelFullImport}
        onOk={() => void handleConfirmFullImport()}
      >
        {fullImportSelection ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary">
              文件: <Text code>{fullImportSelection.filePath}</Text>
            </Text>
            <Text type="secondary">
              文件包含模块: {formatSectionNames(fullImportSections)}
            </Text>
            <Text strong>导入方式</Text>
            <Radio.Group
              value={fullImportMode}
              onChange={(event) => setFullImportMode(event.target.value as ConfigImportMode)}
              style={{ width: '100%' }}
            >
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {IMPORT_MODE_OPTIONS.map((option) => {
                  const isSelected = option.key === fullImportMode;

                  return (
                    <label key={option.key} style={{ display: 'block', cursor: 'pointer' }}>
                      <div
                        style={{
                          padding: '10px 12px',
                          border: isSelected ? '1px solid #1677ff' : '1px solid rgba(255, 255, 255, 0.08)',
                          borderRadius: 8,
                          background: isSelected ? 'rgba(22, 119, 255, 0.08)' : 'transparent',
                        }}
                      >
                        <Radio value={option.key}>{option.label}</Radio>
                        <div style={{ marginTop: 6, marginLeft: 24 }}>
                          <Text type="secondary">{option.description}</Text>
                        </div>
                      </div>
                    </label>
                  );
                })}
              </Space>
            </Radio.Group>
            <Text type="secondary">
              完整导入不会修改 manager 地址。覆盖会清理文件未包含的连接、控制组和路由；合并会保留现有项，并在协议连接同名时自动重命名后导入。
            </Text>
          </Space>
        ) : null}
      </Modal>

      <ConfigSectionPickerModal
        open={isModuleExportModalOpen}
        title="选择要导出的模块"
        confirmText="开始导出"
        options={exportSectionOptions}
        selectedKeys={selectedExportSections}
        confirmLoading={isModuleExporting}
        extra={
          <Text type="secondary">
            当前会生成一个 `.mskcfg` 文件，文件中只包含所选模块的配置快照。
          </Text>
        }
        onChange={setSelectedExportSections}
        onCancel={handleCancelModuleExport}
        onConfirm={() => void handleConfirmModuleExport()}
      />

      <ConfigSectionPickerModal
        open={isModuleImportModalOpen}
        title="选择要导入的模块"
        confirmText="开始导入"
        options={importSectionOptions}
        selectedKeys={selectedImportSections}
        confirmLoading={isApplyingModuleImport}
        importMode={moduleImportMode}
        importModeOptions={IMPORT_MODE_OPTIONS}
        importModeTitle="导入方式"
        extra={
          moduleImportSelection ? (
            <Space direction="vertical" size={4}>
              <Text type="secondary">
                文件: <Text code>{moduleImportSelection.filePath}</Text>
              </Text>
              <Text type="secondary">
                可导入模块: {formatSectionNames(getIncludedConfigSections(moduleImportSelection.snapshot))}
              </Text>
              <Text type="secondary">
                导入只会作用于所选模块，不会修改 manager 地址和全局启动集。覆盖会清理所选模块里未包含在文件中的项；合并会保留现有项，并在协议连接同名时自动重命名后导入。
              </Text>
            </Space>
          ) : null
        }
        onImportModeChange={setModuleImportMode}
        onChange={setSelectedImportSections}
        onCancel={handleCancelModuleImport}
        onConfirm={() => void handleConfirmModuleImport()}
      />
    </div>
  );
};

export default Settings;
