import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag } from 'antd';
import { api } from '../../adapters';
import type { VerticalSecurityOperatorKind as Kind, VerticalSecurityOperatorRow as Row, VerticalSecurityOperatorResult as Result } from '../../adapters';
import { buildAutoConfig, getAppliedSecurityNetwork, uploadAutoConfig, type AutoConfigAddresses } from '../../utils/vertical-security-auto-config';
import './SecurityOperator.css';

type Field = { key: string; label: string; optional?: boolean; options?: [string, string][]; reference?: 'interfaces' | 'certificates' | 'tunnel_ids'; numeric?: [number, number]; address?: 'ip' | 'mask' };
const networkInterfaces: [string, string][] = ['eth1', 'eth2', 'eth3', 'eth4', 'eth5', 'BRIDGE'].map(value => [value, value === 'BRIDGE' ? 'BRIDGE（桥接）' : value]);
const routeAdvancedKeys = ['table_id', 'source', 'source_mask'];
const tunnelModes: [string, string][] = [['0', '加密'], ['1', '选择性加密'], ['2', '明通']];
const policyModes: [string, string][] = [['0', '加密'], ['1', '明文'], ['2', '选择性加密']];
const pages: { key: Kind; label: string; fields: Field[] }[] = [
  { key: 'network', label: '网络配置', fields: [
    { key: 'description', label: '描述' }, { key: 'interface', label: '接口', options: networkInterfaces },
    { key: 'interface_type', label: '接口类型', options: [['PRIVATE', '内网'], ['PUBLIC', '外网'], ['BACKUP', '备用'], ['CONFIG', '管理'], ['BRIDGE', '桥接']] },
    { key: 'ip', label: 'IP 地址', address: 'ip' }, { key: 'netmask', label: '子网掩码', address: 'mask' }, { key: 'vlan', label: 'VLAN', numeric: [0, 4094] },
  ] },
  { key: 'routes', label: '路由配置', fields: [
    { key: 'name', label: '名称' }, { key: 'interface', label: '出口接口', reference: 'interfaces' }, { key: 'vlan', label: 'VLAN', numeric: [0, 4094] },
    { key: 'destination', label: '目的地址', address: 'ip' }, { key: 'netmask', label: '目的掩码', address: 'mask' }, { key: 'gateway', label: '网关', address: 'ip' },
    { key: 'table_id', label: '路由表 ID（策略路由）', optional: true, numeric: [0, 4294967295] }, { key: 'source', label: '源地址（策略路由）', optional: true, address: 'ip' }, { key: 'source_mask', label: '源掩码（策略路由）', optional: true, address: 'mask' },
  ] },
  { key: 'tunnels', label: '隧道配置', fields: [
    { key: 'name', label: '名称' }, { key: 'id', label: '隧道 ID', numeric: [1, 102400] }, { key: 'mode', label: '模式', options: tunnelModes },
    { key: 'local_ip', label: '本端地址', address: 'ip' }, { key: 'primary_ip', label: '对端主地址', address: 'ip' }, { key: 'primary_certificate', label: '主装置证书', reference: 'certificates' },
    { key: 'backup_ip', label: '对端备地址', address: 'ip' }, { key: 'backup_certificate', label: '备装置证书', reference: 'certificates' },
    { key: 'lifetime', label: '周期（小时）', numeric: [1, 10000] }, { key: 'capacity', label: '容量', numeric: [10240, 2147493647] },
  ] },
  { key: 'policies', label: '策略配置', fields: [
    { key: 'id', label: '策略 ID', numeric: [1, 102400] }, { key: 'tunnel_id', label: '隧道 ID', reference: 'tunnel_ids' }, { key: 'mode', label: '模式', options: policyModes },
    { key: 'source_start', label: '内网起始地址', address: 'ip' }, { key: 'source_end', label: '内网终止地址', address: 'ip' },
    { key: 'destination_start', label: '外网起始地址', address: 'ip' }, { key: 'destination_end', label: '外网终止地址', address: 'ip' },
    { key: 'protocol', label: '协议', options: [['0', '全部'], ['1', 'ICMP'], ['2', 'TCP'], ['3', 'UDP']] },
    { key: 'direction', label: '方向', options: [['1', '安全域到非安全域'], ['2', '非安全域到安全域'], ['0', '双向']] },
    { key: 'source_port_start', label: '内网起始端口', numeric: [0, 65535] }, { key: 'source_port_end', label: '内网终止端口', numeric: [0, 65535] },
    { key: 'destination_port_start', label: '外网起始端口', numeric: [0, 65535] }, { key: 'destination_port_end', label: '外网终止端口', numeric: [0, 65535] }, { key: 'description', label: '描述', optional: true },
  ] },
];
type Draft = { result: Result | null; rows: Row[]; dirty: boolean; stale: boolean };
const emptyDraft = (): Draft => ({ result: null, rows: [], dirty: false, stale: false });
const emptyPages = (): Record<Kind, Draft> => ({ network: emptyDraft(), routes: emptyDraft(), tunnels: emptyDraft(), policies: emptyDraft() });
const cloneRows = (rows: Row[]): Row[] => rows.map(row => ({ ...row }));
const ipv4 = (value: string): number | null => {
  if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.some(part => part > 255) ? null : parts.reduce((total, part) => total * 256 + part, 0);
};
const nextId = (rows: Row[]) => {
  const used = new Set(rows.map(row => Number(row.id)));
  let id = 1;
  while (used.has(id) && id <= 102400) id += 1;
  return id <= 102400 ? String(id) : '';
};
const unusedCertificate = (kind: Kind, field: Field, row: Row) => kind === 'tunnels' && field.reference === 'certificates'
  && (row.mode === '2' || (field.key === 'backup_certificate' && row.backup_ip === '0.0.0.0'));

export default function SecurityOperator({ sessionId, disabled = false, onBusyChange, onAutoConfigured, autoConfigurationAvailable = true }: {
  sessionId: string; disabled?: boolean; onBusyChange?: (busy: boolean) => void;
  onAutoConfigured?: () => void | Promise<void>; autoConfigurationAvailable?: boolean;
}) {
  const [autoPlan, setAutoPlan] = useState<{ addresses: AutoConfigAddresses; certificates: string[]; certificate: string; results: Record<Kind, Result> } | null>(null);
  const [kind, setKind] = useState<Kind>('network');
  const [drafts, setDrafts] = useState(emptyPages);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [readErrors, setReadErrors] = useState<Partial<Record<Kind, string>>>({});
  const [editor, setEditor] = useState<{ index: number | null; row: Row; advanced: boolean } | null>(null);
  const [confirm, setConfirm] = useState<'read' | 'save' | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const active = useRef(false);
  const currentSession = useRef(sessionId);
  const attempted = useRef(new Set<Kind>());
  const disabledRef = useRef(disabled);
  const notifyBusy = useEffectEvent((value: boolean) => onBusyChange?.(value));
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  useEffect(() => {
    currentSession.current = sessionId;
    generation.current += 1; active.current = false;
    setDrafts(emptyPages()); setKind('network'); setEditor(null); setConfirm(null); setAutoPlan(null);
    attempted.current = new Set(); setReadErrors({});
    setBusy(false); setError(null); setNotice(null); notifyBusy(false);
    return () => { generation.current += 1; notifyBusy(false); };
  }, [sessionId]);
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);
  const page = pages.find(item => item.key === kind)!;
  const draft = drafts[kind];
  const blocked = busy || disabled;
  const unavailable = blocked || !draft.result || draft.stale;
  const updateRows = (rows: Row[]) => {
    if (unavailable || active.current || !mounted.current || currentSession.current !== sessionId) return;
    setDrafts(previous => ({ ...previous, [kind]: { ...previous[kind], rows, dirty: true } }));
    setNotice(null); setError(null);
  };
  const validateResult = (result: Result, target: Kind) => {
    if (result.kind !== target || !result.revision || !Array.isArray(result.rows)) throw new Error('装置配置结果不完整，请重新读取。');
  };
  const clearReadError = (target: Kind) => setReadErrors(previous => {
    const next = { ...previous }; delete next[target]; return next;
  });
  const loadInitial = useEffectEvent(async () => {
    if (!mounted.current || active.current || disabled || !sessionId || currentSession.current !== sessionId
      || pages.every(item => attempted.current.has(item.key))) return;
    const token = generation.current;
    const current = () => mounted.current && token === generation.current && currentSession.current === sessionId;
    active.current = true; setBusy(true); onBusyChange?.(true);
    try {
      for (const item of pages) {
        if (!current() || disabledRef.current) break;
        if (attempted.current.has(item.key)) continue;
        attempted.current.add(item.key);
        try {
          const result = await api.runVerticalSecurityOperator({ session_id: sessionId, action: 'read', kind: item.key });
          if (!current()) return;
          validateResult(result, item.key);
          setDrafts(previous => previous[item.key].dirty ? previous : {
            ...previous, [item.key]: { result, rows: cloneRows(result.rows), dirty: false, stale: false },
          });
          clearReadError(item.key);
        } catch (reason) {
          if (!current()) return;
          const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '读取失败，请核实装置状态。';
          setReadErrors(previous => ({ ...previous, [item.key]: message }));
          setDrafts(previous => ({ ...previous, [item.key]: { ...previous[item.key], stale: true } }));
        }
      }
    } finally {
      if (current()) { active.current = false; setBusy(false); onBusyChange?.(false); }
    }
  });
  useEffect(() => {
    if (disabled || !sessionId || busy) return;
    let cancelled = false;
    // StrictMode 的首轮清理在发包前撤销微任务；每个会话每类只自动尝试一次。
    queueMicrotask(() => { if (!cancelled) void loadInitial(); });
    return () => { cancelled = true; };
  }, [sessionId, disabled, busy]);
  const perform = async (action: 'read' | 'save') => {
    if (!mounted.current || active.current || disabled || !sessionId || currentSession.current !== sessionId) return;
    if (action === 'save' && (!draft.result || draft.stale || !draft.dirty)) return;
    const token = generation.current;
    const current = () => mounted.current && token === generation.current && currentSession.current === sessionId;
    if (action === 'read') attempted.current.add(kind);
    active.current = true; setBusy(true); onBusyChange?.(true); setConfirm(null); setError(null); setNotice(null);
    try {
      const result = await api.runVerticalSecurityOperator({ session_id: sessionId, action, kind, ...(action === 'save' ? { revision: draft.result!.revision, rows: cloneRows(draft.rows) } : {}) });
      if (!current()) return;
      validateResult(result, kind);
      if (action === 'save' && !result.verified) throw new Error(result.message || '上传结果未完成回读核对，请重新读取后核实。');
      setDrafts(previous => {
        const next = { ...previous, [kind]: { result, rows: cloneRows(result.rows), dirty: false, stale: false } };
        // 网络和隧道变更会影响其他页引用；保留其草稿，重新读取后才能上传。
        if (action === 'save' && kind === 'network') next.routes = { ...next.routes, stale: true };
        if (action === 'save' && kind === 'tunnels') next.policies = { ...next.policies, stale: true };
        return next;
      });
      clearReadError(kind);
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
  const prepareAutomatic = async () => {
    if (blocked || active.current || !mounted.current || currentSession.current !== sessionId) return;
    setError(null); setNotice(null);
    if (!autoConfigurationAvailable) { setError('当前连接无法核对 DSP 网络配置，请使用直连自动配置或手动配置。'); return; }
    const addresses = getAppliedSecurityNetwork();
    if (!addresses) { setError('请先在“DSP 网络配置”页面完成配置并成功应用，再进行自动配置。'); return; }
    const token = generation.current;
    const current = () => mounted.current && generation.current === token && currentSession.current === sessionId;
    active.current = true; setBusy(true); onBusyChange?.(true);
    try {
      const results = {} as Record<Kind, Result>;
      // 先读取全部配置和证书；前置读取失败时不上传任何一页。
      for (const item of pages) {
        if (!current() || disabledRef.current) return;
        const result = await api.runVerticalSecurityOperator({ session_id: sessionId, action: 'read', kind: item.key });
        if (!current()) return;
        validateResult(result, item.key);
        results[item.key] = result;
        attempted.current.add(item.key);
      }
      const certificates = results.tunnels.certificates;
      if (!certificates.length) throw new Error('没有可用的主站加密网关证书，请先由管理员导入证书。');
      const certificate = certificates.length === 1 ? certificates[0] : '';
      if (!current()) return;
      console.info('[纵密自动配置] 四页读取完成，等待确认主站证书和配置');
      setAutoPlan({ addresses, certificates, certificate, results });
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (current()) { active.current = false; setBusy(false); onBusyChange?.(false); }
    }
  };
  const performAutomatic = async () => {
    if (!autoPlan || !autoPlan.certificate || blocked || active.current || !mounted.current || currentSession.current !== sessionId) return;
    if (JSON.stringify(getAppliedSecurityNetwork()) !== JSON.stringify(autoPlan.addresses)) { setAutoPlan(null); setError('DSP 网络配置记录已变化，请重新点击自动配置生成预览。'); return; }
    const token = generation.current;
    const current = () => mounted.current && generation.current === token && currentSession.current === sessionId;
    const rows = buildAutoConfig(autoPlan.addresses, autoPlan.certificate);
    setDrafts(Object.fromEntries(pages.map(item => [item.key, { result: autoPlan.results[item.key], rows: cloneRows(rows[item.key]), dirty: true, stale: false }])) as Record<Kind, Draft>);
    setAutoPlan(null); setError(null); setNotice(null);
    active.current = true; setBusy(true); onBusyChange?.(true);
    let completed = false;
    let uploading: Kind = 'network';
    try {
      console.info('[纵密自动配置] 开始依次上传网络、路由、隧道、策略');
      await uploadAutoConfig(sessionId, rows, request => {
        uploading = request.kind;
        setKind(request.kind);
        return api.runVerticalSecurityOperator(request);
      }, () => current() && !disabledRef.current, (target, result) => {
        setDrafts(previous => ({ ...previous, [target]: { result, rows: cloneRows(result.rows), dirty: false, stale: false } }));
        clearReadError(target);
        setNotice(`${pages.find(item => item.key === target)!.label}已上传并回读核对一致。`);
        console.info('[纵密自动配置] 已完成上传及回读核对', { kind: target });
      });
      completed = current() && !disabledRef.current;
    } catch (reason) {
      if (current()) {
        setError(`${reason instanceof Error ? reason.message : String(reason)} 已停止自动配置，不会切换管理员或重启；请核实已经上传的页面。`);
        setDrafts(previous => ({ ...previous, [uploading]: { ...previous[uploading], stale: true } }));
        console.warn('[纵密自动配置] 流程中止，保留草稿，不自动重试上传');
      }
    } finally {
      if (current()) { active.current = false; setBusy(false); onBusyChange?.(false); }
    }
    if (completed && current() && !disabledRef.current) {
      setNotice('四页配置均已上传并核对，正在切换系统管理员重启纵密装置。');
      try { await onAutoConfigured?.(); } catch (reason) {
        if (mounted.current && generation.current === token && currentSession.current === sessionId) setError(`配置已上传，但切换管理员或重启未完成：${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }
  };
  const read = () => { if (!blocked) { if (draft.dirty) setConfirm('read'); else return perform('read'); } };
  const startEdit = (index: number | null) => {
    if (unavailable || active.current || !mounted.current || currentSession.current !== sessionId) return;
    setError(null);
    const row = index === null ? Object.fromEntries(page.fields.map(field => [field.key, field.options?.[0]?.[0] ?? ''])) : { ...draft.rows[index] };
    if (index === null && kind === 'network') Object.assign(row, { description: 'network', vlan: '0' });
    if (index === null && kind === 'routes') Object.assign(row, { interface: draft.result?.interfaces[0] ?? '', vlan: '0' });
    if (index === null && kind === 'tunnels') Object.assign(row, { name: 'test', id: nextId(draft.rows), backup_ip: '0.0.0.0', primary_certificate: draft.result?.certificates[0] ?? '', backup_certificate: 'cert2.pem', lifetime: '10000', capacity: '5000000' });
    if (index === null && kind === 'policies') Object.assign(row, { id: nextId(draft.rows), tunnel_id: draft.result?.tunnel_ids[0] ?? '', source_port_start: '0', source_port_end: '65535', destination_port_start: '0', destination_port_end: '65535' });
    setEditor({ index, row, advanced: kind === 'routes' && routeAdvancedKeys.some(key => !!row[key]) });
  };
  const choices = (field: Field) => {
    const options = field.reference ? (draft.result?.[field.reference] ?? []).map(value => ({ value, label: value })) : (field.options ?? []).filter(([value]) => !(kind === 'policies' && field.key === 'direction' && value === '0' && !draft.result?.bidirectional_allowed)).map(([value, label]) => ({ value, label }));
    // 原版新增列表不含管理口；已读取的 eth0/eth6 必须继续可编辑，不能静默换口。
    if (kind === 'network' && field.key === 'interface') {
      for (const row of draft.rows) {
        if (['eth0', 'eth6'].includes(row.interface) && !options.some(option => option.value === row.interface)) options.push({ value: row.interface, label: `${row.interface}（已有接口）` });
      }
    }
    const existing = editor?.row[field.key];
    // 未知值显式保留展示，不能静默替换成默认枚举或另一张证书。
    if (existing && !options.some(option => option.value === existing)) options.push({ value: existing, label: `${existing}${editor && unusedCertificate(kind, field, editor.row) ? '（未使用）' : '（原值，需核实）'}` });
    return options;
  };
  const changeField = (field: Field, value: string) => {
    if (unavailable || active.current) return;
    setError(null);
    setEditor(previous => {
      if (!previous) return previous;
      const row = { ...previous.row, [field.key]: value };
      // 明通仍按协议保留证书列；加密模式恢复到装置真实证书或等待选择。
      if (kind === 'tunnels' && field.key === 'mode') {
        if (value === '2' && !row.primary_certificate) row.primary_certificate = 'cert1.pem';
        if (value !== '2' && (!row.primary_certificate || (previous.row.mode === '2' && row.primary_certificate === 'cert1.pem' && !(draft.result?.certificates ?? []).includes(row.primary_certificate)))) row.primary_certificate = draft.result?.certificates[0] ?? '';
      }
      return { ...previous, row };
    });
  };
  const certificateMissing = kind === 'tunnels' && editor?.row.mode !== '2' && !draft.result?.certificates.length;
  const tunnelMissing = kind === 'policies' && !draft.result?.tunnel_ids.length;
  const applyEdit = () => {
    if (!editor || unavailable) return;
    if (certificateMissing) { setError('没有可用的加密网关证书，请由系统管理员先导入证书，再重新读取隧道配置。'); return; }
    if (tunnelMissing) { setError('没有可用隧道，请先上传隧道配置，再重新读取策略配置。'); return; }
    for (const field of page.fields) {
      const value = editor.row[field.key] ?? '';
      const optional = field.optional && !(kind === 'routes' && editor.advanced && routeAdvancedKeys.includes(field.key));
      if ((!optional && !value.trim()) || Array.from(value).some(char => char === ',' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) { setError(`请检查“${field.label}”，必填内容不能为空，也不能包含逗号或控制字符。`); return; }
      if (optional && !value) continue;
      if (kind === 'network' && field.key === 'description' && (value.length > 10 || Array.from(value).some(char => char.charCodeAt(0) > 126))) { setError('网络描述请使用最多 10 个英文字符、数字或符号。'); return; }
      if (kind === 'routes' && field.key === 'name' && (value.length > 32 || /[\u4e00-\u9fa5\uff0c]/u.test(value))) { setError('路由名称最多 32 个字符，不能包含中文或逗号。'); return; }
      if (field.numeric && (!/^\d+$/.test(value) || Number(value) < field.numeric[0] || Number(value) > field.numeric[1])) { setError(`“${field.label}”必须是 ${field.numeric[0]}～${field.numeric[1]} 之间的整数。`); return; }
      if (field.key === 'vlan' && value.length > 1 && value.startsWith('0')) { setError('VLAN 不能包含多余的前导零，请输入 0 或 1～4094。'); return; }
      if (field.address) {
        const address = ipv4(value);
        const inverse = address === null ? 0 : ~address >>> 0;
        if (address === null || (field.address === 'mask' && (inverse & (inverse + 1)) !== 0)) { setError(`请填写有效的“${field.label}”${field.address === 'mask' ? '，掩码必须连续' : '，格式为 IPv4'}。`); return; }
      }
      if (!unusedCertificate(kind, field, editor.row) && (field.options || field.reference) && !choices(field).some(option => option.value === value && !option.label.endsWith('（原值，需核实）'))) { setError(`“${field.label}”原值不在当前装置可选范围，请核实后选择。`); return; }
    }
    if ((kind === 'tunnels' || kind === 'policies') && draft.rows.some((row, index) => index !== editor.index && Number(row.id) === Number(editor.row.id))) { setError(`${kind === 'tunnels' ? '隧道' : '策略'} ID 已存在，请使用未占用的 ID。`); return; }
    if (kind === 'policies') {
      for (const [start, end, label] of [['source_start', 'source_end', '内网地址'], ['destination_start', 'destination_end', '外网地址'], ['source_port_start', 'source_port_end', '内网端口'], ['destination_port_start', 'destination_port_end', '外网端口']]) {
        const begin = start.includes('port') ? Number(editor.row[start]) : ipv4(editor.row[start])!;
        const finish = end.includes('port') ? Number(editor.row[end]) : ipv4(editor.row[end])!;
        if (begin > finish) { setError(`${label}起始值不能大于结束值。`); return; }
      }
    }
    const duplicateKeys = page.fields.map(field => field.key).filter(key => !(kind === 'routes' && key === 'name') && !(kind === 'policies' && ['id', 'description'].includes(key)));
    if (kind !== 'tunnels' && draft.rows.some((row, index) => index !== editor.index && duplicateKeys.every(key => row[key] === editor.row[key]))) { setError('存在相同的配置条件，请检查后再确认。'); return; }
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
      <div className="security-operator-toolbar"><div><h3>{page.label}</h3><p>{!draft.result ? busy ? '正在自动读取装置配置…' : readErrors[kind] ? '自动读取失败，请点击读取配置重试。' : '正在准备自动读取装置配置。' : draft.stale ? '当前结果需重新读取核实；草稿已保留。' : draft.dirty ? '草稿尚未上传，其他页面的草稿会保留。' : '显示最近一次读取的装置配置。'}</p></div><Space wrap>
        <Button disabled={blocked} onClick={() => void prepareAutomatic()}>自动配置</Button>
        <Button disabled={blocked} onClick={read}>读取配置</Button>
        <Button disabled={unavailable} onClick={() => startEdit(null)}>新增</Button>
        <Button type="primary" disabled={unavailable || !draft.dirty} onClick={() => setConfirm('save')}>上传配置</Button>
      </Space></div>
      {draft.dirty && <Tag color="warning">未上传的草稿</Tag>}
      <Table<{ row: Row; index: number }> size="small" rowKey="index" dataSource={draft.rows.map((row, index) => ({ row, index }))} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: Math.max(900, page.fields.length * 140) }} locale={{ emptyText: draft.result ? '暂无配置' : busy ? '正在读取配置…' : readErrors[kind] ? '读取失败，请手动刷新' : '等待自动读取' }} columns={[
        ...page.fields.map(field => ({ title: field.label, dataIndex: ['row', field.key], width: 140, ellipsis: true, render: (value: string) => field.options?.find(([code]) => code === value)?.[1] ?? (value || '—') })),
        { title: '操作', key: 'actions', width: kind === 'policies' ? 250 : 140, fixed: 'right' as const, render: (_: unknown, entry: { row: Row; index: number }) => <Space size="small"><Button size="small" disabled={unavailable} onClick={() => startEdit(entry.index)}>编辑</Button><Popconfirm title="从草稿删除此配置？" description="上传后才会改变装置配置。" disabled={unavailable} onConfirm={() => updateRows(draft.rows.filter((_, index) => index !== entry.index))}><Button size="small" danger disabled={unavailable}>删除</Button></Popconfirm>{kind === 'policies' && <><Button size="small" disabled={unavailable || entry.index === 0} onClick={() => move(entry.index, -1)}>上移</Button><Button size="small" disabled={unavailable || entry.index === draft.rows.length - 1} onClick={() => move(entry.index, 1)}>下移</Button></>}</Space> },
      ]} />
    </Card>
    {autoPlan && <Modal title="自动配置纵密装置" open width={1080} okText="依次上传并重启纵密" cancelText="取消" onCancel={() => setAutoPlan(null)} onOk={() => void performAutomatic()} okButtonProps={{ disabled: blocked || !autoPlan.certificate }}>
      <Alert type="warning" showIcon title="将按网络、路由、隧道、策略顺序覆盖配置并逐页上传" description="每页仅保留下方指定记录。四页全部上传并回读一致后，自动切换系统管理员账号重启纵密装置；任何一步失败立即停止，不重启 DSP。现有未上传草稿将被替换。" />
      <p>主站证书<Select aria-label="自动配置主站证书" style={{ minWidth: 300 }} value={autoPlan.certificate || undefined} placeholder="请选择管理员已导入的主站证书" options={autoPlan.certificates.map(value => ({ value, label: value }))} onChange={certificate => setAutoPlan(previous => previous ? { ...previous, certificate } : null)} /></p>
      {autoPlan.certificate && pages.map(item => <section key={item.key}><h4>{item.label}</h4><Table<Row> size="small" pagination={false} rowKey={(_, index) => String(index)} scroll={{ x: item.fields.length * 130 }} dataSource={buildAutoConfig(autoPlan.addresses, autoPlan.certificate)[item.key]} columns={item.fields.map(field => ({ title: field.label, dataIndex: field.key, width: 130, render: (value: string) => item.key === 'tunnels' && field.key === 'backup_certificate' ? '不使用' : field.options?.find(([code]) => code === value)?.[1] ?? (value || '—') }))} /></section>)}
    </Modal>}
    {editor && <Modal title={`${editor.index === null ? '新增' : '编辑'}${page.label}`} open width={760} onCancel={() => setEditor(null)} okText="确认草稿" cancelText="取消" onOk={applyEdit} okButtonProps={{ disabled: unavailable || certificateMissing || tunnelMissing }}>
      {kind === 'network' && <p>网络描述请使用最多 10 个英文字符、数字或符号。</p>}
      {kind === 'network' && editor.row.interface === 'BRIDGE' && <Alert type="info" showIcon title="桥接配置的描述同时作为桥名称，路由出口将引用此名称。" />}
      {kind === 'routes' && <Checkbox aria-label="启用策略路由" checked={editor.advanced} disabled={unavailable} onChange={event => {
        if (unavailable || active.current) return;
        const advanced = event.target.checked;
        setError(null);
        setEditor(previous => previous ? { ...previous, advanced, row: advanced ? previous.row : { ...previous.row, table_id: '', source: '', source_mask: '' } } : null);
      }}>启用策略路由</Checkbox>}
      {certificateMissing && <Alert type="warning" showIcon title="没有可用的加密网关证书，请由系统管理员先导入证书，再重新读取隧道配置。" />}
      {tunnelMissing && <Alert type="warning" showIcon title="没有可用隧道，请先上传隧道配置，再重新读取策略配置。" />}
      {kind === 'tunnels' && <p>{editor.row.mode === '2' ? '明通模式无需选择主备证书。' : editor.row.backup_ip === '0.0.0.0' ? '备地址为 0.0.0.0 表示不启用备用端，无需选择备证书。' : '主备证书均需选择装置中已有的加密网关证书。'}</p>}
      <div className="security-operator-fields">{page.fields.filter(field => kind !== 'routes' || editor.advanced || !routeAdvancedKeys.includes(field.key)).map(field => <label key={field.key}><span>{field.label}{field.optional && !(kind === 'routes' && editor.advanced) ? '（选填）' : ''}</span>{field.options || field.reference ? <Select aria-label={field.label} value={editor.row[field.key] || undefined} options={choices(field)} placeholder={unusedCertificate(kind, field, editor.row) ? '当前配置不使用' : '请选择'} disabled={unavailable || unusedCertificate(kind, field, editor.row)} onChange={value => changeField(field, value)} /> : <Input aria-label={field.label} value={editor.row[field.key] ?? ''} type={field.numeric ? 'number' : 'text'} inputMode={field.numeric ? 'numeric' : undefined} min={field.numeric?.[0]} max={field.numeric?.[1]} step={field.numeric ? 1 : undefined} placeholder={field.address === 'ip' ? '请填写实际 IPv4 地址' : field.address === 'mask' ? '例如 255.255.255.0' : field.numeric ? `${field.numeric[0]}～${field.numeric[1]}` : undefined} maxLength={kind === 'network' && field.key === 'description' ? 10 : kind === 'routes' && field.key === 'name' ? 32 : 256} disabled={unavailable} onChange={event => changeField(field, event.target.value)} />}</label>)}</div>
      {error && <Alert type="error" showIcon title={error} />}
    </Modal>}
    {confirm && <Modal title={confirm === 'read' ? '重新读取并放弃本页草稿？' : `上传${page.label}？`} open okText={confirm === 'read' ? '放弃并读取' : '确认上传'} cancelText="取消" onCancel={() => setConfirm(null)} onOk={() => perform(confirm)} okButtonProps={{ disabled: blocked }}>
      <p>{confirm === 'read' ? '将用装置当前配置替换本页草稿，其他页面的草稿保留。' : `将上传本页全部 ${draft.rows.length} 条配置，包括草稿中的删除。`}</p>
      {confirm === 'save' && <Alert type="warning" showIcon title={kind === 'network' || kind === 'routes' ? '网络或路由变化可能中断当前管理连接及业务通信。' : '配置变化可能影响现有业务通信。'} description="上传失败或断开时保留草稿，不自动重试；请重新读取并核实装置状态。" />}
    </Modal>}
    {busy && <p role="status">正在处理配置，请等待装置应答…</p>}
    {readErrors[kind] && <Alert type="error" showIcon title={`${page.label}自动读取失败`} description={readErrors[kind]} />}
    {error && !editor && <Alert type="error" showIcon title={error} />}
    {notice && <Alert type="info" showIcon title={notice} />}
  </section>;
}
