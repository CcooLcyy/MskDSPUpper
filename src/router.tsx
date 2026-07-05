import { createBrowserRouter, redirect } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import { ADVANCED_CONFIG_PATH } from './utils/advanced-config-auth';
import {
  AdvancedConfigPage,
  AGCPage,
  AVCPage,
  DataBusPage,
  DLT645Page,
  IEC104Page,
  ModbusRTUPage,
  ModuleOpsPage,
  OverviewPage,
  RouteSuspense,
  SettingsPage,
} from './route-components';

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
        loader: ({ request }) => {
          const url = new URL(request.url);
          throw redirect(`/control/agc${url.search}`);
        },
      },
      {
        path: 'control/agc',
        element: (
          <RouteSuspense>
            <AGCPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'control/avc',
        element: (
          <RouteSuspense>
            <AVCPage />
          </RouteSuspense>
        ),
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
        path: 'alerts-logs',
        element: (
          <div style={{ color: '#aaa', fontSize: 16, padding: 40, textAlign: 'center' }}>
            {'\u544a\u8b66\u4e0e\u65e5\u5fd7\u529f\u80fd\u5f00\u53d1\u4e2d'}
          </div>
        ),
      },
      {
        path: ADVANCED_CONFIG_PATH.slice(1),
        element: (
          <RouteSuspense>
            <AdvancedConfigPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'debug-tools',
        loader: ({ request }) => {
          const url = new URL(request.url);
          throw redirect(`${ADVANCED_CONFIG_PATH}${url.search}`);
        },
      },
    ],
  },
]);
