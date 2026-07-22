import { createBrowserRouter, redirect } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import { ADVANCED_CONFIG_PATH } from './utils/advanced-config-auth';
import {
  ControlPage,
  DataBusPage,
  DLT645Page,
  IEC104Page,
  ModbusRTUPage,
  ModuleOpsPage,
  OverviewPage,
  RouteSuspense,
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
        path: 'protocol/modbus-rtu',
        element: (
          <RouteSuspense>
            <ModbusRTUPage />
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
        path: 'alerts-logs',
        element: (
          <div style={{ color: '#aaa', fontSize: 16, padding: 0, textAlign: 'center' }}>
            {'\u544a\u8b66\u4e0e\u65e5\u5fd7\u529f\u80fd\u5f00\u53d1\u4e2d'}
          </div>
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
