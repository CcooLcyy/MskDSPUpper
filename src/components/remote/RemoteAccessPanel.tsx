import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Modal, Select, Space, Tag, Typography, message } from 'antd';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { createSshOutputAcks } from '../../utils/remote-ssh-output';

interface Device {
  device_id: string; display_name: string; online: boolean;
  allow_grpc: boolean; allow_ssh: boolean; services: string[];
}
interface ConnectionStatus { remote: boolean; device_id: string | null; active: boolean }
type SshEvent = { type: 'host_key'; fingerprint: string; device_id: string }
  | { type: 'connected' } | { type: 'data'; bytes: number[] } | { type: 'closed'; message: string };

export default function RemoteAccessPanel({ directAddress, onModeChange, onConnected }: {
  directAddress: string; onModeChange: (remote: boolean) => void; onConnected: () => Promise<void>;
}) {
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
  const [messages, contextHolder] = message.useMessage();
  const terminalElement = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const session = useRef<string | null>(null);
  const sessionEpoch = useRef(0);
  const inputChain = useRef(Promise.resolve());
  const loadGeneration = useRef(0);
  const mounted = useRef(true);
  const desktop = '__TAURI_INTERNALS__' in window;
  const device = devices.find(d => d.device_id === selected);
  const connectedDevice = devices.find(d => d.device_id === status.device_id);
  const deviceOnline = status.active && connectedDevice?.online === true;

  const closeSsh = useCallback(() => {
    sessionEpoch.current += 1;
    const current = session.current;
    session.current = null;
    if (current) void invoke('remote_ssh_close', { sessionId: current }).catch(() => {});
    setPassword(''); setHostKey(null); setSshConnected(false); setSshStarting(false);
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
    if (!terminalOpen || !terminalElement.current) return;
    const term = new Terminal({ cursorBlink: true, convertEol: false, scrollback: 2000, fontSize: 14 });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(terminalElement.current); fit.fit();
    terminal.current = term;
    const observer = new ResizeObserver(() => {
      fit.fit();
      const current = session.current;
      if (current) void invoke('remote_ssh_resize', { sessionId: current, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    observer.observe(terminalElement.current);
    const listener = term.onData(data => {
      const current = session.current;
      if (!current) return;
      // 粘贴按 UTF-8 上限拆分并顺序发送，不并行重排用户输入。
      const chunks = data.match(/[\s\S]{1,8000}/gu) ?? [];
      inputChain.current = inputChain.current.then(async () => {
        for (const chunk of chunks) {
          if (session.current !== current) return;
          await invoke('remote_ssh_input', { sessionId: current, data: chunk });
        }
      }).catch(error => { term.writeln(`\r\n输入失败：${error}`); closeSsh(); });
    });
    return () => { listener.dispose(); observer.disconnect(); term.dispose(); terminal.current = null; };
  }, [terminalOpen, closeSsh]);

  async function connectDevice() {
    if (!selected) return;
    setBusy(true); closeSsh();
    try {
      await invoke('remote_select_device', { deviceId: selected });
      await load();
      if (device?.allow_grpc) await onConnected();
      messages.success(`已选择远程设备：${device?.display_name ?? selected}`);
    } catch (error) { messages.error(`远程连接失败：${error}`); }
    finally { setBusy(false); }
  }
  async function returnToDirect() {
    setBusy(true); closeSsh();
    try { await invoke('remote_use_direct', { address: directAddress }); await load(); await onConnected(); }
    catch (error) { messages.error(`切换直连失败：${error}`); }
    finally { setBusy(false); }
  }
  async function openSsh() {
    if (!terminal.current || !status.remote || status.device_id !== selected) return;
    closeSsh(); const epoch = sessionEpoch.current;
    setSshStarting(true); terminal.current.reset();
    let finished = false;
    const outputAcks = createSshOutputAcks(
      id => { void invoke('remote_ssh_ack', { sessionId: id }).catch(() => {}); },
      () => epoch === sessionEpoch.current && mounted.current,
    );
    const events = new Channel<SshEvent>();
    events.onmessage = event => {
      if (epoch !== sessionEpoch.current || !mounted.current) return;
      if (event.type === 'host_key') setHostKey(event);
      if (event.type === 'connected') { setSshConnected(true); setSshStarting(false); terminal.current?.focus(); }
      if (event.type === 'data') terminal.current?.write(new Uint8Array(event.bytes), outputAcks.consumed);
      if (event.type === 'closed') {
        finished = true;
        terminal.current?.writeln(`\r\n${event.message}`);
        session.current = null; setSshConnected(false); setSshStarting(false); setHostKey(null);
      }
    };
    try {
      const id = await invoke<string>('remote_ssh_open', { username, password, cols: terminal.current.cols, rows: terminal.current.rows, events });
      if (epoch !== sessionEpoch.current || finished) { void invoke('remote_ssh_close', { sessionId: id }).catch(() => {}); return; }
      session.current = id;
      outputAcks.bind(id);
    } catch (error) {
      if (epoch === sessionEpoch.current) { messages.error(`打开 SSH 失败：${error}`); setSshStarting(false); }
    } finally { if (epoch === sessionEpoch.current) setPassword(''); }
  }
  async function trustHost(accept: boolean) {
    const current = session.current;
    if (!current) return;
    try { await invoke('remote_ssh_trust', { sessionId: current, accept }); setHostKey(null); }
    catch (error) { messages.error(`确认主机失败：${error}`); }
  }

  return <Card size="small" title="平台远程设备" style={{ marginBottom: 12 }}>
    {contextHolder}
    {!desktop ? <Alert type="info" title="平台远程设备与 SSH 终端需要桌面版上位机" /> : <>
      <Space wrap>
        <Select style={{ minWidth: 300 }} placeholder="选择授权设备" value={selected} disabled={busy}
          onChange={value => { closeSsh(); setSelected(value); }}
          options={devices.map(d => ({ value: d.device_id, label: `${d.display_name || d.device_id} · ${d.online ? '在线' : '离线'}` }))} />
        <Button onClick={() => void load().catch(error => messages.error(String(error)))}>刷新设备</Button>
        <Button type="primary" loading={busy} disabled={!device?.online} onClick={() => void connectDevice()}>连接所选设备</Button>
        <Button disabled={!status.remote || busy} onClick={() => void returnToDirect()}>返回现场直连</Button>
        <Button disabled={!device?.allow_ssh || !device.services.includes('ssh') || !deviceOnline || status.device_id !== selected}
          onClick={() => setTerminalOpen(true)}>SSH 终端</Button>
        <Tag color={status.remote ? (deviceOnline ? 'blue' : 'red') : 'default'}>{status.remote ? `平台设备：${status.device_id}${deviceOnline ? '' : '（离线或连接失效）'}` : '现场直连'}</Tag>
      </Space>
      {status.remote && <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>管理与模块操作通过平台隧道发送到所选设备。断线后需重新连接。</Typography.Paragraph>}
      <Modal title={`SSH 终端 · ${status.device_id ?? ''}`} open={terminalOpen} width={1000} destroyOnHidden
        onCancel={() => { closeSsh(); setTerminalOpen(false); }} footer={null}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Input aria-label="SSH 账号" placeholder="SSH 账号" value={username} autoComplete="off" disabled={sshConnected || sshStarting} onChange={e => setUsername(e.target.value)} style={{ width: 180 }} />
          <Input.Password aria-label="SSH 密码" placeholder="SSH 密码（仅本次连接）" value={password} autoComplete="new-password" disabled={sshConnected || sshStarting} onChange={e => setPassword(e.target.value)} style={{ width: 230 }} />
          <Button type="primary" loading={sshStarting} disabled={!username.trim() || !password || sshConnected} onClick={() => void openSsh()}>登录</Button>
          <Button disabled={!sshConnected && !sshStarting} onClick={closeSsh}>断开</Button>
        </Space>
        {hostKey && <Alert type="warning" title="首次连接，请核对设备 SSH 主机指纹" description={<>
          <Typography.Paragraph copyable>{hostKey.fingerprint}</Typography.Paragraph>
          <Space><Button onClick={() => void trustHost(true)}>已核对，信任此设备</Button><Button onClick={() => void trustHost(false)}>拒绝</Button></Space>
        </>} style={{ marginBottom: 12 }} />}
        <div ref={terminalElement} style={{ height: 460, background: '#000', padding: 8 }} />
      </Modal>
    </>}
  </Card>;
}
