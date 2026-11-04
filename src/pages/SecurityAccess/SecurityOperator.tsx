import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag } from 'antd';
import { api } from '../../adapters';
import type { VerticalSecurityOperatorKind as Kind, VerticalSecurityOperatorRow as Row, VerticalSecurityOperatorResult as Result } from '../../adapters';
import './SecurityOperator.css';

type Field = { key: string; label: string; optional?: boolean; options?: [string, string][]; reference?: 'interfaces' | 'certificates' | 'tunnel_ids' };
const tunnelModes: [string, string][] = [['0', '加密'], ['1', '选择性加密'], ['2', '明通']];
const policyModes: [string, string][] = [['0', '加密'], ['1', '明文'], ['2', '选择性加密']];
const pages: { key: Kind; label: string; fields: Field[] }[] = [
  { key: 'network', label: '网络配置', fields: [
    { key: 'description', label: '描述' }, { key: 'interface', label: '接口' },
    { key: 'interface_type', label: '接口类型', options: [['PRIVATE', '内网'], ['PUBLIC', '外网'], ['BACKUP', '备用'], ['CONFIG', '管理'], ['BRIDGE', '桥接']] },
    { key: 'ip', label: 'IP 地址' }, { key: 'netmask', label: '子网掩码' }, { key: 'vlan', label: 'VLAN' },
  ] },
  { key: 'routes', label: '路由配置', fields: [
    { key: 'name', label: '名称' }, { key: 'interface', label: '出口接口', reference: 'interfaces' }, { key: 'vlan', label: 'VLAN' },
    { key: 'destination', label: '目的地址' }, { key: 'netmask', label: '目的掩码' }, { key: 'gateway', label: '网关' },
    { key: 'table_id', label: '路由表 ID（策略路由）', optional: true }, { key: 'source', label: '源地址（策略路由）', optional: true }, { key: 'source_mask', label: '源掩码（策略路由）', optional: true },
  ] },
  { key: 'tunnels', label: '隧道配置', fields: [
    { key: 'name', label: '名称' }, { key: 'id', label: '隧道 ID' }, { key: 'mode', label: '模式', options: tunnelModes },
    { key: 'local_ip', label: '本端地址' }, { key: 'primary_ip', label: '对端主地址' }, { key: 'primary_certificate', label: '主装置证书', reference: 'certificates' },
    { key: 'backup_ip', label: '对端备地址' }, { key: 'backup_certificate', label: '备装置证书', reference: 'certificates' },
    { key: 'lifetime', label: '周期（小时）' }, { key: 'capacity', label: '容量' },
  ] },
  { key: 'policies', label: '策略配置', fields: [
    { key: 'id', label: '策略 ID' }, { key: 'tunnel_id', label: '隧道 ID', reference: 'tunnel_ids' }, { key: 'mode', label: '模式', options: policyModes },
    { key: 'source_start', label: '内网起始地址' }, { key: 'source_end', label: '内网终止地址' },
    { key: 'destination_start', label: '外网起始地址' }, { key: 'destination_end', label: '外网终止地址' },
    { key: 'protocol', label: '协议', options: [['0', '全部'], ['1', 'ICMP'], ['2', 'TCP'], ['3', 'UDP']] },
    { key: 'direction', label: '方向', options: [['1', '安全域到非安全域'], ['2', '非安全域到安全域'], ['0', '双向']] },
    { key: 'source_port_start', label: '内网起始端口' }, { key: 'source_port_end', label: '内网终止端口' },
    { key: 'destination_port_start', label: '外网起始端口' }, { key: 'destination_port_end', label: '外网终止端口' }, { key: 'description', label: '描述', optional: true },
  ] },
];
type Draft = { result: Result | null; rows: Row[]; dirty: boolean; stale: boolean };
const emptyDraft = (): Draft => ({ result: null, rows: [], dirty: false, stale: false });
const emptyPages = (): Record<Kind, Draft> => ({ network: emptyDraft(), routes: emptyDraft(), tunnels: emptyDraft(), policies: emptyDraft() });
const cloneRows = (rows: Row[]): Row[] => rows.map(row => ({ ...row }));

export default function SecurityOperator({ sessionId, disabled = false, onBusyChange }: { sessionId: string; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [kind, setKind] = useState<Kind>('network');
  const [drafts, setDrafts] = useState(emptyPages);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ index: number | null; row: Row } | null>(null);
  const [confirm, setConfirm] = useState<'read' | 'save' | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const active = useRef(false);
  const currentSession = useRef(sessionId);
  const notifyBusy = useEffectEvent((value: boolean) => onBusyChange?.(value));
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  useEffect(() => {
    currentSession.current = sessionId;
    generation.current += 1; active.current = false;
    setDrafts(emptyPages()); setKind('network'); setEditor(null); setConfirm(null);
    setBusy(false); setError(null); setNotice(null); notifyBusy(false);
    return () => { generation.current += 1; notifyBusy(false); };
  }, [sessionId]);
  const page = pages.find(item => item.key === kind)!;
  const draft = drafts[kind];
  const blocked = busy || disabled;
  const unavailable = blocked || !draft.result || draft.stale;
  const updateRows = (rows: Row[]) => {
    if (unavailable || active.current || !mounted.current || currentSession.current !== sessionId) return;
    setDrafts(previous => ({ ...previous, [kind]: { ...previous[kind], rows, dirty: true } }));
    setNotice(null); setError(null);
  };
  const perform = async (action: 'read' | 'save') => {
    if (!mounted.current || active.current || disabled || !sessionId || currentSession.current !== sessionId) return;
    if (action === 'save' && (!draft.result || draft.stale || !draft.dirty)) return;
    const token = generation.current;
    const current = () => mounted.current && token === generation.current && currentSession.current === sessionId;
    active.current = true; setBusy(true); onBusyChange?.(true); setConfirm(null); setError(null); setNotice(null);
    try {
      const result = await api.runVerticalSecurityOperator({ session_id: sessionId, action, kind, ...(action === 'save' ? { revision: draft.result!.revision, rows: cloneRows(draft.rows) } : {}) });
      if (!current()) return;
      if (result.kind !== kind || !result.revision || !Array.isArray(result.rows)) throw new Error('装置配置结果不完整，请重新读取。');
      if (action === 'save' && !result.verified) throw new Error(result.message || '上传结果未完成回读核对，请重新读取后核实。');
      setDrafts(previous => {
        const next = { ...previous, [kind]: { result, rows: cloneRows(result.rows), dirty: false, stale: false } };
        // 网络和隧道变更会影响其他页引用；保留其草稿，重新读取后才能上传。
        if (action === 'save' && kind === 'network') next.routes = { ...next.routes, stale: true };
        if (action === 'save' && kind === 'tunnels') next.policies = { ...next.policies, stale: true };
        return next;
      });
      setNotice(action === 'save' ? '配置已上传并回读核对一致；业务生效情况请结合实际通信确认。' : '已读取装置配置。');
    } catch (reason) {
      if (current()) {
        setError(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '配置操作失败，请核实装置状态。');
        setDrafts(previous => ({ ...previous, [kind]: { ...previous[kind], stale: true } }));
      }
    } finally {
      if (current()) { active.current = false; setBusy(false); onBusyChange?.(false); }
    }
  };
  const read = () => { if (!blocked) { if (draft.dirty) setConfirm('read'); else return perform('read'); } };
  const startEdit = (index: number | null) => {
    if (unavailable || active.current || !mounted.current || currentSession.current !== sessionId) return;
    setError(null);
    const row = index === null ? Object.fromEntries(page.fields.map(field => [field.key, field.options?.[0]?.[0] ?? ''])) : { ...draft.rows[index] };
    if (index === null && kind === 'network') Object.assign(row, { description: 'network', vlan: '0' });
    if (index === null && kind === 'routes') Object.assign(row, { vlan: '0' });
    if (index === null && kind === 'tunnels') Object.assign(row, { backup_ip: '0.0.0.0', primary_certificate: draft.result?.certificates[0] ?? 'cert1.pem', backup_certificate: 'cert2.pem', lifetime: '10000', capacity: '5000000' });
    setEditor({ index, row });
  };
  const choices = (field: Field) => {
    const options = field.reference ? (draft.result?.[field.reference] ?? []).map(value => ({ value, label: value })) : (field.options ?? []).filter(([value]) => !(kind === 'policies' && field.key === 'direction' && value === '0' && !draft.result?.bidirectional_allowed)).map(([value, label]) => ({ value, label }));
    const existing = editor?.row[field.key];
    // 未知值显式保留展示，不能静默替换成默认枚举或另一张证书。
    if (existing && !options.some(option => option.value === existing)) options.push({ value: existing, label: `${existing}（原值，需核实）` });
    return options;
  };
  const applyEdit = () => {
    if (!editor || unavailable) return;
    for (const field of page.fields) {
      const value = editor.row[field.key] ?? '';
      if ((!field.optional && !value.trim()) || [...value].some(char => char === ',' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) { setError(`请检查“${field.label}”，必填内容不能为空，也不能包含逗号或控制字符。`); return; }
      if (kind === 'network' && field.key === 'description' && (value.length > 10 || [...value].some(char => char.charCodeAt(0) > 126))) { setError('网络描述请使用最多 10 个英文字符、数字或符号。'); return; }
      const unusedCertificate = kind === 'tunnels' && field.reference === 'certificates' && (editor.row.mode === '2' || (field.key === 'backup_certificate' && editor.row.backup_ip === '0.0.0.0'));
      if (!unusedCertificate && (field.options || field.reference) && !choices(field).some(option => option.value === value && !option.label.endsWith('（原值，需核实）'))) { setError(`“${field.label}”原值不在当前装置可选范围，请核实后选择。`); return; }
    }
    const rows = cloneRows(draft.rows);
    if (editor.index === null) rows.push({ ...editor.row }); else rows[editor.index] = { ...editor.row };
    updateRows(rows); setEditor(null);
  };
  const move = (index: number, offset: number) => {
    if (index + offset < 0 || index + offset >= draft.rows.length) return;
    const rows = cloneRows(draft.rows);
    [rows[index], rows[index + offset]] = [rows[index + offset], rows[index]];
    updateRows(rows);
  };
  return <section className="security-operator" aria-label="纵密安全操作员工作台" aria-busy={busy}>
    <Tabs activeKey={kind} onChange={value => { if (!disabled && !active.current) { setKind(value as Kind); setEditor(null); setConfirm(null); setError(null); setNotice(null); } }} items={pages.map(item => ({ key: item.key, label: item.label, disabled: blocked }))} />
    <Card className="security-operator-panel">
      <div className="security-operator-toolbar"><div><h3>{page.label}</h3><p>{!draft.result ? '先读取装置配置，再进行编辑。' : draft.stale ? '当前结果需重新读取核实；草稿已保留。' : draft.dirty ? '草稿尚未上传，其他页面的草稿会保留。' : '显示最近一次读取的装置配置。'}</p></div><Space wrap>
        <Button disabled={blocked} onClick={read}>读取配置</Button>
        <Button disabled={unavailable} onClick={() => startEdit(null)}>新增</Button>
        <Button type="primary" disabled={unavailable || !draft.dirty} onClick={() => setConfirm('save')}>上传配置</Button>
      </Space></div>
      {draft.dirty && <Tag color="warning">未上传的草稿</Tag>}
      <Table<{ row: Row; index: number }> size="small" rowKey="index" dataSource={draft.rows.map((row, index) => ({ row, index }))} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: Math.max(900, page.fields.length * 140) }} locale={{ emptyText: draft.result ? '暂无配置' : '请先读取配置' }} columns={[
        ...page.fields.map(field => ({ title: field.label, dataIndex: ['row', field.key], width: 140, ellipsis: true, render: (value: string) => field.options?.find(([code]) => code === value)?.[1] ?? (value || '—') })),
        { title: '操作', key: 'actions', width: kind === 'policies' ? 250 : 140, fixed: 'right' as const, render: (_: unknown, entry: { row: Row; index: number }) => <Space size="small"><Button size="small" disabled={unavailable} onClick={() => startEdit(entry.index)}>编辑</Button><Popconfirm title="从草稿删除此配置？" description="上传后才会改变装置配置。" disabled={unavailable} onConfirm={() => updateRows(draft.rows.filter((_, index) => index !== entry.index))}><Button size="small" danger disabled={unavailable}>删除</Button></Popconfirm>{kind === 'policies' && <><Button size="small" disabled={unavailable || entry.index === 0} onClick={() => move(entry.index, -1)}>上移</Button><Button size="small" disabled={unavailable || entry.index === draft.rows.length - 1} onClick={() => move(entry.index, 1)}>下移</Button></>}</Space> },
      ]} />
    </Card>
    {editor && <Modal title={`${editor.index === null ? '新增' : '编辑'}${page.label}`} open width={760} onCancel={() => setEditor(null)} okText="确认草稿" cancelText="取消" onOk={applyEdit} okButtonProps={{ disabled: unavailable }}>
      {kind === 'network' && <p>网络描述请使用最多 10 个英文字符、数字或符号。</p>}
      <div className="security-operator-fields">{page.fields.map(field => <label key={field.key}><span>{field.label}{field.optional ? '（选填）' : ''}</span>{field.options || field.reference ? <Select aria-label={field.label} value={editor.row[field.key] || undefined} options={choices(field)} disabled={unavailable} onChange={value => setEditor(previous => previous ? { ...previous, row: { ...previous.row, [field.key]: value } } : null)} /> : <Input aria-label={field.label} value={editor.row[field.key] ?? ''} maxLength={256} disabled={unavailable} onChange={event => setEditor(previous => previous ? { ...previous, row: { ...previous.row, [field.key]: event.target.value } } : null)} />}</label>)}</div>
      {error && <Alert type="error" showIcon title={error} />}
    </Modal>}
    {confirm && <Modal title={confirm === 'read' ? '重新读取并放弃本页草稿？' : `上传${page.label}？`} open okText={confirm === 'read' ? '放弃并读取' : '确认上传'} cancelText="取消" onCancel={() => setConfirm(null)} onOk={() => perform(confirm)} okButtonProps={{ disabled: blocked }}>
      <p>{confirm === 'read' ? '将用装置当前配置替换本页草稿，其他页面的草稿保留。' : `将上传本页全部 ${draft.rows.length} 条配置，包括草稿中的删除。`}</p>
      {confirm === 'save' && <Alert type="warning" showIcon title={kind === 'network' || kind === 'routes' ? '网络或路由变化可能中断当前管理连接及业务通信。' : '配置变化可能影响现有业务通信。'} description="上传失败或断开时保留草稿，不自动重试；请重新读取并核实装置状态。" />}
    </Modal>}
    {busy && <p role="status">正在处理配置，请等待装置应答…</p>}
    {error && !editor && <Alert type="error" showIcon title={error} />}
    {notice && <Alert type="info" showIcon title={notice} />}
  </section>;
}
