import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Col, Row, Statistic, Typography, Tag, List, Space, message } from 'antd';
import {
  AppstoreOutlined,
  PlayCircleOutlined,
  ApiOutlined,
  ControlOutlined,
  NodeIndexOutlined,
  AlertOutlined,
} from '@ant-design/icons';
import { api } from '../../adapters';
import type { ModuleInfo, ModuleRunningInfo } from '../../adapters';

const { Text } = Typography;

const MANAGER_ADDR_KEY = 'mskdsp_manager_addr';
const DEFAULT_MANAGER_ADDR = '127.0.0.1:17000';

const CORE_MODULES = ['ModuleManager', 'DataCenter', 'IEC104', 'ModbusRTU', 'DLT645', 'AGC'] as const;

type SummaryCard = {
  title: string;
  value: number | string;
  icon: React.ReactNode;
  color?: string;
};

type ModuleStatusItem = {
  name: string;
  status: string;
  color: string;
};

type DashboardData = {
  modules: ModuleInfo[];
  runningModules: ModuleRunningInfo[];
  protocolLinkCount: number;
  agcGroupCount: number;
  routeCount: number;
};

const Overview: React.FC = () => {
  const [dashboardData, setDashboardData] = useState<DashboardData>({
    modules: [],
    runningModules: [],
    protocolLinkCount: 0,
    agcGroupCount: 0,
    routeCount: 0,
  });
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const managerAddr = localStorage.getItem(MANAGER_ADDR_KEY) || DEFAULT_MANAGER_ADDR;
      await api.setManagerAddr(managerAddr);

      const [
        modulesResult,
        runningModulesResult,
        iec104LinksResult,
        modbusLinksResult,
        dlt645LinksResult,
        agcGroupsResult,
        routesResult,
      ] = await Promise.allSettled([
        api.getModuleInfo(),
        api.getRunningModuleInfo(),
        api.iec104ListLinks(),
        api.modbusRtuListLinks(),
        api.dlt645ListLinks(),
        api.agcListGroups(),
        api.dcListRoutes(0, '', 0, ''),
      ]);

      const modules = modulesResult.status === 'fulfilled' ? modulesResult.value : [];
      const runningModules = runningModulesResult.status === 'fulfilled' ? runningModulesResult.value : [];
      const protocolLinkCount =
        (iec104LinksResult.status === 'fulfilled' ? iec104LinksResult.value.length : 0) +
        (modbusLinksResult.status === 'fulfilled' ? modbusLinksResult.value.length : 0) +
        (dlt645LinksResult.status === 'fulfilled' ? dlt645LinksResult.value.length : 0);
      const agcGroupCount = agcGroupsResult.status === 'fulfilled' ? agcGroupsResult.value.length : 0;
      const routeCount = routesResult.status === 'fulfilled' ? routesResult.value.length : 0;

      setDashboardData({
        modules,
        runningModules,
        protocolLinkCount,
        agcGroupCount,
        routeCount,
      });

      const failedSections = [
        modulesResult.status === 'rejected' ? '模块清单' : null,
        runningModulesResult.status === 'rejected' ? '运行状态' : null,
        iec104LinksResult.status === 'rejected' ? 'IEC104 链路' : null,
        modbusLinksResult.status === 'rejected' ? 'ModbusRTU 链路' : null,
        dlt645LinksResult.status === 'rejected' ? 'DLT645 链路' : null,
        agcGroupsResult.status === 'rejected' ? 'AGC 控制组' : null,
        routesResult.status === 'rejected' ? '数据路由' : null,
      ].filter((item): item is string => item !== null);

      if (failedSections.length > 0) {
        messageApi.warning(`部分首页数据加载失败: ${failedSections.join('、')}`);
      }
    } catch (e) {
      messageApi.error(`首页数据加载失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const summaryCards = useMemo<SummaryCard[]>(() => [
    {
      title: '发现模块',
      value: dashboardData.modules.length,
      icon: <AppstoreOutlined />,
    },
    {
      title: '运行模块',
      value: dashboardData.runningModules.length,
      icon: <PlayCircleOutlined />,
      color: '#4caf50',
    },
    {
      title: '协议连接',
      value: dashboardData.protocolLinkCount,
      icon: <ApiOutlined />,
    },
    {
      title: 'AGC 控制组',
      value: dashboardData.agcGroupCount,
      icon: <ControlOutlined />,
    },
    {
      title: '数据路由',
      value: dashboardData.routeCount,
      icon: <NodeIndexOutlined />,
    },
    {
      title: '活动告警',
      value: '-',
      icon: <AlertOutlined />,
      color: '#888',
    },
  ], [dashboardData]);

  const moduleStatus = useMemo<ModuleStatusItem[]>(() => {
    const availableMap = new Map(dashboardData.modules.map((item) => [item.module_name, item]));
    const runningSet = new Set(dashboardData.runningModules.map((item) => item.module_name));

    return CORE_MODULES.map((name) => {
      const moduleInfo = availableMap.get(name);
      if (runningSet.has(name)) {
        return { name, status: '运行中', color: 'green' };
      }
      if (moduleInfo?.manifest_error) {
        return { name, status: '不可用', color: 'red' };
      }
      if (moduleInfo) {
        return { name, status: '已停止', color: 'default' };
      }
      return { name, status: '未发现', color: 'default' };
    });
  }, [dashboardData]);

  return (
    <div>
      {contextHolder}

      <Row gutter={[16, 16]}>
        {summaryCards.map((card) => (
          <Col xs={12} sm={8} md={4} key={card.title}>
            <Card size="small" bordered loading={loading}>
              <Statistic
                title={card.title}
                value={card.value}
                prefix={card.icon}
                valueStyle={{ color: card.color, fontSize: 28 }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={12}>
          <Card title="核心模块状态" size="small" bordered loading={loading}>
            <List
              dataSource={moduleStatus}
              locale={{ emptyText: '暂无模块状态' }}
              renderItem={(item) => (
                <List.Item>
                  <Space>
                    <Tag color={item.color} style={{ minWidth: 8, height: 8, padding: 0, borderRadius: '50%' }} />
                    <Text style={{ color: '#fff' }}>{item.name}</Text>
                  </Space>
                  <Text type="secondary">{item.status}</Text>
                </List.Item>
              )}
            />
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <Card title="近期异常摘要" size="small" bordered loading={loading}>
            <List
              dataSource={[]}
              locale={{ emptyText: '当前版本未接入真实告警/日志数据' }}
              renderItem={() => null}
            />
          </Card>
        </Col>
      </Row>

      <Card title="系统吞吐量趋势 (Tags/s)" size="small" bordered style={{ marginTop: 16 }}>
        <div
          style={{
            height: 240,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#666',
          }}
        >
          当前版本未接入真实吞吐量统计
        </div>
      </Card>
    </div>
  );
};

export default Overview;
