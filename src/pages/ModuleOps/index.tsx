import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
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
import { validateManagerAddress } from '../../utils/network';
import './index.css';

const { Text } = Typography;

const MANAGER_ADDR_KEY = 'mskdsp_manager_addr';
const DEFAULT_MANAGER_ADDR = '127.0.0.1:17000';

type RefreshOptions = {
  suppressError?: boolean;
};

const ModuleOps: React.FC = () => {
  const [managerAddr, setManagerAddr] = useState(
    () => localStorage.getItem(MANAGER_ADDR_KEY) || DEFAULT_MANAGER_ADDR,
  );
  const initialManagerAddrRef = useRef(managerAddr);
  const didAutoRefreshRef = useRef(false);
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [runningModules, setRunningModules] = useState<ModuleRunningInfo[]>([]);
  const [loading, setLoading] = useState(false);
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

  const refresh = useCallback(
    async ({ suppressError = false }: RefreshOptions = {}) => {
      setLoading(true);

      try {
        const [moduleInfo, runningInfo] = await Promise.all([
          api.getModuleInfo(),
          api.getRunningModuleInfo(),
        ]);

        setModules(moduleInfo);
        setRunningModules(runningInfo);
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

  useEffect(() => {
    if (didAutoRefreshRef.current) {
      return;
    }

    didAutoRefreshRef.current = true;

    const connectAndRefreshOnEnter = async () => {
      try {
        const normalizedAddr = normalizeManagerAddr(initialManagerAddrRef.current);

        if (normalizedAddr !== initialManagerAddrRef.current) {
          initialManagerAddrRef.current = normalizedAddr;
          setManagerAddr(normalizedAddr);
          localStorage.setItem(MANAGER_ADDR_KEY, normalizedAddr);
        }

        await api.setManagerAddr(normalizedAddr);
        await refresh({ suppressError: true });
      } catch (error) {
        messageApi.error(`连接失败: ${error}`);
      }
    };

    void connectAndRefreshOnEnter();
  }, [messageApi, normalizeManagerAddr, refresh]);

  const handleConnect = useCallback(async () => {
    try {
      const normalizedAddr = normalizeManagerAddr(managerAddr);

      await api.setManagerAddr(normalizedAddr);

      if (normalizedAddr !== managerAddr) {
        setManagerAddr(normalizedAddr);
      }

      localStorage.setItem(MANAGER_ADDR_KEY, normalizedAddr);
      await refresh({ suppressError: true });
      messageApi.success(`已连接到 ${normalizedAddr}`);
    } catch (error) {
      messageApi.error(`连接失败: ${error}`);
    }
  }, [managerAddr, messageApi, normalizeManagerAddr, refresh]);

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
    <div className="module-ops-page">
      {contextHolder}

      <Card size="small" bordered className="module-ops-toolbar-card">
        <Space align="start">
          <Text style={{ lineHeight: '32px' }}>ModuleManager 地址:</Text>
          <div style={{ minWidth: 240 }}>
            <Input
              value={managerAddr}
              onChange={(event) => setManagerAddr(event.target.value)}
              style={{ width: 240 }}
              status={managerAddrError ? 'error' : undefined}
              placeholder="host:port"
            />
            {managerAddrError && (
              <Text type="danger" style={{ display: 'block', marginTop: 4 }}>
                {managerAddrError}
              </Text>
            )}
          </div>
          <Button type="primary" onClick={() => void handleConnect()} disabled={Boolean(managerAddrError)}>
            连接
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
            刷新
          </Button>
        </Space>
      </Card>

      <Card title="模块列表" size="small" bordered className="module-ops-list-card">
        <div className="module-ops-table-scroll">
          <Table
            rowKey="module_name"
            columns={columns}
            dataSource={modules}
            loading={loading}
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
