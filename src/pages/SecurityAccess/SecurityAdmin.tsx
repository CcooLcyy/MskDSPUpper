import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Modal, Popconfirm, Segmented, Select, Space, Table, Tabs, Tag } from 'antd';
import type { VerticalSecurityTunnelStatus } from '../../adapters';
import { api } from '../../adapters';
import './SecurityAdmin.css';

const CERTIFICATE_TYPES = ['一级 CA 证书', '二级 CA 证书', '主操作员证书', '备操作员证书', '装置管理系统证书', '加密网关证书'].map((label, value) => ({ label, value }));
type Certificate = { name: string; certificate_type: number };
type AdminRequest = Parameters<typeof api.runVerticalSecurityAdmin>[0];

export default function SecurityAdmin({ sessionId, disabled = false, onBusyChange }: {
  sessionId: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [listed, setListed] = useState(false);
  const [certificateType, setCertificateType] = useState(5);
  const [importOpen, setImportOpen] = useState(false);
  const [page, setPage] = useState('certificates');
  const [view, setView] = useState<string>('list');
  const [tunnels, setTunnels] = useState<VerticalSecurityTunnelStatus[]>([]);
  const [tunnelRead, setTunnelRead] = useState<'pending' | 'ready' | 'failed'>('pending');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [selectedTunnel, setSelectedTunnel] = useState<number | null>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const initialListStarted = useRef(false);
  const blocked = busy || disabled;
  const notifyBusy = useEffectEvent((value: boolean) => onBusyChange?.(value));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  useEffect(() => {
    generation.current += 1;
    active.current = false;
    initialListStarted.current = false;
    setBusy(false); setError(null); setNotice(null); setWarning(null);
    setCertificates([]); setListed(false); setImportOpen(false); setCertificateType(5);
    setTunnels([]); setTunnelRead('pending'); setUpdatedAt(null); setSelectedTunnel(null); setPage('certificates'); setView('list');
    notifyBusy(false);
    return () => { generation.current += 1; notifyBusy(false); };
  }, [sessionId]);

  const run = async (work: (current: () => boolean) => Promise<void>) => {
    if (!mounted.current || disabled || active.current || !sessionId) return;
    const token = generation.current;
    const current = () => mounted.current && token === generation.current;
    active.current = true; setBusy(true); onBusyChange?.(true);
    setError(null); setNotice(null); setWarning(null);
    try { await work(current); }
    catch (reason) {
      if (current()) {
        setError(reason instanceof Error ? reason.message : typeof reason === 'string' && reason.trim() ? reason : '纵密管理员操作失败，请核实装置状态后重试。');
        console.warn('[纵密管理员] 操作失败，请核实装置应答');
      }
    } finally {
      if (current()) { active.current = false; setBusy(false); onBusyChange?.(false); }
    }
  };
  const request = async (value: Omit<AdminRequest, 'session_id'>) => {
    console.info('[纵密管理员] 请求装置操作', { action: value.action });
    return api.runVerticalSecurityAdmin({ session_id: sessionId, ...value });
  };
  const refresh = async (current: () => boolean) => {
    const value = await request({ action: 'list_certificates' });
    if (current()) { setCertificates(value.certificates); setListed(true); }
  };
  const loadInitialCertificates = useEffectEvent(() => {
    if (!mounted.current || disabled || active.current || initialListStarted.current || !sessionId) return;
    initialListStarted.current = true;
    console.info('[纵密管理员] 进入会话，自动读取证书列表');
    void run(refresh);
  });
  useEffect(() => {
    if (disabled || !sessionId) return;
    let cancelled = false;
    // 延后到微任务，StrictMode 首轮清理可取消尚未发送的读取。
    queueMicrotask(() => { if (!cancelled) loadInitialCertificates(); });
    return () => { cancelled = true; };
  }, [sessionId, disabled]);
  const exportCsr = () => run(async current => {
    const value = await request({ action: 'export_csr' });
    if (!current()) return;
    if (!value.data?.length) throw new Error('装置未返回 CSR 文件，未保存。');
    let ip: string | null = null;
    try { ip = await api.getVerticalSecuritySimIp(); } catch { /* SIM IP 获取失败不阻止保存已获得的 CSR。 */ }
    if (!current()) return;
    const octets = ip?.split('.').map(Number);
    const validIp = ip && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && octets?.every(part => part <= 255)
      && octets[0] > 0 && octets[0] < 224 && octets[0] !== 127 && !(octets[0] === 169 && octets[1] === 254) ? ip : null;
    if (!validIp) setWarning('无法获取当前 DSP 的 SIM IP，CSR 将使用 SM2.csr 文件名。');
    const path = await api.saveVerticalSecurityFile({ name: validIp ? `${validIp}_SM2.csr` : 'SM2.csr', data: value.data });
    if (current()) setNotice(path ? 'CSR 已保存。' : '已取消保存 CSR。');
  });
  const importCertificate = (type: number) => run(async current => {
    const file = await api.chooseVerticalSecurityCertificateFile();
    if (!current() || !file) return;
    const value = await request({ action: 'import_certificate', certificate_type: type, name: file.name, data: file.data });
    if (!current()) return;
    setNotice(value.message);
    setImportOpen(false);
    await refresh(current);
  });
  const exportCertificate = (certificate: Certificate) => run(async current => {
    const value = await request({ action: 'read_certificate', ...certificate });
    if (!current()) return;
    if (!value.data?.length) throw new Error('装置未返回证书内容。');
    const name = certificate.name.split(/[\\/]/).pop() || 'certificate.cer';
    const path = await api.saveVerticalSecurityFile({ name, data: value.data });
    if (current()) setNotice(path ? '证书已导出。' : '已取消导出证书。');
  });
  const deleteCertificate = (certificate: Certificate) => run(async current => {
    const value = await request({ action: 'delete_certificate', ...certificate });
    if (!current()) return;
    setNotice(value.message);
    await refresh(current);
  });

  const refreshTunnels = () => run(async current => {
    setSelectedTunnel(null);
    try {
      const value = await request({ action: 'list_tunnels' });
      if (current()) { setTunnels(value.tunnels); setTunnelRead('ready'); setUpdatedAt(new Date().toLocaleString()); }
    } catch (reason) {
      if (current()) setTunnelRead('failed');
      throw reason;
    }
  });
  const resetTunnel = () => run(async current => {
    if (selectedTunnel === null || tunnelRead !== 'ready' || !tunnels.some(item => item.id === selectedTunnel)) return;
    await request({ action: 'reset_tunnel', tunnel_id: selectedTunnel });
    if (current()) { setNotice('重置命令已受理，请刷新核对隧道状态。'); setSelectedTunnel(null); }
  });
  const tunnelEmpty = tunnelRead === 'failed' ? '隧道读取失败，请重新刷新' : tunnelRead === 'ready' ? '装置当前没有隧道' : '请刷新隧道状态';
  const tunnelState = (state: number) => ({ 0: '未连接', 1: '连接中', 2: '连接中', 3: '已连接' })[state] ?? `未知状态（${state}）`;
  const hotState = (state: number) => state === 1 ? '主用' : state === 0 ? '备用' : `未知（${state}）`;
  const stateTag = (state: number) => <Tag color={state === 3 ? 'success' : state === 1 || state === 2 ? 'processing' : 'default'}>{tunnelState(state)}</Tag>;

  return <section className="security-admin" aria-label="纵密系统管理员工作台" aria-busy={busy}>
    <Tabs activeKey={page} onChange={next => { setPage(next); setImportOpen(false); setSelectedTunnel(null); }} items={[{ key: 'certificates', label: '初始化与证书' }, { key: 'tunnels', label: '隧道管理' }]} />
    {page === 'certificates' && <Card className="security-admin-panel">
      <div className="security-admin-initialize"><div><h3>初始化网关</h3><p>导出证书申请文件时准备 SM2 密钥；已有密钥继续使用。</p></div><Button type="primary" disabled={blocked} onClick={exportCsr}>导出 SM2 CSR</Button></div>
      <div className="security-admin-toolbar"><h3>证书管理</h3><Space wrap><Button disabled={blocked} onClick={() => run(refresh)}>刷新证书列表</Button><Button type="primary" disabled={blocked} onClick={() => setImportOpen(true)}>导入证书</Button></Space></div>
      <Table<Certificate> size="small" rowKey={item => `${item.certificate_type}:${item.name}`} dataSource={certificates} pagination={false} scroll={{ x: 600 }} locale={{ emptyText: listed ? '装置未返回证书记录' : '请刷新证书列表' }} columns={[
        { title: '证书名称', dataIndex: 'name', ellipsis: true },
        { title: '类别', dataIndex: 'certificate_type', render: type => CERTIFICATE_TYPES[type]?.label ?? `未知类别 ${type}` },
        { title: '操作', width: 140, render: (_, certificate) => <Space size="small"><Button size="small" disabled={blocked} onClick={() => exportCertificate(certificate)}>导出</Button><Popconfirm title={`删除证书 ${certificate.name}？`} description="删除会影响装置使用该证书的业务。" okText="删除" cancelText="取消" disabled={blocked} onConfirm={() => deleteCertificate(certificate)}><Button size="small" danger disabled={blocked}>删除</Button></Popconfirm></Space> },
      ]} />
    </Card>}
    {importOpen && <Modal title="导入证书" open onCancel={() => { if (!blocked) setImportOpen(false); }} closable={!blocked} mask={{ closable: !blocked }} okText="选择文件并导入" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: blocked }} cancelButtonProps={{ disabled: blocked }} onOk={() => importCertificate(certificateType)}>
      <label className="security-admin-import">证书用途<Select aria-label="证书用途" value={certificateType} options={CERTIFICATE_TYPES.map(item => item.value === 5 ? { ...item, label: '加密网关证书（隧道对端）' } : item)} onChange={setCertificateType} disabled={blocked} /></label>
      <p>主站隧道对端通常使用加密网关证书，请按证书用途选择类别。</p>
    </Modal>}
    {page === 'tunnels' && <Card className="security-admin-panel">
      <div className="security-admin-toolbar"><div><h3>隧道管理</h3><span className="security-admin-update">{updatedAt ? `最后刷新：${updatedAt}` : '尚未读取装置隧道状态'}</span></div><Space wrap><Segmented aria-label="隧道展示方式" value={view} options={[{ label: '列表', value: 'list' }, { label: '图示', value: 'diagram' }]} onChange={setView} /><Button disabled={blocked} onClick={refreshTunnels}>刷新隧道</Button><Popconfirm title={`重置隧道 ${selectedTunnel ?? ''}？`} description="可能短暂中断该隧道业务；命令受理后请刷新核对状态。" okText="重置" cancelText="取消" disabled={blocked || selectedTunnel === null || tunnelRead !== 'ready'} onConfirm={resetTunnel}><Button danger disabled={blocked || selectedTunnel === null || tunnelRead !== 'ready'}>重置选中隧道</Button></Popconfirm></Space></div>
      {tunnelRead === 'failed' && tunnels.length > 0 && <Alert type="warning" showIcon title="刷新失败，以下为上次读取的快照，当前状态未确认。" />}
      {view === 'list' ? <Table<VerticalSecurityTunnelStatus> size="small" rowKey="id" dataSource={tunnels} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 1320 }} locale={{ emptyText: tunnelEmpty }} rowSelection={{ type: 'radio', selectedRowKeys: selectedTunnel === null ? [] : [selectedTunnel], onChange: keys => setSelectedTunnel(keys.length ? Number(keys[0]) : null), getCheckboxProps: () => ({ disabled: blocked || tunnelRead !== 'ready' }) }} columns={[
        { title: 'ID', dataIndex: 'id', width: 65 },
        { title: '状态', dataIndex: 'state', width: 115, render: stateTag },
        { title: '热备', dataIndex: 'hot_state', width: 90, render: hotState },
        { title: '本端地址', dataIndex: 'local_ip', width: 145 },
        { title: '对端地址', dataIndex: 'peer_ip', width: 145 },
        { title: '加密次数', dataIndex: 'encrypt_count', width: 130 },
        { title: '解密次数', dataIndex: 'decrypt_count', width: 130 },
        { title: '加密错误次数', dataIndex: 'encrypt_errors', width: 115 },
        { title: '解密错误次数', dataIndex: 'decrypt_errors', width: 115 },
        { title: '算法', dataIndex: 'algorithm', width: 100, render: value => value || '未提供' },
        { title: '错误信息', dataIndex: 'error_info', width: 180, render: value => value || '未提供' },
      ]} /> : tunnels.length === 0 ? <Empty description={tunnelEmpty} /> : <div className="security-tunnel-diagram">{tunnels.map(tunnel => <button key={tunnel.id} type="button" className={`security-tunnel-link${selectedTunnel === tunnel.id ? ' is-selected' : ''}`} aria-label={`隧道 ${tunnel.id} 图示`} aria-pressed={selectedTunnel === tunnel.id} disabled={blocked || tunnelRead !== 'ready'} onClick={() => setSelectedTunnel(tunnel.id)}><span className="security-tunnel-endpoint"><strong>本端</strong><span>{tunnel.local_ip}</span></span><span className="security-tunnel-connection"><strong>隧道 {tunnel.id}</strong>{stateTag(tunnel.state)}<span>{hotState(tunnel.hot_state)} →</span></span><span className="security-tunnel-endpoint"><strong>对端</strong><span>{tunnel.peer_ip}</span></span></button>)}</div>}
    </Card>}
    {busy && <p role="status">正在处理管理员操作，请等待装置应答…</p>}
    {error && <Alert type="error" showIcon title={error} />}
    {warning && <Alert type="warning" showIcon title={warning} />}
    {notice && <Alert type="info" showIcon title={notice} />}
  </section>;
}
