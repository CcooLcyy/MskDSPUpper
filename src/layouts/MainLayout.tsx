import React, { useState } from 'react';
import { Layout, Menu, Typography } from 'antd';
import {
  AlertOutlined,
  ApiOutlined,
  AppstoreOutlined,
  ControlOutlined,
  DashboardOutlined,
  NodeIndexOutlined,
  SettingOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import ControlHeaderViewSwitcher from '../components/control/ControlHeaderViewSwitcher';
import ProtocolHeaderViewSwitcher from '../components/protocol/ProtocolHeaderViewSwitcher';
import './MainLayout.css';
import '../components/protocol/protocol-page.css';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

const menuItems = [
  {
    key: '/',
    icon: <DashboardOutlined />,
    label: '系统总览',
  },
  {
    key: '/module-ops',
    icon: <AppstoreOutlined />,
    label: '模块运维',
  },
  {
    key: '/protocol',
    icon: <ApiOutlined />,
    label: '协议接入',
    children: [
      { key: '/protocol/iec104', label: 'IEC104' },
      { key: '/protocol/modbus-rtu', label: 'Modbus RTU' },
      { key: '/protocol/dlt645', label: 'DLT645' },
    ],
  },
  {
    key: '/alerts-logs',
    icon: <AlertOutlined />,
    label: '告警日志',
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
    children: [
      { key: '/control/agc', label: 'AGC' },
      { key: '/control/avc', label: 'AVC' },
    ],
  },
  {
    key: '/debug-tools',
    icon: <ToolOutlined />,
    label: '联调工具',
  },
  {
    key: '/settings',
    icon: <SettingOutlined />,
    label: '设置',
  },
];

const MainLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const parentMenuKeys = new Set(['/protocol', '/control']);

  const selectedKey = location.pathname;
  const openKeys = menuItems
    .filter((item) => 'children' in item && item.children?.some((child) => selectedKey.startsWith(child.key)))
    .map((item) => item.key);

  const currentLabel =
    menuItems.find((item) => item.key === selectedKey)?.label ||
    menuItems
      .flatMap((item) => ('children' in item ? item.children || [] : []))
      .find((child) => child.key === selectedKey)?.label ||
    'MskDSP';
  const isProtocolPage = location.pathname.startsWith('/protocol/');
  const isControlPage = location.pathname.startsWith('/control');
  const hasHeaderViewSwitcher = isProtocolPage || isControlPage;
  const contentOverflow = location.pathname.startsWith('/module-ops') || isProtocolPage || isControlPage ? 'hidden' : 'auto';

  return (
    <Layout style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
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
            items={menuItems}
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
        <Header
          style={{
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #3e3e42',
            height: 48,
          }}
        >
          <div className={`protocol-header-main${hasHeaderViewSwitcher ? ' is-protocol' : ''}`}>
            {!hasHeaderViewSwitcher ? (
              <Text strong className="protocol-header-title-text">
                {currentLabel}
              </Text>
            ) : null}
            {isProtocolPage ? <ProtocolHeaderViewSwitcher /> : null}
            {isControlPage ? <ControlHeaderViewSwitcher /> : null}
          </div>
          <Text style={{ color: '#aaa', fontSize: 13 }}>admin (管理员)</Text>
        </Header>
        <Content
          style={{
            padding: 20,
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
