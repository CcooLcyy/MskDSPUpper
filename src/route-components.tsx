import { Suspense, lazy, type ReactNode } from 'react';

export const OverviewPage = lazy(() => import('./pages/Overview'));
export const ModuleOpsPage = lazy(() => import('./pages/ModuleOps'));
export const IEC104Page = lazy(() => import('./pages/IEC104'));
export const ModbusRTUPage = lazy(() => import('./pages/ModbusRTU'));
export const DLT645Page = lazy(() => import('./pages/DLT645'));
export const DataBusPage = lazy(() => import('./pages/DataBus'));
export const AGCPage = lazy(() => import('./pages/AGC'));
export const AVCPage = lazy(() => import('./pages/AVC'));
export const SettingsPage = lazy(() => import('./pages/Settings'));

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
      {'\u9875\u9762\u52a0\u8f7d\u4e2d...'}
    </div>
  );
}

type RouteSuspenseProps = {
  children: ReactNode;
};

export function RouteSuspense({ children }: RouteSuspenseProps) {
  return <Suspense fallback={<RouteLoading />}>{children}</Suspense>;
}
