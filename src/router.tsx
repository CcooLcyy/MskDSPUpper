import { createBrowserRouter } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <MainLayout />,
    children: [
      {
        index: true,
        element: <div style={{ color: '#aaa', fontSize: 16, padding: 40, textAlign: 'center' }}>Overview - In Progress</div>,
      },
      {
        path: 'alerts-logs',
        element: <div style={{ color: '#aaa', fontSize: 16, padding: 40, textAlign: 'center' }}>告警与日志 — 开发中</div>,
      },
      {
        path: 'debug-tools',
        element: <div style={{ color: '#aaa', fontSize: 16, padding: 40, textAlign: 'center' }}>联调工具 — 开发中</div>,
      },
    ],
  },
]);
