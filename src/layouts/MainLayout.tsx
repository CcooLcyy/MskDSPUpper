import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Layout, Menu, Space, Typography } from 'antd';
import {
  AlertOutlined,
  ApiOutlined,
  AppstoreOutlined,
  CalculatorOutlined,
  CloudDownloadOutlined,
  ControlOutlined,
  OrderedListOutlined,
  DashboardOutlined,
  EllipsisOutlined,
  NodeIndexOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import ControlHeaderViewSwitcher from '../components/control/ControlHeaderViewSwitcher';
import DataBusHeaderViewSwitcher from '../components/data-bus/DataBusHeaderViewSwitcher';
import { useAppUpdate } from '../components/app-update/app-update-context';
import SoftwareUpdateHeaderViewSwitcher from '../components/app-update/SoftwareUpdateHeaderViewSwitcher';
import { LowerUpdateDeploymentHeader } from '../components/lower-update/LowerUpdateDeploymentUi';
import ProtocolHeaderViewSwitcher from '../components/protocol/ProtocolHeaderViewSwitcher';
import { useAppMode } from '../offline/app-mode-context.ts';
import type { Capability } from '../offline/capabilities.ts';
import OfflineModeControls from '../offline/ui/OfflineModeControls.tsx';
import { PlatformAccountControl } from '../auth/PlatformAccountControl';
import { DeviceContextBar } from '../workbench/DeviceContextBar';
import { WorkbenchViewSwitcher } from '../workbench/WorkbenchViewSwitcher';
import { useWorkbench } from '../workbench/workbench-context';
import './MainLayout.css';
import '../components/protocol/protocol-page.css';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

interface MenuItemConfig {
  key: string;
  icon: React.ReactNode;
  label: string;
  /** 该菜单项需要的运行能力；离线工作区缺少能力时会被隐藏。 */
  requires?: Capability;
  children?: Array<{ key: string; label: string; requires?: Capability }>;
}

const menuItems: MenuItemConfig[] = [
  {
    key: '/',
    icon: <DashboardOutlined />,
    label: '系统总览',
  },
  {
    key: '/module-ops',
    icon: <AppstoreOutlined />,
    label: '模块运维',
    requires: 'module.ops',
  },
  {
    key: '/protocol',
    icon: <ApiOutlined />,
    label: '协议接入',
    children: [
      { key: '/protocol/iec104', label: 'IEC104' },
      { key: '/protocol/iec61850', label: 'IEC61850', requires: 'iec61850' },
      { key: '/protocol/modbus-rtu', label: 'Modbus RTU' },
      { key: '/protocol/modbus-tcp', label: 'Modbus TCP' },
      { key: '/protocol/dlt645', label: 'DLT645' },
    ],
  },
  {
    key: '/alerts-logs',
    icon: <AlertOutlined />,
    label: '告警日志（暂未接入）',
  },
  {
    key: '/calc',
    icon: <CalculatorOutlined />,
    label: '数值计算',
  },
  {
    key: '/data-bus',
    icon: <NodeIndexOutlined />,
    label: '数据总线',
  },
  {
    key: '/control',
    icon: <ControlOutlined />,
    label: '控制策略',
  },
  {
    key: '/control-orchestrator',
    icon: <OrderedListOutlined />,
    label: '控制编排',
    requires: 'orchestrator',
  },
  {
    key: '/security-access',
    icon: <SafetyCertificateOutlined />,
    label: '纵密访问',
  },
  {
    key: '/security-config',
    icon: <SafetyCertificateOutlined />,
    label: '纵密网络配置',
  },
  {
    key: '/software-update',
    icon: <CloudDownloadOutlined />,
    label: '软件更新',
  },
  {
    key: '/settings',
    icon: <EllipsisOutlined />,
    label: '工程文件与设置',
  },
];

const MainLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasAvailableUpdate } = useAppUpdate();
  const { can } = useAppMode();
  const { view } = useWorkbench();
  const [collapsed, setCollapsed] = useState(false);
  // 只有包含子页面的入口才拦截导航；功能占位入口仍可打开明确说明。
  const parentMenuKeys = new Set(['/protocol']);
  const renderedMenuItems = useMemo(
    () =>
      menuItems
        .filter((item) => !item.requires || can(item.requires))
        .map((item) => ({
          ...item,
          ...(item.children
            ? { children: item.children.filter((child) => !child.requires || can(child.requires)) }
            : {}),
          ...(item.key === '/software-update'
            ? {
                icon: (
                  <Badge dot={hasAvailableUpdate} offset={[2, 1]} className="main-layout-update-badge">
                    <CloudDownloadOutlined />
                  </Badge>
                ),
              }
            : {}),
        })),
    [can, hasAvailableUpdate],
  );

  const selectedKey = location.pathname;
  const groupedMenuItems = [
    ...renderedMenuItems.filter(item => item.key === '/'),
    ...[
      { key: 'engineering', label: '工程配置', paths: ['/protocol', '/data-bus', '/calc', '/control', '/control-orchestrator'] },
      { key: 'diagnostics', label: '运行诊断', paths: ['/alerts-logs'] },
      { key: 'maintenance', label: '设备维护', paths: ['/module-ops', '/security-access', '/security-config', '/software-update'] },
      { key: 'files', label: '工程文件', paths: ['/settings'] },
    ].flatMap(section => {
      const children = section.paths.flatMap(path => renderedMenuItems.filter(item => item.key === path));
      return children.length ? [{ key: section.key, type: 'group' as const, label: section.label, children }] : [];
    }),
  ];
  const navigableKeys = useMemo(
    () =>
      renderedMenuItems.flatMap((item) =>
        item.children ? item.children.map((child) => child.key) : [item.key],
      ),
    [renderedMenuItems],
  );
  const openKeys = renderedMenuItems
    .filter((item) => item.children?.some((child) => selectedKey.startsWith(child.key)))
    .map((item) => item.key);

  // 当前页面在该模式下不可用时（例如离线模式下的系统总览），跳到第一个可用页面。
  useEffect(() => {
    if (navigableKeys.includes(selectedKey)) {
      return;
    }

    const fallback = navigableKeys.find((key) => key !== '/protocol');

    if (fallback) {
      console.info('[离线工作区] 当前页面在该模式下不可用，已跳转', { from: selectedKey, to: fallback });
      navigate(fallback, { replace: true });
    }
  }, [navigableKeys, navigate, selectedKey]);

  const currentLabel =
    renderedMenuItems.find((item) => item.key === selectedKey)?.label ||
    renderedMenuItems
      .flatMap((item) => ('children' in item ? item.children || [] : []))
      .find((child) => child.key === selectedKey)?.label ||
    'MskDSP';
  const isProtocolPage = location.pathname.startsWith('/protocol/');
  const isIec61850Page = location.pathname === '/protocol/iec61850';
  const isIec104Page = location.pathname === '/protocol/iec104';
  const isControlPage = location.pathname === '/control' || location.pathname.startsWith('/control/');
  const isDataBusPage = location.pathname.startsWith('/data-bus');
  const isSoftwareUpdatePage = location.pathname.startsWith('/software-update');
  const contentOverflow = location.pathname.startsWith('/module-ops') || isProtocolPage || isControlPage || location.pathname.startsWith('/calc') || location.pathname.startsWith('/control-orchestrator') ? 'hidden' : 'auto';

  return (
    <Layout data-workbench-view={view} style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        width={200}
        className="main-layout-sider"
        style={{ borderRight: '1px solid #3e3e42' }}
      >
        <div
          style={{
            height: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            padding: collapsed ? 0 : '0 16px',
            borderBottom: '1px solid #3e3e42',
          }}
        >
          <Text
            strong
            style={{ color: '#fff', fontSize: collapsed ? 14 : 16, whiteSpace: 'nowrap' }}
          >
            {collapsed ? 'DSP' : 'MskDSP 控制台'}
          </Text>
        </div>
        <div className="main-layout-sider-menu-wrap">
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[selectedKey]}
            defaultOpenKeys={openKeys}
            items={groupedMenuItems}
            className="main-layout-sider-menu"
            onClick={({ key }) => {
              if (!parentMenuKeys.has(key)) {
                navigate(key);
              }
            }}
          />
        </div>
      </Sider>
      <Layout style={{ minWidth: 0, minHeight: 0 }}>
        <Header className="workbench-global-header">
          <div className="workbench-global-primary">
            <DeviceContextBar />
            <WorkbenchViewSwitcher />
          </div>
          <Space size={8} align="center" wrap className="workbench-global-actions">
            <LowerUpdateDeploymentHeader />
            <OfflineModeControls />
            <PlatformAccountControl />
          </Space>
        </Header>
        <div className="workbench-page-header">
          <div className="protocol-header-main">
            <Text strong className="protocol-header-title-text">{currentLabel}</Text>
            {isProtocolPage && !isIec61850Page ? <ProtocolHeaderViewSwitcher includeSoe={isIec104Page && can('soe')} /> : null}
            {isControlPage ? <ControlHeaderViewSwitcher /> : null}
            {isDataBusPage ? <DataBusHeaderViewSwitcher /> : null}
            {isSoftwareUpdatePage ? <SoftwareUpdateHeaderViewSwitcher /> : null}
          </div>
          <span className="workbench-view-hint">{view === 'engineering' ? '配置与绑定 · 切换视图保留草稿' : '实时数据与状态 · 以设备当前运行配置为准'}</span>
        </div>
        <Content
          style={{
            padding: 0,
            overflow: contentOverflow,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
};

export default MainLayout;
