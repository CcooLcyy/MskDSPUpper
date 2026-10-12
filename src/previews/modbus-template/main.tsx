import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { darkTheme } from '../../theme/dark';
import TemplatePreview from './TemplatePreview';
import { initializeAppSettings } from '../../utils/app-settings';
import '../../index.css';
import './preview.css';

const root = document.getElementById('root');
if (!root) throw new Error('未找到模板预览容器');
await initializeAppSettings();
createRoot(root).render(
  <StrictMode>
    <ConfigProvider theme={darkTheme} locale={zhCN}>
      <App><TemplatePreview /></App>
    </ConfigProvider>
  </StrictMode>,
);
