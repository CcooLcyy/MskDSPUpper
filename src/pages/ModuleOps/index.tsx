import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  Space,
  Table,
  Tag,
  Typography,
  Input,
  message,
  Popconfirm,
  Descriptions,
} from 'antd';
import {
  ReloadOutlined,
  PlayCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../../adapters';
import type { ModuleInfo, ModuleRunningInfo } from '../../adapters';

const { Text } = Typography;

const MANAGER_ADDR_KEY = 'mskdsp_manager_addr';
const DEFAULT_MANAGER_ADDR = '127.0.0.1:7000';

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

  // 判断模块是否正在运行
  const isRunning = useCallback(
    (moduleName: string) => runningModules.some((r) => r.module_name === moduleName),
    [runningModules],
  );

  // 获取运行信息
  const getRunningInfo = useCallback(
    (moduleName: string) => runningModules.find((r) => r.module_name === moduleName),
    [runningModules],
  );

  // 刷新数据
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [mods, running] = await Promise.all([
        api.getModuleInfo(),
        api.getRunningModuleInfo(),
      ]);
      setModules(mods);
      setRunningModules(running);
    } catch (e) {
      messageApi.error(`刷新失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    if (didAutoRefreshRef.current) {
      return;
    }
    didAutoRefreshRef.current = true;

    const connectAndRefreshOnEnter = async () => {
      try {
        await api.setManagerAddr(initialManagerAddrRef.current);
        await refresh();
      } catch (e) {
        messageApi.error(`杩炴帴澶辫触: ${e}`);
      }
    };

    void connectAndRefreshOnEnter();
  }, [messageApi, refresh]);

  // 连接
  const handleConnect = useCallback(async () => {
    try {
      await api.setManagerAddr(managerAddr);
      localStorage.setItem(MANAGER_ADDR_KEY, managerAddr);
      messageApi.success(`已连接到 ${managerAddr}`);
      await refresh();
    } catch (e) {
      messageApi.error(`连接失败: ${e}`);
    }
  }, [managerAddr, messageApi, refresh]);

  // 启动模块
  const handleStart = useCallback(
    async (mod: ModuleInfo) => {
      try {
        await api.startModule(mod);
        messageApi.success(`模块 ${mod.module_name} 启动请求已发送`);
        // 延迟刷新，等模块启动
        setTimeout(refresh, 1000);
      } catch (e) {
        messageApi.error(`启动失败: ${e}`);
      }
    },
    [messageApi, refresh],
  );

  // 停止模块
  const handleStop = useCallback(
    async (mod: ModuleInfo) => {
      try {
        await api.stopModule(mod);
        messageApi.success(`模块 ${mod.module_name} 停止请求已发送`);
        setTimeout(refresh, 1000);
      } catch (e) {
        messageApi.error(`停止失败: ${e}`);
      }
    },
    [messageApi, refresh],
  );

  // 表格列定义
  const columns: ColumnsType<ModuleInfo> = [
    {
      title: '模块名',
      dataIndex: 'module_name',
      key: 'module_name',
      width: 160,
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 100,
      render: (v: ModuleInfo['version']) => v?.version || '-',
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
      width: 200,
      render: (deps: ModuleInfo['dependencies']) =>
        deps.length > 0
          ? deps.map((d) => (
              <Tag key={d.module_name} color="blue">
                {d.module_name} {d.version_range}
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
      width: 180,
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
      width: 160,
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
                onClick={() => handleStart(record)}
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
      {/* 连接配置 */}
      <Card size="small" bordered style={{ marginBottom: 16 }}>
        <Space>
          <Text>ModuleManager 地址：</Text>
          <Input
            value={managerAddr}
            onChange={(e) => setManagerAddr(e.target.value)}
            style={{ width: 240 }}
            placeholder="host:port"
          />
          <Button type="primary" onClick={handleConnect}>
            连接
          </Button>
          <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
            刷新
          </Button>
        </Space>
      </Card>

      {/* 模块列表 */}
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
              if (!info) return <Text type="secondary">模块未运行</Text>;
              return (
                <Descriptions size="small" column={2}>
                  <Descriptions.Item label="内部 gRPC (unix socket)">
                    {info.inner_grpc_server || '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="外部 gRPC (TCP)">
                    {info.outer_grpc_server || '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="版本">
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
