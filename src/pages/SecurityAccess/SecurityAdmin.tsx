import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Popconfirm, Select, Space, Table } from 'antd';
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
  const [certificateType, setCertificateType] = useState(0);
  const [masterType, setMasterType] = useState(5);
  const active = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const blocked = busy || disabled;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  useEffect(() => {
    generation.current += 1;
    active.current = false;
    setBusy(false); setError(null); setNotice(null); setWarning(null);
    setCertificates([]); setListed(false);
    onBusyChange?.(false);
    return () => { generation.current += 1; onBusyChange?.(false); };
  }, [sessionId, onBusyChange]);

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

  return <section className="security-admin" aria-label="纵密系统管理员工作台" aria-busy={busy}>
    <Card title="初始化网关">
      <p>点击导出时自动生成 SM2 密钥并导出证书申请文件；装置确认密钥已存在时继续使用现有密钥。</p>
      <Button type="primary" disabled={blocked} onClick={exportCsr}>导出 SM2 CSR</Button>
    </Card>
    <Card title="证书管理" extra={<Button disabled={blocked} onClick={() => run(refresh)}>刷新证书列表</Button>}>
      <div className="security-admin-import"><strong>主站证书</strong><span>请按证书用途选择类别，再选择文件导入。</span><Space wrap><Select aria-label="主站证书类别" value={masterType} options={CERTIFICATE_TYPES.filter(item => item.value === 4 || item.value === 5).map(item => item.value === 5 ? { ...item, label: '加密网关证书（隧道对端）' } : item)} onChange={setMasterType} disabled={blocked} /><Button type="primary" disabled={blocked} onClick={() => importCertificate(masterType)}>导入主站证书</Button></Space><small>当前类别：{CERTIFICATE_TYPES[masterType].label}（类型 {masterType}）</small></div>
      <details className="security-admin-advanced"><summary>其他证书导入</summary><Space wrap><Select aria-label="通用证书类别" value={certificateType} options={CERTIFICATE_TYPES} onChange={setCertificateType} disabled={blocked} /><Button disabled={blocked} onClick={() => importCertificate(certificateType)}>导入所选类别证书</Button></Space></details>
      <Table<Certificate> size="small" rowKey={item => `${item.certificate_type}:${item.name}`} dataSource={certificates} pagination={false} scroll={{ x: 600 }} locale={{ emptyText: listed ? '装置未返回证书记录' : '请刷新证书列表' }} columns={[
        { title: '证书名称', dataIndex: 'name', ellipsis: true },
        { title: '类别', dataIndex: 'certificate_type', render: type => CERTIFICATE_TYPES[type]?.label ?? `未知类别 ${type}` },
        { title: '操作', width: 140, render: (_, certificate) => <Space size="small"><Button size="small" disabled={blocked} onClick={() => exportCertificate(certificate)}>导出</Button><Popconfirm title={`删除证书 ${certificate.name}？`} description="删除会影响装置使用该证书的业务。" okText="删除" cancelText="取消" disabled={blocked} onConfirm={() => deleteCertificate(certificate)}><Button size="small" danger disabled={blocked}>删除</Button></Popconfirm></Space> },
      ]} />
    </Card>
    {busy && <p role="status">正在处理管理员操作，请等待装置应答…</p>}
    {error && <Alert type="error" showIcon title={error} />}
    {warning && <Alert type="warning" showIcon title={warning} />}
    {notice && <Alert type="info" showIcon title={notice} />}
  </section>;
}
