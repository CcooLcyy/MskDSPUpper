// 使用 ESM 入口，避免 Vite 生产构建多包一层 CommonJS 默认导出。
import zhCN from 'antd/es/locale/zh_CN';

const confirmationText = { okText: '确认', cancelText: '取消' };

export const appLocale = {
  ...zhCN,
  Modal: { ...zhCN.Modal, ...confirmationText },
  Popconfirm: { ...zhCN.Popconfirm, ...confirmationText },
};
