import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Segmented, Select, Space, Typography } from 'antd';
import { CloudOutlined, ReloadOutlined, UsbOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import type { VerticalSecurityAccessMode } from '../../adapters';
import SecurityLogin from '../SecurityAccess/SecurityLogin';
import '../SecurityAccess/index.css';

interface PlatformDevice { device_id: string; display_name: string; online: boolean }

export default function SecurityLoginPage() {
  const [mode, setMode] = useState<VerticalSecurityAccessMode>('direct');
  const [devices, setDevices] = useState<PlatformDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string>();
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [locked, setLocked] = useState(false);
  const mountedRef = useRef(false);
  const deviceGenerationRef = useRef(0);
  const desktop = '__TAURI_INTERNALS__' in window;
  const selectedDevice = devices.find(device => device.device_id === deviceId);

  const loadDevices = useCallback(async () => {
    if (!desktop) return;
    const generation = ++deviceGenerationRef.current;
    setLoadingDevices(true);
    try {
      const list = await invoke<PlatformDevice[]>('remote_list_devices');
      if (!mountedRef.current || generation !== deviceGenerationRef.current) return;
      setDevices(list); setDeviceError(null);
    } catch {
      if (mountedRef.current && generation === deviceGenerationRef.current) setDeviceError('读取平台设备失败，请稍后刷新。');
    } finally {
      if (mountedRef.current && generation === deviceGenerationRef.current) setLoadingDevices(false);
    }
  }, [desktop]);

  useEffect(() => {
    mountedRef.current = true;
    void loadDevices();
    return () => { mountedRef.current = false; deviceGenerationRef.current += 1; };
  }, [loadDevices]);

  return <div className="security-access-page security-login-page">
    <div className="security-access-connection-bar">
      <Segmented aria-label="纵密登录连接方式" value={mode} disabled={locked} onChange={value => setMode(value as VerticalSecurityAccessMode)} options={[{ value: 'direct', label: '101 口直连', icon: <UsbOutlined /> }, { value: 'remote', label: '平台远程', icon: <CloudOutlined /> }]} />
      {mode === 'direct' && <Typography.Text type="secondary">请先在访问通路页配置通路，再手动登录纵密装置。</Typography.Text>}
      {mode === 'remote' && <Space.Compact className="security-access-device-picker"><Select id="security-login-device" aria-label="目标 DSP" value={deviceId} disabled={locked || !desktop} loading={loadingDevices} placeholder="选择平台设备" onChange={setDeviceId} options={devices.map(device => ({ value: device.device_id, label: `${device.display_name || device.device_id} · ${device.online ? '在线' : '离线'}` }))} /><Button aria-label="刷新平台设备" icon={<ReloadOutlined />} disabled={locked || !desktop} loading={loadingDevices} onClick={() => void loadDevices()} /></Space.Compact>}
      {mode === 'remote' && !desktop && <Alert type="info" title="平台设备列表需要桌面版上位机" />}
      {mode === 'remote' && deviceError && <Alert type="warning" showIcon title={deviceError} />}
    </div>
    <SecurityLogin key={`${mode}:${deviceId ?? ''}`} mode={mode} deviceId={deviceId} deviceLabel={selectedDevice?.display_name} accessBusy={false} onLockChange={setLocked} />
  </div>;
}
