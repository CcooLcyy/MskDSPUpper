import React, { Suspense, lazy } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';

const Overview = lazy(() => import('./pages/Overview'));
const ModuleOps = lazy(() => import('./pages/ModuleOps'));
const IEC104 = lazy(() => import('./pages/IEC104'));
const ModbusRTU = lazy(() => import('./pages/ModbusRTU'));
const DLT645 = lazy(() => import('./pages/DLT645'));
const DataBus = lazy(() => import('./pages/DataBus'));
const AGC = lazy(() => import('./pages/AGC'));
const Settings = lazy(() => import('./pages/Settings'));

function RouteLoading() {
  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#aaa',
        fontSize: 14,
      }}
    >
      页面加载中...
    </div>
  );
}

function withSuspense(node: React.ReactNode) {
  return <Suspense fallback={<RouteLoading />}>{node}</Suspense>;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <MainLayout />,
    children: [
      { index: true, element: withSuspense(<Overview />) },
      { path: 'module-ops', element: withSuspense(<ModuleOps />) },
      { path: 'protocol/iec104', element: withSuspense(<IEC104 />) },
      { path: 'protocol/modbus-rtu', element: withSuspense(<ModbusRTU />) },
      { path: 'protocol/dlt645', element: withSuspense(<DLT645 />) },
      { path: 'data-bus', element: withSuspense(<DataBus />) },
      { path: 'control', element: withSuspense(<AGC />) },
      { path: 'settings', element: withSuspense(<Settings />) },
      {
        path: 'alerts-logs',
        element: (
          <div style={{ color: '#aaa', fontSize: 16, padding: 40, textAlign: 'center' }}>
            告警与日志功能开发中
          </div>
        ),
      },
      {
        path: 'debug-tools',
        element: (
          <div style={{ color: '#aaa', fontSize: 16, padding: 40, textAlign: 'center' }}>
            联调工具功能开发中
          </div>
        ),
      },
    ],
  },
]);
