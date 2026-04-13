import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Descriptions, message, Modal, Progress, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '../../adapters';
import type { AppUpdateInfo, AppUpdateStatus, AppUpdateStatusKind } from '../../adapters';
import {
  applyFullConfigImport,
  buildFullConfigExportSnapshot,
  saveFullConfigExport,
  selectFullConfigImport,
} from '../../utils/config-export';

const { Paragraph, Text } = Typography;

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
      return '下载安装中';
    case 'ready-to-restart':
      return '等待重启';
    case 'error':
      return '异常';
    default:
      return '未检查';
  }
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
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

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

      const result = await applyFullConfigImport(selection);
      const summaryParts = [
        `IEC104 ${result.summary.iec104Links}`,
        `ModbusRTU ${result.summary.modbusRtuLinks}`,
        `DLT645 ${result.summary.dlt645Links}`,
        `AGC ${result.summary.agcGroups}`,
        `DataBus ${result.summary.dataBusRoutes}`,
      ];

      messageApi.success(`全部配置已导入: ${summaryParts.join(' / ')}`);

      if (result.warnings.length > 0 || result.startedModules.length > 0) {
        Modal.info({
          title: '导入完成',
          width: 680,
          content: (
            <div style={{ marginTop: 12 }}>
              <Paragraph style={{ marginBottom: 8 }}>
                文件: <Text code>{result.filePath}</Text>
              </Paragraph>
              {result.startedModules.length > 0 && (
                <Paragraph style={{ marginBottom: 8 }}>
                  启动模块: {result.startedModules.join(', ')}
                </Paragraph>
              )}
              {result.warnings.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {result.warnings.map((warning) => (
                    <Text key={warning} type="warning">
                      {warning}
                    </Text>
                  ))}
                </div>
              )}
            </div>
          ),
        });
      }
    } catch (error) {
      messageApi.error(`导入全部配置失败: ${error}`);
    } finally {
      setIsImportingConfig(false);
    }
  }, [messageApi]);

  const downloadPercent =
    totalBytes && totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {contextHolder}

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

        {availableUpdate?.body && (
          <Paragraph
            style={{
              whiteSpace: 'pre-wrap',
              marginBottom: 12,
            }}
          >
            {availableUpdate.body}
          </Paragraph>
        )}

        {isInstallingUpdate && totalBytes !== null && (
          <Progress
            percent={downloadPercent}
            size="small"
            status="active"
            style={{ marginBottom: 12 }}
          />
        )}

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
          导出当前上位机掌握的全部配置快照，或从 `.mskcfg` 文件恢复 manager 地址、模块启动集、协议模块配置与
          DataBus 路由。
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          导入会按快照覆盖已声明的链路、点表、控制组和路由，但不会自动停止快照之外额外运行的模块。
        </Paragraph>
        <Space wrap>
          <Button onClick={() => void handleImportConfig()} loading={isImportingConfig}>
            导入全部配置
          </Button>
          <Button type="primary" onClick={() => void handleExportConfig()} loading={isExportingConfig}>
            导出全部配置
          </Button>
        </Space>
      </Card>
    </div>
  );
};

export default Settings;
