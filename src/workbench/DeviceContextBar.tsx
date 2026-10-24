import { useEffect, useState } from 'react';
import { Button, Tag, Tooltip } from 'antd';
import { ApiOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { useNavigate } from 'react-router-dom';
import { useAppMode } from '../offline/app-mode-context';
import { getStoredManagerAddress } from '../utils/app-settings';
import { subscribeManagerRuntimeRefreshed } from '../utils/manager-runtime-events';

interface ConnectionStatus {
  remote: boolean;
  device_id: string | null;
  display_name?: string | null;
  manager_addr?: string;
  active: boolean;
}

export function DeviceContextBar() {
  const { mode, workspace } = useAppMode();
  const navigate = useNavigate();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const desktop = '__TAURI_INTERNALS__' in window;
  useEffect(() => {
    if (mode !== 'online' || !desktop) return;
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const current = ++generation;
      try {
        const value = await invoke<ConnectionStatus>('remote_connection_status');
        if (!value || typeof value.remote !== 'boolean') throw Error('设备上下文暂不可用');
        if (!disposed && generation === current) { setStatus(value); setUnavailable(false); }
      } catch {
        if (!disposed && generation === current) { setStatus(null); setUnavailable(true); }
      }
    };
    const poll = async () => {
      await read();
      if (!disposed) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    const unsubscribe = subscribeManagerRuntimeRefreshed(() => { void read(); });
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); };
  }, [desktop, mode]);

  const offline = mode === 'offline';
  const name = offline ? workspace?.workspace_name || '未命名工作区'
    : !desktop ? '浏览器演示'
      : unavailable ? '设备上下文读取失败'
        : !status ? '正在读取当前设备'
          : status.remote ? status.display_name || status.device_id || '平台远程设备'
            : status.manager_addr || getStoredManagerAddress('127.0.0.1:17000');
  const path = offline ? '离线工作区' : desktop && !status ? '连接方式未确认' : status?.remote ? '平台远程' : '现场直连';
  const detail = offline ? '配置仅保存在工作区，导出后交给现场导入'
    : status?.remote ? `${status.device_id || ''} · ${status.active ? '远程会话有效' : '远程会话已失效'}；设备在线及通信状态请查看对应连接`
      : '当前直连目标；协议连接与数据健康状态请查看对应页面';
  return (
    <div className="workbench-device-context" aria-label="当前设备与连接方式">
      <Tooltip title={`${name} · ${detail}`}>
        <div className="workbench-device-identity">
          <span className="workbench-device-label">{offline ? '当前工作区' : '当前设备'}</span>
          <strong className="workbench-device-name">{name}</strong>
        </div>
      </Tooltip>
      <Tag color={offline ? 'gold' : status?.remote ? 'blue' : 'default'}>{path}</Tag>
      {status?.remote && !offline ? <Tag color={status.active ? 'blue' : 'error'}>{status.active ? '会话有效' : '会话失效'}</Tag> : null}
      {!offline ? <Button size="small" icon={<ApiOutlined />} onClick={() => navigate('/module-ops')}>设备连接</Button> : null}
    </div>
  );
}
