import React, { useState } from 'react';
import { Layout, Menu, Typography } from 'antd';
import {
  DashboardOutlined,
  AppstoreOutlined,
  ApiOutlined,
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
    label: '绯荤粺鎬昏',
  },
  {
    key: '/module-ops',
    icon: <AppstoreOutlined />,
    label: '妯″潡杩愮淮',
  },
  {
    key: '/protocol',
    icon: <ApiOutlined />,
    label: '瑙勭害鎺ュ叆',
    children: [
      { key: '/protocol/iec104', label: 'IEC104' },
      { key: '/protocol/modbus-rtu', label: 'Modbus RTU' },
    ],
  },
  {
    key: '/alerts-logs',
    icon: <AlertOutlined />,
    label: '鍛婅涓庢棩蹇?,
  },
  {
    key: '/debug-tools',
    icon: <ToolOutlined />,
    label: '鑱旇皟宸ュ叿',
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
            {collapsed ? 'DSP' : 'MskDSP 鎺у埗鍙?}
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
          <Text style={{ color: '#aaa', fontSize: 13 }}>admin (绠＄悊鍛?</Text>
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
