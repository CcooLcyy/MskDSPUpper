import { createBrowserRouter, redirect } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import { ADVANCED_CONFIG_PATH } from './utils/advanced-config-auth';
import {
  ControlPage,
  CalcPage,
  ControlOrchestratorPage,
  DataBusPage,
  DLT645Page,
  IEC104Page,
  IEC61850Page,
  ModbusRTUPage,
  ModbusTCPPage,
  ModuleOpsPage,
  OverviewPage,
  RouteSuspense,
  SecurityAccessPage,
  SecurityConfigPage,
  SettingsPage,
  SoftwareUpdatePage,
} from './route-components';

function redirectToControlModule(module: 'agc' | 'avc') {
  return ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const params = new URLSearchParams(url.search);
    params.set('module', module);
    const search = params.toString();
    throw redirect(`/control${search ? `?${search}` : ''}`);
  };
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <MainLayout />,
    children: [
      {
        index: true,
        element: (
          <RouteSuspense>
            <OverviewPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'module-ops',
        element: (
          <RouteSuspense>
            <ModuleOpsPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'protocol/iec104',
        element: (
          <RouteSuspense>
            <IEC104Page />
          </RouteSuspense>
        ),
      },
      {
        path: 'protocol/iec61850',
        element: (
          <RouteSuspense>
            <IEC61850Page />
          </RouteSuspense>
        ),
      },
      {
        path: 'protocol/modbus-rtu',
        element: (
          <RouteSuspense>
            <ModbusRTUPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'protocol/modbus-tcp',
        element: (
          <RouteSuspense>
            <ModbusTCPPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'protocol/dlt645',
        element: (
          <RouteSuspense>
            <DLT645Page />
          </RouteSuspense>
        ),
      },
      {
        path: 'data-bus',
        element: (
          <RouteSuspense>
            <DataBusPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'control',
        element: (
          <RouteSuspense>
            <ControlPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'control/agc',
        loader: redirectToControlModule('agc'),
      },
      {
        path: 'control/avc',
        loader: redirectToControlModule('avc'),
      },
      {
        path: 'settings',
        element: (
          <RouteSuspense>
            <SettingsPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'software-update',
        element: (
          <RouteSuspense>
            <SoftwareUpdatePage />
          </RouteSuspense>
        ),
      },
      {
        path: 'security-access',
        element: (
          <RouteSuspense>
            <SecurityAccessPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'security-config',
        element: (
          <RouteSuspense>
            <SecurityConfigPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'alerts-logs',
        element: (
          <div style={{ color: '#aaa', fontSize: 16, padding: 0, textAlign: 'center' }}>
            <p style={{ padding: 24 }}>告警中心暂未接入。通信排查请进入对应协议的报文日志，IEC104 事件请查看 SOE 历史。</p>
          </div>
        ),
      },
      {
        path: 'calc',
        element: (
          <RouteSuspense>
            <CalcPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'control-orchestrator',
        element: (
          <RouteSuspense>
            <ControlOrchestratorPage />
          </RouteSuspense>
        ),
      },
      {
        path: ADVANCED_CONFIG_PATH.slice(1),
        loader: ({ request }) => {
          const url = new URL(request.url);
          throw redirect(`/software-update${url.search}`);
        },
      },
      {
        path: 'debug-tools',
        loader: ({ request }) => {
          const url = new URL(request.url);
          throw redirect(`/software-update${url.search}`);
        },
      },
    ],
  },
]);
