import { theme } from 'antd';
import type { ThemeConfig } from 'antd';

export const darkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#007acc',
    colorBgContainer: '#2d2d30',
    colorBgElevated: '#333333',
    colorBgLayout: '#1e1e1e',
    colorBorder: '#3e3e42',
    colorText: '#ffffff',
    colorTextSecondary: '#aaaaaa',
    borderRadius: 4,
    fontFamily:
      '"Microsoft YaHei", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif',
  },
  components: {
    Layout: {
      siderBg: '#252526',
      headerBg: '#333333',
      bodyBg: '#1e1e1e',
    },
    Menu: {
      darkItemBg: '#252526',
      darkItemSelectedBg: '#37373d',
      darkItemColor: '#cccccc',
      darkItemSelectedColor: '#ffffff',
    },
    Table: {
      headerBg: '#2d2d30',
      rowHoverBg: '#37373d',
    },
    Card: {
      colorBgContainer: '#2d2d30',
    },
  },
};
