import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  message,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlayCircleOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../../adapters';
import type { ModuleInfo, ModuleRunningInfo } from '../../adapters';
import { invoke } from '@tauri-apps/api/core';
import { createModuleOpsRequestScope } from '../../utils/module-ops-request';
import { subscribeManagerRuntimeRefreshed } from '../../utils/manager-runtime-events';
import { validateManagerAddress } from '../../utils/network';
import { getStoredManagerAddress, saveManagerAddress } from '../../utils/app-settings';
import './index.css';
import RemoteAccessPanel from '../../components/remote/RemoteAccessPanel';
import DevicePlatformAccessCard from '../../components/remote/DevicePlatformAccessCard';

const { Text } = Typography;

const DEFAULT_MANAGER_ADDR = '127.0.0.1:17000';

type RefreshOptions = {
  address?: string;
  forceReconnect?: boolean;
  connecting?: boolean;
  direct?: boolean;
};

const ModuleOps: React.FC = () => {
  const [managerAddr, setManagerAddr] = useState(
    () => getStoredManagerAddress(DEFAULT_MANAGER_ADDR),
  );
  const initialManagerAddrRef = useRef(managerAddr);
  const requestEpoch = useRef(0);
  const mounted = useRef(false);
  const remoteModeRef = useRef(false);
  const connectionInitialized = useRef(false);
  const [requests] = useState(createModuleOpsRequestScope);
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [runningModules, setRunningModules] = useState<ModuleRunningInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [remoteMode, setRemoteMode] = useState(false);
  const [platformConnectionKey, setPlatformConnectionKey] = useState(0);
  const [platformConfigReady, setPlatformConfigReady] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const managerAddrValidation = validateManagerAddress(managerAddr);
  const managerAddrError = managerAddrValidation.ok ? null : managerAddrValidation.error;

  const isRunning = useCallback(
    (moduleName: string) => runningModules.some((item) => item.module_name === moduleName),
    [runningModules],
  );

  const getRunningInfo = useCallback(
    (moduleName: string) => runningModules.find((item) => item.module_name === moduleName),
    [runningModules],
  );

  const normalizeManagerAddr = useCallback((addr: string) => {
    const validation = validateManagerAddress(addr);

    if (!validation.ok) {
      throw new Error(validation.error);
    }

    return validation.normalized;
  }, []);

  const abandonRequest = useCallback(() => {
    requestEpoch.current += 1;
    requests.cancel();
    setLoading(false);
    setConnecting(false);
    setConnected(false);
    setConnectionError(null);
    setPlatformConfigReady(false);
    console.info('[模块运维] 已结束旧连接的界面等待');
  }, [requests]);

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    if (!mounted.current) return;
    const epoch = ++requestEpoch.current;
    const direct = options.direct ?? !remoteModeRef.current;
    setLoading(true);
    setConnecting(Boolean(options.connecting));
    setConnected(false);
    setConnectionError(null);
    setPlatformConfigReady(false);
    console.info('[模块运维] 开始连接并读取模块列表', { direct });
    try {
      const result = await requests.run(async signal => {
        if (options.address !== undefined) {
          const address = normalizeManagerAddr(options.address);
          await saveManagerAddress(address);
          signal.throwIfAborted();
          await api.setManagerAddr(address, options.forceReconnect ?? false);
          signal.throwIfAborted();
        }
        const runningInfo = await api.getRunningModuleInfo();
        signal.throwIfAborted();
        const moduleInfo = await api.getModuleInfo();
        signal.throwIfAborted();
        return { runningInfo, moduleInfo };
      }, direct ? 5000 : undefined);
      if (!result.current || epoch !== requestEpoch.current) return;
      setModules(result.value.moduleInfo);
      setRunningModules(result.value.runningInfo);
      setHasSnapshot(true);
      setConnected(true);
      setPlatformConfigReady(true);
      setPlatformConnectionKey(value => value + 1);
      console.info('[模块运维] 连接与模块列表读取完成');
      if (options.connecting) messageApi.success('ModuleManager 已连接');
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      const detail = `无法连接或读取模块列表：${error}`;
      setConnectionError(detail);
      console.warn('[模块运维] 连接或读取失败', { error: String(error) });
    } finally {
      if (epoch === requestEpoch.current) {
        setLoading(false);
        setConnecting(false);
      }
    }
  }, [messageApi, normalizeManagerAddr, requests]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const epoch = requestEpoch.current;
    const enter = async () => {
      try {
        // 先识别已存在的平台通道，避免把现场短超时应用到远程连接。
        const remote = '__TAURI_INTERNALS__' in window
          ? (await invoke<{ remote: boolean }>('remote_connection_status')).remote : false;
        if (disposed || epoch !== requestEpoch.current) return;
        connectionInitialized.current = true;
        remoteModeRef.current = remote;
        setRemoteMode(remote);
        await refresh({ address: initialManagerAddrRef.current, direct: !remote });
      } catch (error) {
        if (!disposed && epoch === requestEpoch.current) setConnectionError(`读取连接状态失败：${error}`);
      }
    };
    void enter();
    return () => {
      disposed = true;
      mounted.current = false;
      requestEpoch.current += 1;
      requests.cancel();
    };
  }, [refresh, requests]);

  useEffect(() => subscribeManagerRuntimeRefreshed(() => {
    void refresh();
  }), [refresh]);

  const handleModeChange = useCallback((remote: boolean) => {
    if (connectionInitialized.current && remoteModeRef.current !== remote) abandonRequest();
    remoteModeRef.current = remote;
    setRemoteMode(remote);
  }, [abandonRequest]);

  const handleConnect = useCallback(async () => {
    const validation = validateManagerAddress(managerAddr);
    if (!validation.ok) return;
    setManagerAddr(validation.normalized);
    await refresh({ address: validation.normalized, forceReconnect: true, connecting: true, direct: true });
  }, [managerAddr, refresh]);

  const handleStart = useCallback(
    async (moduleInfo: ModuleInfo) => {
      if (!connected || loading) return;
      const epoch = requestEpoch.current;
      const isCurrent = () => mounted.current && epoch === requestEpoch.current;
      try {
        await api.startModule(moduleInfo);
        if (!isCurrent()) return;
        messageApi.success(`模块 ${moduleInfo.module_name} 启动请求已发送`);

        setTimeout(() => {
          if (isCurrent()) void refresh();
        }, 1000);
      } catch (error) {
        if (isCurrent()) messageApi.error(`启动失败: ${error}`);
      }
    },
    [connected, loading, messageApi, refresh],
  );

  const handleStop = useCallback(
    async (moduleInfo: ModuleInfo) => {
      if (!connected || loading) return;
      const epoch = requestEpoch.current;
      const isCurrent = () => mounted.current && epoch === requestEpoch.current;
      try {
        await api.stopModule(moduleInfo);
        if (!isCurrent()) return;
        messageApi.success(`模块 ${moduleInfo.module_name} 停止请求已发送`);

        setTimeout(() => {
          if (isCurrent()) void refresh();
        }, 1000);
      } catch (error) {
        if (isCurrent()) messageApi.error(`停止失败: ${error}`);
      }
    },
    [connected, loading, messageApi, refresh],
  );

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
        dependencies.length > 0 ? (
          dependencies.map((dependency) => (
            <Tag key={dependency.module_name} color="blue">
              {dependency.module_name} {dependency.version_range}
            </Tag>
          ))
        ) : (
          <Text type="secondary">无</Text>
        ),
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
                disabled={!connected || loading}
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
                description="依赖该模块的上游模块也会被级联停止。"
                onConfirm={() => handleStop(record)}
              >
                <Button danger size="small" disabled={!connected || loading} icon={<StopOutlined />}>
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
    <div className="module-ops-page">
      {contextHolder}
      <RemoteAccessPanel directAddress={managerAddr} onModeChange={handleModeChange}
        onConnectionIntent={abandonRequest} onConnected={async () => { await refresh(); }} actions={
        <Button icon={<ReloadOutlined />} disabled={!remoteMode && Boolean(managerAddrError)}
          onClick={() => void refresh({ address: remoteMode ? undefined : managerAddr })} loading={loading}>刷新模块</Button>
      } directControls={<>
          <Text className="module-ops-address-label">ModuleManager</Text>
          <div className="module-ops-address-input">
            <Input
              aria-label="ModuleManager 地址"
              value={managerAddr}
              disabled={remoteMode}
              onChange={(event) => { abandonRequest(); setManagerAddr(event.target.value); }}
              status={managerAddrError ? 'error' : undefined}
              placeholder="host:port"
            />
            {managerAddrError && (
              <Text type="danger" style={{ display: 'block', marginTop: 4 }}>
                {managerAddrError}
              </Text>
            )}
          </div>
          <Button type="primary" loading={connecting} onClick={() => void handleConnect()} disabled={remoteMode || loading || Boolean(managerAddrError)}>
            {connecting ? '正在连接…' : '连接'}
          </Button>
      </>} />

      {!remoteMode && <DevicePlatformAccessCard connectionKey={platformConnectionKey} ready={platformConfigReady} />}

      {connectionError && <Alert type="error" showIcon title={connectionError} />}
      <Card title={<Space>模块列表{hasSnapshot && !connected && <Tag color="warning">上次读取，当前未连接</Tag>}</Space>} size="small" bordered className="module-ops-list-card">
        <div className="module-ops-table-scroll">
          <Table
            rowKey="module_name"
            columns={columns}
            dataSource={modules}
            pagination={false}
            size="small"
            scroll={{ x: 1180 }}
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
        </div>
      </Card>
    </div>
  );
};

export default ModuleOps;
