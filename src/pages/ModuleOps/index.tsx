import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  Descriptions,
  Input,
  message,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlayCircleOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../../adapters';
import type {
  AppUpdateInfo,
  AppUpdateStatus,
  AppUpdateStatusKind,
  ModuleInfo,
  ModuleRunningInfo,
} from '../../adapters';

const { Paragraph, Text } = Typography;

const MANAGER_ADDR_KEY = 'mskdsp_manager_addr';
const DEFAULT_MANAGER_ADDR = '127.0.0.1:7000';

type RefreshOptions = {
  suppressError?: boolean;
};

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

const ModuleOps: React.FC = () => {
  const [managerAddr, setManagerAddr] = useState(
    () => localStorage.getItem(MANAGER_ADDR_KEY) || DEFAULT_MANAGER_ADDR,
  );
  const initialManagerAddrRef = useRef(managerAddr);
  const didAutoRefreshRef = useRef(false);
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [runningModules, setRunningModules] = useState<ModuleRunningInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [appVersion, setAppVersion] = useState('-');
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({
    kind: 'idle',
    message: '尚未检查客户端更新',
  });
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const isRunning = useCallback(
    (moduleName: string) => runningModules.some((item) => item.module_name === moduleName),
    [runningModules],
  );

  const getRunningInfo = useCallback(
    (moduleName: string) => runningModules.find((item) => item.module_name === moduleName),
    [runningModules],
  );

  const refresh = useCallback(
    async ({ suppressError = false }: RefreshOptions = {}) => {
      setLoading(true);
      try {
        const [mods, running] = await Promise.all([api.getModuleInfo(), api.getRunningModuleInfo()]);
        setModules(mods);
        setRunningModules(running);
      } catch (error) {
        if (!suppressError) {
          messageApi.error(`刷新失败: ${error}`);
        }
        throw error;
      } finally {
        setLoading(false);
      }
    },
    [messageApi],
  );

  const loadAppVersion = useCallback(async () => {
    try {
      const version = await api.getAppVersion();
      setAppVersion(version);
    } catch (error) {
      setAppVersion('-');
      setUpdateStatus((prev) =>
        prev.kind === 'idle'
          ? { kind: 'error', message: `读取客户端版本失败: ${error}` }
          : prev,
      );
    }
  }, []);

  useEffect(() => {
    void loadAppVersion();
  }, [loadAppVersion]);

  useEffect(() => {
    if (didAutoRefreshRef.current) {
      return;
    }

    didAutoRefreshRef.current = true;

    const connectAndRefreshOnEnter = async () => {
      try {
        await api.setManagerAddr(initialManagerAddrRef.current);
        await refresh({ suppressError: true });
      } catch (error) {
        messageApi.error(`连接失败: ${error}`);
      }
    };

    void connectAndRefreshOnEnter();
  }, [messageApi, refresh]);

  useEffect(() => () => {
    void api.disposePendingAppUpdate();
  }, []);

  const handleConnect = useCallback(async () => {
    try {
      await api.setManagerAddr(managerAddr);
      localStorage.setItem(MANAGER_ADDR_KEY, managerAddr);
      await refresh({ suppressError: true });
      messageApi.success(`已连接到 ${managerAddr}`);
    } catch (error) {
      messageApi.error(`连接失败: ${error}`);
    }
  }, [managerAddr, messageApi, refresh]);

  const handleStart = useCallback(
    async (moduleInfo: ModuleInfo) => {
      try {
        await api.startModule(moduleInfo);
        messageApi.success(`模块 ${moduleInfo.module_name} 启动请求已发送`);
        setTimeout(() => {
          void refresh();
        }, 1000);
      } catch (error) {
        messageApi.error(`启动失败: ${error}`);
      }
    },
    [messageApi, refresh],
  );

  const handleStop = useCallback(
    async (moduleInfo: ModuleInfo) => {
      try {
        await api.stopModule(moduleInfo);
        messageApi.success(`模块 ${moduleInfo.module_name} 停止请求已发送`);
        setTimeout(() => {
          void refresh();
        }, 1000);
      } catch (error) {
        messageApi.error(`停止失败: ${error}`);
      }
    },
    [messageApi, refresh],
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
        message: `发现新版本 ${update.version}，可下载安装`,
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
            setDownloadedBytes((prev) => prev + event.data.chunkLength);
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

  const downloadPercent =
    totalBytes && totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;

  const columns: ColumnsType<ModuleInfo> = [
    {
      title: '模块名',
      dataIndex: 'module_name',
      key: 'module_name',
      width: 160,
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: '模块版本',
      dataIndex: 'version',
      key: 'version',
      width: 120,
      render: (version: ModuleInfo['version']) => version?.version || '-',
    },
    {
      title: '库名',
      dataIndex: 'lib_name',
      key: 'lib_name',
      width: 160,
    },
    {
      title: '依赖',
      dataIndex: 'dependencies',
      key: 'dependencies',
      width: 220,
      render: (dependencies: ModuleInfo['dependencies']) =>
        dependencies.length > 0
          ? dependencies.map((dependency) => (
              <Tag key={dependency.module_name} color="blue">
                {dependency.module_name} {dependency.version_range}
              </Tag>
            ))
          : <Text type="secondary">无</Text>,
    },
    {
      title: '状态',
      key: 'status',
      width: 120,
      render: (_: unknown, record: ModuleInfo) => {
        if (record.manifest_error) {
          return <Tag color="error">不可用</Tag>;
        }

        return isRunning(record.module_name) ? (
          <Tag color="success">运行中</Tag>
        ) : (
          <Tag color="default">已停止</Tag>
        );
      },
    },
    {
      title: 'gRPC 地址',
      key: 'grpc_addr',
      width: 220,
      render: (_: unknown, record: ModuleInfo) => {
        const info = getRunningInfo(record.module_name);

        return info ? (
          <Text code style={{ fontSize: 12 }}>
            {info.outer_grpc_server}
          </Text>
        ) : (
          <Text type="secondary">-</Text>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_: unknown, record: ModuleInfo) => {
        if (record.manifest_error) {
          return <Text type="secondary">manifest 错误</Text>;
        }

        const running = isRunning(record.module_name);

        return (
          <Space>
            {!running && (
              <Button
                type="primary"
                size="small"
                icon={<PlayCircleOutlined />}
                onClick={() => void handleStart(record)}
              >
                启动
              </Button>
            )}
            {running && (
              <Popconfirm
                title="确认停止该模块？"
                description="依赖该模块的上游模块也会被级联停止"
                onConfirm={() => handleStop(record)}
              >
                <Button danger size="small" icon={<StopOutlined />}>
                  停止
                </Button>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      {contextHolder}

      <Card size="small" bordered style={{ marginBottom: 16 }}>
        <Space>
          <Text>ModuleManager 地址:</Text>
          <Input
            value={managerAddr}
            onChange={(event) => setManagerAddr(event.target.value)}
            style={{ width: 240 }}
            placeholder="host:port"
          />
          <Button type="primary" onClick={() => void handleConnect()}>
            连接
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
            刷新
          </Button>
        </Space>
      </Card>

      <Card title="应用更新" size="small" bordered style={{ marginBottom: 16 }}>
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="客户端版本">{appVersion}</Descriptions.Item>
          <Descriptions.Item label="更新状态">
            <Tag color={getUpdateTagColor(updateStatus.kind)}>{getUpdateTagLabel(updateStatus.kind)}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="可用版本">{availableUpdate?.version || '-'}</Descriptions.Item>
          <Descriptions.Item label="发布时间">{formatReleaseDate(availableUpdate?.date)}</Descriptions.Item>
        </Descriptions>

        <Paragraph type={updateStatus.kind === 'error' ? 'danger' : 'secondary'} style={{ marginTop: 12, marginBottom: 12 }}>
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
            下载并安装
          </Button>
          <Button
            onClick={() => void handleRelaunch()}
            disabled={updateStatus.kind !== 'ready-to-restart'}
          >
            重启客户端
          </Button>
        </Space>
      </Card>

      <Card title="模块列表" size="small" bordered>
        <Table
          rowKey="module_name"
          columns={columns}
          dataSource={modules}
          loading={loading}
          pagination={false}
          size="small"
          expandable={{
            expandedRowRender: (record) => {
              const info = getRunningInfo(record.module_name);

              if (!info) {
                return <Text type="secondary">模块未运行</Text>;
              }

              return (
                <Descriptions size="small" column={2}>
                  <Descriptions.Item label="内部 gRPC (unix socket)">
                    {info.inner_grpc_server || '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="外部 gRPC (TCP)">
                    {info.outer_grpc_server || '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="模块版本">
                    {info.version?.version || '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="库名">{info.lib_name}</Descriptions.Item>
                </Descriptions>
              );
            },
          }}
        />
      </Card>
    </div>
  );
};

export default ModuleOps;
