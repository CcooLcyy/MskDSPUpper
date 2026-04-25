import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Descriptions, message, Modal, Progress, Radio, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '../../adapters';
import type {
  AppUpdateInfo,
  AppUpdateStatus,
  AppUpdateStatusKind,
  ConfigExportSectionId,
} from '../../adapters';
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

function formatReleaseDate(value?: string) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function getUpdateTagColor(kind: AppUpdateStatusKind) {
  switch (kind) {
    case 'checking':
      return 'processing';
    case 'up-to-date':
      return 'success';
    case 'available':
      return 'gold';
    case 'installing':
      return 'blue';
    case 'ready-to-restart':
      return 'cyan';
    case 'error':
      return 'error';
    default:
      return 'default';
  }
}

function getUpdateTagLabel(kind: AppUpdateStatusKind) {
  switch (kind) {
    case 'checking':
      return '检查中';
    case 'up-to-date':
      return '已是最新';
    case 'available':
      return '发现更新';
    case 'installing':
      return '安装中';
    case 'ready-to-restart':
      return '待重启';
    case 'error':
      return '异常';
    default:
      return '未检查';
  }
}

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

const Settings: React.FC = () => {
  const [appVersion, setAppVersion] = useState('-');
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({
    kind: 'idle',
    message: '尚未检查客户端更新',
  });
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
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
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
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

  const loadAppVersion = useCallback(async () => {
    try {
      const version = await api.getAppVersion();
      setAppVersion(version);
    } catch (error) {
      setAppVersion('-');
      console.warn('Failed to read app version:', error);
    }
  }, []);

  useEffect(() => {
    void loadAppVersion();
  }, [loadAppVersion]);

  useEffect(() => {
    return () => {
      void api.disposePendingAppUpdate();
    };
  }, []);

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

  const handleCheckUpdate = useCallback(async () => {
    setIsCheckingUpdate(true);
    setDownloadedBytes(0);
    setTotalBytes(null);
    setUpdateStatus({ kind: 'checking', message: '正在检查客户端更新...' });

    try {
      const version = await api.getAppVersion();
      setAppVersion(version);

      const update = await api.checkAppUpdate();
      setAvailableUpdate(update);

      if (!update) {
        setUpdateStatus({ kind: 'up-to-date', message: '当前客户端已经是最新版本' });
        messageApi.success('当前客户端已经是最新版本');
        return;
      }

      setUpdateStatus({
        kind: 'available',
        message: `发现新版本 ${update.version}，可以下载安装`,
      });
      messageApi.success(`发现客户端新版本 ${update.version}`);
    } catch (error) {
      setAvailableUpdate(null);
      setUpdateStatus({ kind: 'error', message: `检查更新失败: ${error}` });
      messageApi.error(`检查更新失败: ${error}`);
    } finally {
      setIsCheckingUpdate(false);
    }
  }, [messageApi]);

  const handleInstallUpdate = useCallback(async () => {
    setIsInstallingUpdate(true);
    setDownloadedBytes(0);
    setTotalBytes(null);
    setUpdateStatus({ kind: 'installing', message: '正在下载并安装客户端更新...' });

    try {
      const update = await api.downloadAndInstallAppUpdate((event) => {
        switch (event.event) {
          case 'Started':
            setTotalBytes(event.data.contentLength ?? null);
            setDownloadedBytes(0);
            setUpdateStatus({ kind: 'installing', message: '已开始下载更新包' });
            break;
          case 'Progress':
            setDownloadedBytes((previous) => previous + event.data.chunkLength);
            break;
          case 'Finished':
            setUpdateStatus({
              kind: 'installing',
              message: '更新包下载完成，正在安装',
            });
            break;
        }
      });

      setAvailableUpdate(update);
      setUpdateStatus({
        kind: 'ready-to-restart',
        message: `客户端 ${update.version} 已安装完成，如未自动重启，请手动重启应用`,
      });
      messageApi.success(`客户端 ${update.version} 已下载安装完成`);
    } catch (error) {
      setUpdateStatus({ kind: 'error', message: `安装更新失败: ${error}` });
      messageApi.error(`安装更新失败: ${error}`);
    } finally {
      setIsInstallingUpdate(false);
    }
  }, [messageApi]);

  const handleRelaunch = useCallback(async () => {
    try {
      await api.relaunchApp();
    } catch (error) {
      setUpdateStatus({ kind: 'error', message: `重启客户端失败: ${error}` });
      messageApi.error(`重启客户端失败: ${error}`);
    }
  }, [messageApi]);

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
        applyGlobals: false,
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

  const downloadPercent =
    totalBytes && totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {contextHolder}
      {modalContextHolder}

      <Card title="应用更新" size="small" bordered>
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="客户端版本">{appVersion}</Descriptions.Item>
          <Descriptions.Item label="更新状态">
            <Tag color={getUpdateTagColor(updateStatus.kind)}>{getUpdateTagLabel(updateStatus.kind)}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="可用版本">{availableUpdate?.version || '-'}</Descriptions.Item>
          <Descriptions.Item label="发布时间">{formatReleaseDate(availableUpdate?.date)}</Descriptions.Item>
        </Descriptions>

        <Paragraph
          type={updateStatus.kind === 'error' ? 'danger' : 'secondary'}
          style={{ marginTop: 12, marginBottom: 12 }}
        >
          {updateStatus.message}
        </Paragraph>

        {availableUpdate?.body ? (
          <Paragraph
            style={{
              whiteSpace: 'pre-wrap',
              marginBottom: 12,
            }}
          >
            {availableUpdate.body}
          </Paragraph>
        ) : null}

        {isInstallingUpdate && totalBytes !== null ? (
          <Progress percent={downloadPercent} size="small" status="active" style={{ marginBottom: 12 }} />
        ) : null}

        <Space wrap>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void handleCheckUpdate()}
            loading={isCheckingUpdate}
          >
            检查客户端更新
          </Button>
          <Button
            type="primary"
            onClick={() => void handleInstallUpdate()}
            disabled={!availableUpdate}
            loading={isInstallingUpdate}
          >
            下载安装
          </Button>
          <Button onClick={() => void handleRelaunch()} disabled={updateStatus.kind !== 'ready-to-restart'}>
            重启客户端
          </Button>
        </Space>
      </Card>

      <Card title="配置导入 / 导出" size="small" bordered>
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          可以导出完整配置快照，也可以只导出单独模块的配置文件。导入时会在选中文件后提示选择“合并”或“覆盖”。
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          模块级导入只会影响选中的模块，不会修改 manager 地址，也不会改动全局模块启动集。
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
              完整导入会继续应用文件中的 manager 地址。覆盖会清理文件未包含的连接、控制组和路由；合并会保留现有项，并在协议连接同名时自动重命名后导入。
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
