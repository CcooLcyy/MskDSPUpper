import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Segmented, Select, Space, Tag, Typography, message } from 'antd';
import { CloudOutlined, CopyOutlined, DisconnectOutlined, ReloadOutlined, ScanOutlined, UsbOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { api } from '../../adapters';
import type { VerticalSecurityAccessCapabilities, VerticalSecurityAccessMode, VerticalSecurityAccessResult } from '../../adapters';
import './index.css';
import AccessPathConfig from './AccessPathConfig';
import { getAccessCheckRevision, subscribeAccessCheckInvalidation } from './access-state';

interface PlatformDevice { device_id: string; display_name: string; online: boolean; allow_ssh: boolean; services: string[] }
const TARGET_IP = '11.22.33.44';
const DIRECT_STEPS = ['电脑网络', '纵密访问路径', 'ICMP 往返响应', 'TCP 管理端口', 'TLS 安全连接'];

export default function SecurityAccess() {
  const [messages, contextHolder] = message.useMessage();
  const [mode, setMode] = useState<VerticalSecurityAccessMode>('direct');
  const [devices, setDevices] = useState<PlatformDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string>();
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<VerticalSecurityAccessCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [result, setResult] = useState<VerticalSecurityAccessResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [pathBusy, setPathBusy] = useState(false);
  const generationRef = useRef(0);
  const deviceGenerationRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const desktop = '__TAURI_INTERNALS__' in window;
  const selectedDevice = devices.find(device => device.device_id === deviceId);
  const remoteConfigAvailable = Boolean(selectedDevice?.online && selectedDevice.allow_ssh && selectedDevice.services?.includes('ssh'));
  const remoteCheckAvailable = Boolean(capabilities?.remote_ip_available && selectedDevice?.online && selectedDevice.allow_ssh && selectedDevice.services?.includes('vertical-security'));
  const connected = result?.state === 'ready' && Boolean(result.session_id);
  const locked = busy || connected || pathBusy;

  const loadDevices = useCallback(async () => {
    if (!desktop) return;
    const generation = ++deviceGenerationRef.current;
    setLoadingDevices(true);
    try {
      const list = await invoke<PlatformDevice[]>('remote_list_devices');
      if (!mountedRef.current || generation !== deviceGenerationRef.current) return;
      setDevices(list);
      setDeviceError(null);
    } catch (cause) {
      if (mountedRef.current && generation === deviceGenerationRef.current) setDeviceError(`读取平台设备失败：${cause}`);
    } finally {
      if (mountedRef.current && generation === deviceGenerationRef.current) setLoadingDevices(false);
    }
  }, [desktop]);

  useEffect(() => {
    mountedRef.current = true;
    let current = true;
    void api.getVerticalSecurityAccessCapabilities().then(value => {
      if (current) setCapabilities(value);
    }).catch(cause => { if (current) setCapabilityError(`读取访问能力失败：${cause}`); });
    void loadDevices();
    return () => {
      current = false;
      mountedRef.current = false;
      generationRef.current += 1;
      deviceGenerationRef.current += 1;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) void api.closeVerticalSecurityAccess(session).catch(() => {});
    };
  }, [loadDevices]);

  useEffect(() => subscribeAccessCheckInvalidation(() => {
    generationRef.current += 1;
    setResult(null);
    setBusy(false);
    setError('纵密登录连接未通过，之前的检查结果已失效，请重新检查。');
  }), []);

  const clearResult = () => { generationRef.current += 1; setResult(null); setError(null); };
  const check = async () => {
    if (locked || (mode === 'remote' && !remoteCheckAvailable)) return;
    const generation = ++generationRef.current;
    const revision = getAccessCheckRevision();
    setBusy(true); setError(null); setResult(null);
    try {
      const value = await api.checkVerticalSecurityAccess({ mode, ...(mode === 'remote' ? { device_id: deviceId } : {}) });
      if (!mountedRef.current || generation !== generationRef.current || revision !== getAccessCheckRevision()) {
        if (value.session_id) void api.closeVerticalSecurityAccess(value.session_id).catch(() => {});
        return;
      }
      if (value.target_ip !== TARGET_IP || value.mode !== mode || (mode === 'remote' && value.device_id !== deviceId)) {
        if (value.session_id) void api.closeVerticalSecurityAccess(value.session_id).catch(() => {});
        throw new Error('检查结果与当前目标不匹配，请重新检查。');
      }
      sessionRef.current = value.session_id;
      setResult(value);
    } catch (cause) {
      if (mountedRef.current && generation === generationRef.current) setError(`访问检查失败：${cause}`);
    } finally {
      if (mountedRef.current && generation === generationRef.current) setBusy(false);
    }
  };
  const disconnect = async () => {
    const session = sessionRef.current;
    if (!session) { clearResult(); return; }
    setBusy(true);
    try { await api.closeVerticalSecurityAccess(session); sessionRef.current = null; clearResult(); }
    catch (cause) { setError(`断开访问失败：${cause}`); }
    finally { if (mountedRef.current) setBusy(false); }
  };
  const status = busy ? '检查中' : connected ? '已连接' : result?.state === 'ready' ? '检查通过' : result?.state === 'failed' ? '检查未通过' : result?.state === 'unsupported' ? '暂不支持' : '未检查';
  const path = mode === 'direct'
    ? [['电脑', '11.22.33.x/24'], ['DSP · 101 口', '11.22.33.1'], ['DSP · 108 口', '11.22.33.2'], ['纵密装置', TARGET_IP]]
    : [['上位机', '平台远程通道'], ['平台', selectedDevice?.display_name || deviceId || '尚未选择 DSP'], ['DSP · 108 口', '11.22.33.2'], ['纵密装置', TARGET_IP]];

  return <div className="security-access-page">
    {contextHolder}
    <div className="security-access-frame">
    <header className="security-workbench-heading"><h1>纵密访问通路</h1><p>配置纵密访问通路，检查电脑、DSP 与纵密装置之间的网络连接。</p></header>
    <div className="security-access-connection-bar">
      <Segmented value={mode} disabled={locked} onChange={value => { clearResult(); setMode(value as VerticalSecurityAccessMode); }} options={[{ value: 'direct', label: '101 口直连', icon: <UsbOutlined /> }, { value: 'remote', label: '平台远程', icon: <CloudOutlined /> }]} />
      {mode === 'remote' && <Space.Compact className="security-access-device-picker"><Select id="security-access-device" aria-label="目标 DSP" value={deviceId} disabled={locked || !desktop} loading={loadingDevices} placeholder="选择平台设备" onChange={value => { clearResult(); setDeviceId(value); }} options={devices.map(device => ({ value: device.device_id, label: `${device.display_name || device.device_id} · ${device.online ? '在线' : '离线'}` }))} /><Button aria-label="刷新平台设备" icon={<ReloadOutlined />} disabled={locked || !desktop} loading={loadingDevices} onClick={() => void loadDevices()} /></Space.Compact>}
    </div>
    <div className="security-access-columns">
      <Card title="访问路径" className="security-access-path"><ol>{path.map(([name, detail]) => <li key={name}><strong>{name}</strong><span>{detail}</span></li>)}</ol><dl><div><dt>访问范围</dt><dd>{mode === 'direct' ? '仅目标 IP，端口不限' : '上位机内部管理通路 · TCP 8888'}</dd></div><div><dt>回程</dt><dd>{mode === 'direct' ? '经 DSP 返回 101 口电脑' : '沿本次平台远程通道返回'}</dd></div><div><dt>接入网络</dt><dd>{mode === 'direct' ? '101 口网线直连' : '由 DSP 当前网络路由决定'}</dd></div></dl></Card>
      <Card className="security-access-connect" title={<h2 className="security-workbench-card-title">管理连接检查</h2>} extra={<Badge status={busy ? 'processing' : result?.state === 'ready' ? 'success' : result?.state === 'failed' ? 'error' : 'default'} text={status} />}>
        <div className="security-access-check-layout">
        <div className="security-access-check-controls">
        <div className="security-access-target"><div><span>纵密目标 IP</span><strong>{TARGET_IP}</strong></div><Tag>DSP · 108 口</Tag></div>
        {mode === 'direct' ? <>
          <p className="security-access-instruction">电脑接入 DSP 的 101 口，使用 11.22.33.0/24 网段内未占用的地址。</p>
        </> : <div className="security-access-remote">
          <strong>目标 DSP：{selectedDevice?.display_name || '尚未选择'}</strong>
          <Typography.Text type="secondary">设备标识：{deviceId ?? '尚未选择'}</Typography.Text>
          {deviceError && <Alert type="warning" showIcon title={deviceError} />}
          {!desktop && <Alert type="info" title="平台设备列表需要桌面版上位机" />}
          <Alert type="info" showIcon title="设备通过可用网络连接平台，无需选择 PPP 或外置 4G。" />
          {!capabilities?.remote_ip_available && <Alert type="warning" showIcon title="远程网络通道待接入" description={capabilityError || capabilities?.remote_ip_reason || '正在读取访问能力；当前不建立远程 IP 通道。'} />}
          {selectedDevice && !selectedDevice.online && <Alert type="warning" showIcon title="所选 DSP 当前离线" />}
          {selectedDevice?.online && !selectedDevice.allow_ssh && <Alert type="warning" showIcon title="所选 DSP 未授权 SSH 维护访问" />}
          {selectedDevice?.online && selectedDevice.allow_ssh && !selectedDevice.services?.includes('ssh') && <Alert type="warning" showIcon title="所选 DSP 尚未开放 SSH 服务，无法远程配置通路" />}
          {selectedDevice?.online && selectedDevice.allow_ssh && !selectedDevice.services?.includes('vertical-security') && <Alert type="warning" showIcon title="所选 DSP 尚未开放纵密管理通路，请更新下位机后检测" />}
        </div>}
        <div className="security-access-actions">
          <Space wrap><Button type="primary" icon={<ScanOutlined />} loading={busy} disabled={connected || pathBusy || (mode === 'remote' && !remoteCheckAvailable)} onClick={() => void check()}>{mode === 'direct' ? '检查直连' : '检查远程通路'}</Button><AccessPathConfig key={`${mode}:${deviceId ?? ''}`} mode={mode} deviceId={deviceId} deviceName={selectedDevice?.display_name} disabled={busy || connected || (mode === 'remote' && !remoteConfigAvailable)} onBusyChange={setPathBusy} onApplied={clearResult} />{busy && !connected && <Button onClick={() => { clearResult(); setBusy(false); }}>取消检查</Button>}</Space>
          <p className="security-access-action-hint">{mode === 'direct' ? '首次使用先配置访问通路，再手动检查直连。' : '通过所选 DSP 的远程 SSH 配置维护通路，再手动检测纵密管理连接。'}</p>
        </div>
        </div>
        <div className="security-access-diagnostics">
        {error && <Alert className="security-access-notice" type="error" showIcon title={error} />}
        {result && <p className="security-access-check-time">检查时间：<time dateTime={new Date(result.checked_at_ms).toISOString()}>{new Date(result.checked_at_ms).toLocaleString()}</time></p>}
        <details className="security-access-details" open><summary>连接详情</summary>
          <div aria-live="polite">{result?.steps.map(step => <div className="security-access-step" key={step.id}><Badge status={step.state === 'success' ? 'success' : step.state === 'failed' ? 'error' : 'warning'} /><div><strong>{step.name}</strong><p>{step.message}</p></div><span>{step.state === 'success' ? '通过' : step.state === 'failed' ? '未通过' : result.state === 'unsupported' ? '不支持' : '未执行'}</span></div>) ?? (mode === 'direct' ? DIRECT_STEPS : ['平台设备', '远程管理通道', 'TCP 管理端口', 'TLS 安全连接']).map(name => <div className="security-access-step" key={name}><Badge status="default" /><strong>{name}</strong><span>{busy ? '检查中' : '待检查'}</span></div>)}</div>
        </details>
        <details className="security-access-explanation"><summary>检查结果说明</summary><p className="security-access-boundary">管理连接可用表示本次 TCP 8888 连接及 TLS 证书握手通过；ICMP 仅辅助诊断。检查不发送账号，登录认证需单独完成；检查完成即释放连接，后续状态变化需重新检查。</p></details>
        {result?.state === 'ready' && <div className="security-access-result"><strong>{mode === 'direct' ? '管理连接可用' : '远程管理通路检查通过'}</strong><p>{mode === 'direct' ? `在原有纵密配置工具中使用目标 IP：${TARGET_IP}` : '本次上位机经平台与所选 DSP 完成纵密管理连接探测，探测连接已释放。'}</p><Space wrap>{mode === 'direct' && <Button icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(TARGET_IP).then(() => messages.success('已复制目标 IP')).catch(() => messages.error('复制失败，请手动复制目标 IP'))}>复制目标 IP</Button>}<Button icon={<DisconnectOutlined />} disabled={busy} onClick={() => void disconnect()}>{connected ? '断开网络访问' : '清除检查结果'}</Button></Space></div>}
        </div>
        </div>
      </Card>
    </div>
    </div>
  </div>;
}
