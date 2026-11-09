import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Badge, Button, Card, Input, Modal, Segmented, Select, Space, Tag, Typography, message } from 'antd';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { createSshOutputAcks } from '../../utils/remote-ssh-output';
import { sshUiError } from '../../utils/remote-ssh-ui-error';
import { changeConfigDraftTarget } from '../../drafts/config-draft-target';

interface Device {
  device_id: string; display_name: string; online: boolean;
  allow_grpc: boolean; allow_ssh: boolean; services: string[];
}
interface ConnectionStatus { remote: boolean; device_id: string | null; active: boolean }
type SshEvent = { type: 'host_key'; fingerprint: string; device_id: string }
  | { type: 'connected' } | { type: 'data'; bytes: number[] } | { type: 'closed'; message: string };

export default function RemoteAccessPanel({ directAddress, onModeChange, onConnected, onConnectionIntent, directControls, actions }: {
  directAddress: string; onModeChange: (remote: boolean) => void; onConnected: () => Promise<void>;
  onConnectionIntent?: () => void;
  directControls?: ReactNode; actions?: ReactNode;
}) {
  const [connectionView, setConnectionView] = useState<'direct' | 'remote' | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState<string>();
  const [status, setStatus] = useState<ConnectionStatus>({ remote: false, device_id: null, active: false });
  const [busy, setBusy] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sshConnected, setSshConnected] = useState(false);
  const [sshStarting, setSshStarting] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hostKey, setHostKey] = useState<{ fingerprint: string; device_id: string } | null>(null);
  const [terminalElement, setTerminalElement] = useState<HTMLDivElement | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [sshSessionId, setSshSessionId] = useState<string | null>(null);
  const [sshError, setSshError] = useState<string | null>(null);
  const [sshNotice, setSshNotice] = useState('终端已就绪，请登录');
  const [trustBusy, setTrustBusy] = useState(false);
  const [messages, contextHolder] = message.useMessage();
  const terminal = useRef<Terminal | null>(null);
  const session = useRef<string | null>(null);
  const sessionEpoch = useRef(0);
  const inputChain = useRef(Promise.resolve());
  const loadGeneration = useRef(0);
  const mounted = useRef(true);
  const opening = useRef(false);
  const confirming = useRef(false);
  const desktop = '__TAURI_INTERNALS__' in window;
  const device = devices.find(d => d.device_id === selected);
  const connectedDevice = devices.find(d => d.device_id === status.device_id);
  const deviceOnline = status.active && connectedDevice?.online === true;
  const sshTargetReady = status.remote && status.device_id === selected && deviceOnline
    && device?.allow_ssh === true && device.services.includes('ssh');
  const showRemote = (connectionView ?? (status.remote ? 'remote' : 'direct')) === 'remote';

  const closeSsh = useCallback(() => {
    sessionEpoch.current += 1;
    const current = session.current;
    session.current = null;
    opening.current = false; confirming.current = false;
    if (current) void invoke('remote_ssh_close', { sessionId: current }).catch(() => {});
    setPassword(''); setHostKey(null); setSshConnected(false); setSshStarting(false);
    setSshSessionId(null); setTrustBusy(false); setSshError(null); setSshNotice('SSH 已断开');
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; closeSsh(); };
  }, [closeSsh]);

  const load = useCallback(async () => {
    if (!desktop) return;
    const generation = ++loadGeneration.current;
    const [list, current] = await Promise.all([
      invoke<Device[]>('remote_list_devices'), invoke<ConnectionStatus>('remote_connection_status'),
    ]);
    if (!mounted.current || generation !== loadGeneration.current) return;
    setDevices(list); setStatus(current); onModeChange(current.remote);
    if (current.device_id) setSelected(value => value ?? current.device_id ?? undefined);
  }, [desktop, onModeChange]);
  useEffect(() => {
    void load().catch(error => messages.error(`读取平台设备失败：${error}`));
    const timer = window.setInterval(() => { void load().catch(() => {}); }, 10000);
    return () => window.clearInterval(timer);
  }, [load, messages]);

  useEffect(() => {
    if (!terminalOpen || !terminalElement) return;
    let term: Terminal | null = null;
    let observer: ResizeObserver | null = null;
    let listener: { dispose(): void } | null = null;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      listener?.dispose(); observer?.disconnect(); term?.dispose();
      if (terminal.current === term) terminal.current = null;
      setTerminalReady(false);
    };
    try {
      const currentTerm = new Terminal({ cursorBlink: true, convertEol: false, scrollback: 2000, fontSize: 14 });
      term = currentTerm;
      const fit = new FitAddon(); currentTerm.loadAddon(fit); currentTerm.open(terminalElement); fit.fit();
      terminal.current = currentTerm;
      observer = new ResizeObserver(() => {
        if (disposed) return;
        fit.fit();
        const current = session.current; const epoch = sessionEpoch.current;
        if (current) void invoke('remote_ssh_resize', { sessionId: current, cols: currentTerm.cols, rows: currentTerm.rows }).catch(() => {
          if (mounted.current && epoch === sessionEpoch.current && session.current === current) setSshError('SSH 窗口调整失败，请检查连接');
        });
      });
      observer.observe(terminalElement);
      listener = currentTerm.onData(data => {
        const current = session.current; const epoch = sessionEpoch.current;
        if (!current) return;
        const chunks = data.match(/[\s\S]{1,8000}/gu) ?? [];
        inputChain.current = inputChain.current.then(async () => {
          for (const chunk of chunks) {
            if (session.current !== current || epoch !== sessionEpoch.current) return;
            await invoke('remote_ssh_input', { sessionId: current, data: chunk });
          }
        }).catch(() => {
          if (!mounted.current || epoch !== sessionEpoch.current || session.current !== current) return;
          closeSsh(); setSshError('SSH 输入失败，连接已关闭，请重新登录');
        });
      });
      setTerminalError(null); setTerminalReady(true);
    } catch {
      dispose(); setTerminalError('终端初始化失败，请关闭窗口后重试');
    }
    return dispose;
  }, [terminalOpen, terminalElement, closeSsh]);

  async function connectDevice() {
    if (!selected) return;
    onConnectionIntent?.();
    setBusy(true); closeSsh();
    try {
      await changeConfigDraftTarget(() => invoke('remote_select_device', { deviceId: selected }));
      await load();
      if (!mounted.current) return;
      messages.success(`已选择远程设备：${device?.display_name ?? selected}`);
    } catch (error) { if (mounted.current) messages.error(`远程连接失败：${error}`); return; }
    finally { setBusy(false); }
    // 连接选择完成后即可切换面板，不让列表读取继续锁住连接方式。
    if (mounted.current && device?.allow_grpc) await onConnected();
  }
  async function returnToDirect() {
    onConnectionIntent?.();
    setBusy(true); closeSsh();
    try { await changeConfigDraftTarget(() => invoke('remote_use_direct', { address: directAddress })); await load(); }
    catch (error) { if (mounted.current) messages.error(`切换直连失败：${error}`); return; }
    finally { setBusy(false); }
    if (mounted.current) await onConnected();
  }
  async function openSsh() {
    if (opening.current) return;
    if (!terminal.current || !terminalReady) { setSshError('终端尚未就绪，请等待初始化完成或关闭窗口后重试'); return; }
    if (!sshTargetReady) { setSshError('当前设备连接或 SSH 权限已失效，请重新选择并连接在线设备'); return; }
    if (!username.trim() || !password) { setSshError('请输入 SSH 账号和密码'); return; }
    const currentTerm = terminal.current;
    closeSsh(); const epoch = sessionEpoch.current;
    opening.current = true;
    setSshStarting(true); setSshNotice('正在连接并认证 SSH');
    let finished = false;
    const outputAcks = createSshOutputAcks(
      id => { void invoke('remote_ssh_ack', { sessionId: id }).catch(() => {}); },
      () => epoch === sessionEpoch.current && mounted.current,
    );
    const events = new Channel<SshEvent>();
    events.onmessage = event => {
      if (epoch !== sessionEpoch.current || !mounted.current) return;
      if (event.type === 'host_key') { setHostKey(event); setSshError(null); }
      if (event.type === 'connected') { setSshConnected(true); setSshStarting(false); terminal.current?.focus(); }
      if (event.type === 'data') terminal.current?.write(new Uint8Array(event.bytes), outputAcks.consumed);
      if (event.type === 'closed') {
        finished = true;
        const message = sshUiError(event.message, [password]);
        terminal.current?.writeln(`\r\n${message}`);
        if (event.message !== 'SSH 会话已结束') setSshError(message);
        setSshNotice(message); opening.current = false; confirming.current = false;
        setSshSessionId(null); setTrustBusy(false);
        session.current = null; setSshConnected(false); setSshStarting(false); setHostKey(null);
      }
    };
    try {
      currentTerm.reset();
      const id = await invoke<string>('remote_ssh_open', { username, password, cols: currentTerm.cols, rows: currentTerm.rows, events });
      if (epoch !== sessionEpoch.current || finished) { void invoke('remote_ssh_close', { sessionId: id }).catch(() => {}); return; }
      session.current = id;
      setSshSessionId(id);
      outputAcks.bind(id);
    } catch (error) {
      if (epoch === sessionEpoch.current) {
        opening.current = false; setSshError(`打开 SSH 失败：${sshUiError(error, [password])}`); setSshStarting(false);
      }
    } finally { if (epoch === sessionEpoch.current) setPassword(''); }
  }
  async function trustHost(accept: boolean) {
    const current = session.current;
    if (!current) { setSshError('SSH 会话正在准备身份确认，请稍候'); return; }
    if (confirming.current) return;
    const epoch = sessionEpoch.current;
    confirming.current = true; setTrustBusy(true);
    try {
      await invoke('remote_ssh_trust', { sessionId: current, accept });
      if (mounted.current && epoch === sessionEpoch.current && session.current === current) {
        setHostKey(null); setSshError(null); setSshNotice(accept ? '主机身份已确认，正在认证 SSH' : '已拒绝主机身份，正在断开');
      }
    } catch {
      if (mounted.current && epoch === sessionEpoch.current && session.current === current) setSshError('确认 SSH 主机失败，请重新连接后核对指纹');
    } finally {
      if (mounted.current && epoch === sessionEpoch.current && session.current === current) { confirming.current = false; setTrustBusy(false); }
    }
  }

  const sshStatusText = !terminalReady ? '终端初始化中，请稍候'
    : hostKey ? sshSessionId ? '等待核对 SSH 主机指纹' : '正在准备身份确认，请稍候'
      : sshConnected ? 'SSH 已连接' : sshStarting ? '正在连接并认证 SSH' : sshNotice;

  return <Card size="small" className="module-ops-connection-card">
    {contextHolder}
    <div className="module-ops-connection-bar">
      <Segmented aria-label="连接方式" value={showRemote ? 'remote' : 'direct'} disabled={busy}
        options={[{ label: '现场直连', value: 'direct' }, { label: '平台远程', value: 'remote' }]}
        onChange={value => {
          console.info('[模块运维] 切换连接方式面板', { mode: value });
          onConnectionIntent?.();
          setConnectionView(value as 'direct' | 'remote');
        }} />
      <div className="module-ops-connection-controls">
      {!showRemote ? <>
        {status.remote && <Button loading={busy} onClick={() => void returnToDirect()}>切换至现场直连</Button>}
        {directControls}
      </> : !desktop ? <Typography.Text type="secondary">平台远程设备与 SSH 终端需要桌面版上位机</Typography.Text> : <>
        <Select className="module-ops-device-select" aria-label="平台远程设备" placeholder="选择授权设备" value={selected} disabled={busy}
          onChange={value => { onConnectionIntent?.(); closeSsh(); setSelected(value); }}
          options={devices.map(d => ({
            value: d.device_id,
            title: `${d.display_name || d.device_id} · ${d.online ? '在线' : '离线'}`,
            label: <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <Badge status={d.online ? 'success' : 'error'} aria-label={d.online ? '在线' : '离线'} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.display_name || d.device_id}</span>
            </span>,
          }))} />
        <Button disabled={busy} onClick={() => void load().catch(error => messages.error(String(error)))}>刷新设备</Button>
        <Button type="primary" loading={busy} disabled={!device?.online} onClick={() => void connectDevice()}>连接所选设备</Button>
        {status.remote && <Button disabled={busy || !sshTargetReady}
          onClick={() => { setSshError(null); setSshNotice('终端已就绪，请登录'); setTerminalOpen(true); }}>SSH 终端</Button>
        }
      </>}
      </div>
      <div className="module-ops-connection-actions">
        <Tag color={status.remote ? (deviceOnline ? 'blue' : 'red') : 'default'}>{status.remote ? `当前：${status.device_id}${deviceOnline ? '' : '（离线或连接失效）'}` : '当前：现场直连'}</Tag>
        {actions}
      </div>
    </div>
      {status.remote && <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>管理与模块操作通过平台隧道发送到所选设备。断线后需重新连接。</Typography.Paragraph>}
      <Modal title={`SSH 终端 · ${status.device_id ?? ''}`} open={terminalOpen} width={1000} destroyOnHidden
        onCancel={() => { closeSsh(); setTerminalOpen(false); }} footer={null}>
        <Alert showIcon type={terminalError || sshError ? 'error' : sshConnected ? 'success' : 'info'}
          title={terminalError || sshError || sshStatusText} style={{ marginBottom: 12 }} />
        {!sshTargetReady && <Alert type="warning" title="当前设备连接或 SSH 权限已失效，请重新选择并连接在线设备" style={{ marginBottom: 12 }} />}
        <Space wrap style={{ marginBottom: 12 }}>
          <Input aria-label="SSH 账号" placeholder="SSH 账号" value={username} autoComplete="off" disabled={sshConnected || sshStarting} onChange={e => setUsername(e.target.value)} style={{ width: 180 }} />
          <Input.Password aria-label="SSH 密码" placeholder="SSH 密码（仅本次连接）" value={password} autoComplete="new-password" disabled={sshConnected || sshStarting} onChange={e => setPassword(e.target.value)} style={{ width: 230 }} />
          <Button type="primary" loading={sshStarting} disabled={!terminalReady || !sshTargetReady || !username.trim() || !password || sshConnected} onClick={() => void openSsh()}>登录</Button>
          <Button disabled={!sshConnected && !sshStarting} onClick={closeSsh}>断开</Button>
        </Space>
        {hostKey && <Alert type="warning" title="首次连接，请核对设备 SSH 主机指纹" description={<>
          <Typography.Paragraph copyable>{hostKey.fingerprint}</Typography.Paragraph>
          {!sshSessionId && <Typography.Paragraph>正在准备身份确认，请稍候</Typography.Paragraph>}
          <Space><Button disabled={!sshSessionId || trustBusy} loading={trustBusy} onClick={() => void trustHost(true)}>已核对，信任此设备</Button>
            <Button disabled={!sshSessionId || trustBusy} onClick={() => void trustHost(false)}>拒绝</Button></Space>
        </>} style={{ marginBottom: 12 }} />}
        <div ref={setTerminalElement} style={{ height: 460, background: '#000', padding: 8 }} />
      </Modal>
  </Card>;
}
