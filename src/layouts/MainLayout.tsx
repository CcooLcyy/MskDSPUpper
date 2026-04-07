import React, { useState } from 'react';
import { Layout, Menu, Typography } from 'antd';
import {
  DashboardOutlined,
  AlertOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

const menuItems = [
  {
    key: '/',
    icon: <DashboardOutlined />,
    label: '系统总览',
  },
  {
    key: '/alerts-logs',
    icon: <AlertOutlined />,
    label: '告警与日志',
  },
  {
    key: '/debug-tools',
    icon: <ToolOutlined />,
    label: '联调工具',
  },
];

const MainLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const selectedKey = location.pathname;
  const openKeys = menuItems
    .filter((item) => 'children' in item && item.children?.some((c) => selectedKey.startsWith(c.key)))
    .map((item) => item.key);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        width={200}
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
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          defaultOpenKeys={openKeys}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout style={{ minHeight: 0 }}>
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
          <Text strong style={{ color: '#fff', fontSize: 16 }}>
            {menuItems.find((item) => item.key === selectedKey)?.label ||
              menuItems
                .flatMap((item) => ('children' in item ? item.children || [] : []))
                .find((c) => c.key === selectedKey)?.label ||
              'MskDSP'}
          </Text>
          <Text style={{ color: '#aaa', fontSize: 13 }}>admin (管理员)</Text>
        </Header>
        <Content
          style={{
            padding: 20,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
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
