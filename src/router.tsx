import { createBrowserRouter } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import ModuleOps from './pages/ModuleOps';
import IEC104 from './pages/IEC104';
import ModbusRTU from './pages/ModbusRTU';
import DLT645 from './pages/DLT645';
import DataBus from './pages/DataBus';
import AGC from './pages/AGC';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <MainLayout />,
    children: [
      {
        index: true,
        element: <div style={{ color: '#aaa', fontSize: 16, padding: 40, textAlign: 'center' }}>Overview - In Progress</div>,
      },
      { path: 'module-ops', element: <ModuleOps /> },
      { path: 'protocol/iec104', element: <IEC104 /> },
      { path: 'protocol/modbus-rtu', element: <ModbusRTU /> },
      { path: 'protocol/dlt645', element: <DLT645 /> },
      { path: 'data-bus', element: <DataBus /> },
      { path: 'control', element: <AGC /> },
      {
        path: 'alerts-logs',
        element: <div style={{ color: '#aaa', fontSize: 16, padding: 40, textAlign: 'center' }}>鍛婅涓庢棩蹇?鈥?寮€鍙戜腑</div>,
      },
      {
        path: 'debug-tools',
        element: <div style={{ color: '#aaa', fontSize: 16, padding: 40, textAlign: 'center' }}>鑱旇皟宸ュ叿 鈥?寮€鍙戜腑</div>,
      },
    ],
  },
]);
