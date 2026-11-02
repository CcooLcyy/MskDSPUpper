import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Empty, Input, Modal, Select, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { ModbusPoint, ModbusPointTable } from '../../adapters/types';
import { PlatformAuthContext } from '../../auth/platform-auth-context';
import { platformTemplateCatalog } from './catalog';
import { normalizePlatformId } from './catalog-core';
import type { PlatformTemplateEntry, PlatformTemplateSummary } from './catalog-core';
import { isTemplateWritePoint, planTemplateApplication } from './model';
import { applyApplicationChanges, createApplication, parseTemplateBindings, planApplicationChanges, planApplicationUpdate, planTemplateSourceTransfers, positiveRevision } from './bindings';
import type { TemplateBindings, TemplateCommit } from './bindings';
import './templates.css';
interface Props {
  open: boolean;
  connectionName: string;
  protocol: 'RTU' | 'TCP';
  addressBase: number;
  table: ModbusPointTable | null;
  busy: boolean;
  onClose: () => void;
  onApply: (commit: TemplateCommit) => Promise<boolean>;
}
interface PreviewRow {
  id: string;
  tag: string;
  address: string;
  kind: string;
  fields: string;
  detail: string;
  blocked?: string;
  condition?: string;
  write: boolean;
  sourceTransfer?: boolean;
  applied?: boolean;
  deletion?: boolean;
}
const {
  Text,
  Title
} = Typography;
const names: Record<string, string> = {
  added: '新增',
  applied: '已添加',
  readded: '重新添加',
  modified: '平台修改',
  deleted: '平台删除',
  conflict: '现场修改，需选择',
  tag: '标签',
  address: '地址',
  function: '功能码',
  data_type: '数据类型',
  scale: '倍率',
  scale_decimal: '倍率原文',
  offset: '偏移',
  offset_decimal: '偏移原文',
  deadband: '死区',
  deadband_decimal: '死区原文',
  reg_count: '寄存器数',
  word_order: '字序',
  byte_order: '字节序',
  bit_index: '位索引',
  enum_value: '枚举值'
};
const compareValue = (current: unknown, next: unknown) => current === next ? String(next ?? current ?? '—') : `${current ?? '—'} → ${next ?? '—'}`;
const changeFields = (fields: string[], current?: ModbusPoint, next?: ModbusPoint) => fields.map(key => {
  if (!names[key]) return key;
  const field = key as keyof ModbusPoint;
  return `${names[key]}：${compareValue(current?.[field], next?.[field])}`;
}).join('；');
/** 目录统一来自平台。设备快照由协议页面在打开窗口前复读，提交使用版本比较。 */
export default function TemplateModal({
  open,
  connectionName,
  protocol,
  addressBase,
  table,
  busy,
  onClose,
  onApply
}: Props) {
  const {
    message,
    modal
  } = App.useApp();
  const auth = useContext(PlatformAuthContext);
  const authRef = useRef(auth);
  authRef.current = auth;
  const platformId = normalizePlatformId(auth?.snapshot.settings?.grpc_endpoint ?? '');
  const username = auth?.snapshot.status?.username ?? '';
  const [summaries, setSummaries] = useState<PlatformTemplateSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [entry, setEntry] = useState<PlatformTemplateEntry | null>(null);
  const [catalogCached, setCatalogCached] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [pointSearch, setPointSearch] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [prefix, setPrefix] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [versionInput, setVersionInput] = useState('');
  const [requestedRevision, setRequestedRevision] = useState('');
  const [detailRefresh, setDetailRefresh] = useState(0);
  const generation = useRef(0);
  const bindingsResult = useMemo(() => {
    try {
      return {
        bindings: parseTemplateBindings(table?.template_bindings_json),
        error: ''
      };
    } catch (cause) {
      return {
        bindings: {
          schema_version: 1,
          applications: []
        } as TemplateBindings,
        error: String(cause)
      };
    }
  }, [table?.template_bindings_json]);
  const bindings = bindingsResult.bindings;
  const applications = bindings.applications.filter(app => app.platform_id === platformId && app.template_id === selectedId);
  const application = applications.find(app => app.application_id === applicationId);
  const disabled = busy || working || loading;
  useEffect(() => {
    if (!open) return;
    const epoch = ++generation.current;
    let active = true;
    const current = () => active && generation.current === epoch && authRef.current?.snapshot.phase === 'authenticated' && normalizePlatformId(authRef.current.snapshot.settings?.grpc_endpoint ?? '') === platformId && authRef.current.snapshot.status?.username === username;
    setLoading(true);
    setRequestedRevision('');
    setVersionInput('');
    setCatalogLoaded(false);
    setEntry(null);
    setError('');
    setSummaries([]);
    setSelected([]);
    if (!current()) {
      setLoading(false);
      setError('请先登录平台后获取点表模板');
      return () => {
        active = false;
      };
    }
    const catalog = platformTemplateCatalog(platformId, username, current);
    void catalog.list(platformId).then(result => {
      if (!current()) return;
      setSummaries(result.summaries);
      setCatalogLoaded(true);
      setCatalogCached(result.cached);
      setSelectedId(previous => result.summaries.some(item => item.id === previous) ? previous : result.summaries[0]?.id ?? '');
      console.info('打开或刷新模板窗口已获取平台目录', { platformId, cached: result.cached, count: result.summaries.length });
    }).catch(cause => {
      if (current()) setError(`读取平台点表目录失败：${String(cause)}`);
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [open, platformId, username, auth?.snapshot.phase, refresh]);
  const summary = summaries.find(item => item.id === selectedId);
  const isHistorical = !!entry && !!summary && entry.summary.revision !== summary.revision;
  useEffect(() => {
    if (!open || !summary) return;
    let active = true;
    const epoch = generation.current;
    const current = () => active && epoch === generation.current && authRef.current?.snapshot.phase === 'authenticated' && normalizePlatformId(authRef.current.snapshot.settings?.grpc_endpoint ?? '') === platformId && authRef.current.snapshot.status?.username === username;
    setLoading(true);
    setEntry(null);
    setError('');
    setSelected([]);
    const catalog = platformTemplateCatalog(platformId, username, current);
    void catalog.get(platformId, summary.id, requestedRevision || summary.revision).then(result => {
      if (!current()) return;
      setEntry(result);
      setPrefix('');
      setPointSearch('');
      const matching = bindings.applications.find(app => app.platform_id === platformId && app.template_id === summary.id);
      setApplicationId(matching?.application_id ?? '');
      setSelected([]);
      console.info('平台模板已读取，等待手动选择变更', { templateId: summary.id, revision: result.summary.revision, cached: result.cached });
    }).catch(cause => {
      if (current()) setError(`获取平台点表失败：${String(cause)}`);
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [open, summary, platformId, username, bindings, table, addressBase, requestedRevision, detailRefresh]);
  const planResult = useMemo<{ rows: PreviewRow[]; acknowledgeOnly: boolean; error: string }>(() => {
    if (!entry || !table) return {
      rows: [] as PreviewRow[],
      acknowledgeOnly: false,
      error: ''
    };
    try {
      if (application) {
        const changes = planApplicationChanges(application, table.points, entry.template, entry.summary.revision, addressBase, isHistorical, selected);
        const additions = changes.filter(row => row.next && !row.current && !row.blocked).map(row => row.next!);
        const otherBindings = { ...bindings, applications: bindings.applications.filter(app => app.application_id !== application.application_id) };
        const transferTags = new Set(planTemplateSourceTransfers(otherBindings, table.points, additions).transfers.map(item => item.target_tag));
        return {
          acknowledgeOnly: application.revision !== entry.summary.revision && !planApplicationUpdate(application, table.points, entry.template, entry.summary.revision, addressBase, isHistorical).length,
          error: '',
          rows: changes.map(row => ({
            id: row.id,
            tag: row.current && row.next ? compareValue(row.current.tag, row.next.tag) : row.next?.tag ?? row.current?.tag ?? row.id,
            address: row.current && row.next ? compareValue(row.current.address, row.next.address) : String(row.next?.address ?? row.current?.address ?? '—'),
            kind: row.kind,
            fields: row.kind === 'applied' || row.kind === 'added' || row.kind === 'readded' ? row.source?.group ?? '' : changeFields(row.fields, row.current, row.next),
            detail: JSON.stringify({
              现场: row.current,
              平台: row.next
            }, null, 2),
            blocked: row.blocked,
            condition: row.source?.condition,
            write: !!row.source && isTemplateWritePoint(row.source),
            applied: row.kind === 'applied',
            deletion: !row.next,
            sourceTransfer: !!row.next && transferTags.has(row.next.tag)
          }))
        };
      }
      const plan = planTemplateApplication(entry.template, {
        existingPoints: table.points,
        addressBase,
        prefix,
        selectedIds: selected
      });
      const transferTags = new Set(planTemplateSourceTransfers(bindings, table.points, plan.rows.filter(row => !row.conflict).map(row => row.point)).transfers.map(item => item.target_tag));
      return {
        acknowledgeOnly: false,
        error: '',
        rows: plan.rows.map(row => ({
          id: row.id,
          tag: row.finalTag,
          address: String(row.point.address),
          kind: transferTags.has(row.finalTag) ? 'readded' : 'added',
          fields: row.source.group,
          detail: row.source.description,
          blocked: row.conflict ?? undefined,
          condition: row.source.condition,
          write: isTemplateWritePoint(row.source),
          sourceTransfer: transferTags.has(row.finalTag)
        }))
      };
    } catch (cause) {
      return {
        rows: [] as PreviewRow[],
        acknowledgeOnly: false,
        error: String(cause)
      };
    }
  }, [entry, table, application, addressBase, prefix, selected, isHistorical, bindings]);
  const filtered = summaries.filter(item => (!manufacturer || manufacturer === item.manufacturer) && `${item.name} ${item.manufacturer} ${item.models.join(' ')} ${item.protocol_version}`.toLowerCase().includes(search.toLowerCase()));
  const rows = planResult.rows.filter(row => `${row.tag} ${row.address} ${row.fields}`.toLowerCase().includes(pointSearch.toLowerCase()));
  const chosen = planResult.rows.filter(row => selected.includes(row.id) && !row.blocked && !row.applied);
  const acknowledgeOnly = planResult.acknowledgeOnly && !chosen.length;
  const counts = {
    added: chosen.filter(row => row.kind === 'added' || row.kind === 'readded').length,
    deleted: chosen.filter(row => row.deletion).length,
    updated: chosen.filter(row => !row.deletion && row.kind !== 'added' && row.kind !== 'readded').length
  };
  const apply = async () => {
    if (disabled || !entry || !table || !chosen.length && !acknowledgeOnly) return;
    const perform = async () => {
      setWorking(true);
      try {
        // 预览期间注销或切换平台时不得提交旧响应。
        if (authRef.current?.snapshot.phase !== 'authenticated' || normalizePlatformId(authRef.current.snapshot.settings?.grpc_endpoint ?? '') !== platformId || authRef.current.snapshot.status?.username !== username) throw Error('平台登录会话已变化，请重新打开模板窗口');
        let commit: TemplateCommit;
        let transferredTags: string[] = [];
        if (application) {
          const next = applyApplicationChanges(application, table.points, entry.template, entry.summary.revision, chosen.map(row => row.id), addressBase, isHistorical);
          const otherBindings = { ...bindings, applications: bindings.applications.filter(app => app.application_id !== application.application_id) };
          const addedPoints = next.points.filter(point => !table.points.some(current => current.tag === point.tag));
          const migration = planTemplateSourceTransfers(otherBindings, table.points, addedPoints);
          transferredTags = migration.transfers.map(item => item.target_tag);
          commit = {
            expected: table,
            points: next.points,
            bindings: {
              ...bindings,
              applications: bindings.applications.map(app => app.application_id === application.application_id ? next.application : migration.bindings.applications.find(other => other.application_id === app.application_id)!)
            }
          };
        } else {
          const next = createApplication({
            platformId,
            templateId: entry.summary.id,
            revision: entry.summary.revision,
            template: entry.template,
            addressBase,
            prefix,
            selectedIds: chosen.map(row => row.id),
            existingPoints: table.points
          });
          const migration = planTemplateSourceTransfers(bindings, table.points, next.points);
          transferredTags = migration.transfers.map(item => item.target_tag);
          commit = {
            expected: table,
            points: [...table.points, ...next.points],
            bindings: {
              ...migration.bindings,
              applications: [...migration.bindings.applications, next.application]
            }
          };
        }
        if (await onApply(commit)) {
          console.info('模板所选变更已保存', { connectionName, protocol, applicationId: application?.application_id, ...counts, acknowledgeOnly });
          if (transferredTags.length) console.info('模板重新添加点位并迁移来源已保存', { connectionName, protocol, tags: transferredTags });
          onClose();
        }
      } catch (cause) {
        void message.error(`应用平台点表失败：${String(cause)}`);
        console.error('应用平台点表失败', cause);
      } finally {
        setWorking(false);
      }
    };
    if (isHistorical || chosen.some(row => row.write || row.condition || row.deletion || row.kind === 'conflict')) modal.confirm({
      title: isHistorical ? `确认使用历史版本 ${entry.summary.revision}` : '确认所选更新',
      content: `${isHistorical ? '已选择历史版本，所选点位将按该版本更正。' : ''}勾选的冲突点将采用平台配置，勾选的删除项将移除现场点。写控制点和条件点需要核对型号及适用说明；保存点表不会立即执行写控制。`,
      okText: '确认应用',
      cancelText: '返回核对',
      onOk: perform
    });else await perform();
  };
  const columns: ColumnsType<PreviewRow> = [{
    title: '标签（现场 → 平台）',
    dataIndex: 'tag',
    width: 210,
    render: (value, row) => <Tooltip title={row.detail}><span>{value}</span></Tooltip>
  }, {
    title: '地址（现场 → 平台）',
    dataIndex: 'address',
    width: 160
  }, {
    title: '状态',
    width: 155,
    render: (_, row) => <Tag color={row.applied ? 'default' : row.blocked || row.kind === 'conflict' ? 'orange' : row.kind === 'deleted' ? 'red' : 'blue'}>{row.blocked ? '冲突，禁止应用' : names[row.kind]}</Tag>
  }, {
    title: '变更字段 / 分组',
    dataIndex: 'fields',
    width: 200
  }, {
    title: '适用条件 / 冲突',
    width: 230,
    render: (_, row) => <Text type={row.blocked ? 'danger' : row.condition || row.write || row.sourceTransfer ? 'warning' : undefined}>{row.blocked ?? ([row.sourceTransfer ? '重新添加，将更新模板来源' : '', row.condition || (row.write ? '写控制点' : '')].filter(Boolean).join('；') || '—')}</Text>
  }];
  const blocking = error || bindingsResult.error || planResult.error || (!positiveRevision(table?.revision) ? '当前下位机不支持模板来源记录及并发保护，请更新下位机后再应用模板' : '');
  return <Modal title="平台点表模板" open={open} onCancel={() => {
    if (!busy && !working) onClose();
  }} closable={!busy && !working} mask={{
    closable: !busy && !working
  }} width="min(1380px, calc(100vw - 40px))" centered className="modbus-template-modal" styles={{
    container: {
      height: 'min(900px, calc(100dvh - 40px))',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    },
    header: {
      flexShrink: 0
    },
    body: {
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    },
    footer: {
      flexShrink: 0
    }
  }} footer={<div className="mt-footer"><Text>已选 {chosen.length} 项：新增 {counts.added} 项、更新 {counts.updated} 项、删除 {counts.deleted} 项</Text><Space><Button disabled={busy || working} onClick={onClose}>取消</Button><Button type="primary" loading={working || busy} disabled={disabled || !!blocking || !chosen.length && !acknowledgeOnly} onClick={() => void apply()}>{acknowledgeOnly ? '确认版本信息' : '应用所选变更'}</Button></Space></div>}>
  <div className="mt-intro"><Text>目标连接：<Text strong>{connectionName}</Text> · Modbus {protocol} · {addressBase === 2 ? '1' : '0'} 基</Text><Space wrap>
    <Input aria-label="指定历史版本" placeholder="指定历史版本号" value={versionInput} maxLength={20} disabled={disabled || !summary} style={{
          width: 170
        }} onChange={event => setVersionInput(event.target.value)} />
    <Button disabled={disabled || !summary || !versionInput} onClick={() => {
          const revision = versionInput.trim();
          if (!positiveRevision(revision)) {
            void message.error('请输入有效的正整数版本号');
            return;
          }
          setRequestedRevision(revision);
          setDetailRefresh(value => value + 1);
        }}>读取指定版本</Button>
    <Button disabled={disabled || !requestedRevision} onClick={() => {
          setRequestedRevision('');
          setVersionInput('');
        }}>返回当前版本</Button>
    <Button icon={<ReloadOutlined />} disabled={disabled} onClick={() => {
          setRequestedRevision('');
          setVersionInput('');
          setRefresh(value => value + 1);
        }}>刷新平台模板</Button>
  </Space></div>
  {blocking && <Alert showIcon type="error" title={blocking} style={{
      marginBottom: 10
    }} />}
  {(catalogCached || entry?.cached) && <Alert showIcon type="warning" title="平台暂时无法连接，正在使用本平台已缓存的目录或点表；显示版本可能不是最新版本。" style={{
      marginBottom: 10
    }} />}
  {bindings.applications.some(app => app.platform_id === platformId && !summaries.some(item => item.id === app.template_id)) && !loading && catalogLoaded && <Alert type="info" showIcon title="部分已应用模板不在当前平台目录中，设备现有点位保留。" />}
  <div className="mt-layout"><aside className="mt-picker">
   <Input prefix={<SearchOutlined />} aria-label="搜索模板" placeholder="搜索厂家、型号或版本" value={search} allowClear disabled={disabled} onChange={event => setSearch(event.target.value)} />
   <Select placeholder="全部厂家" aria-label="厂家筛选" value={manufacturer || undefined} allowClear onChange={value => setManufacturer(value ?? '')} options={[...new Set(summaries.map(item => item.manufacturer))].map(value => ({
          value,
          label: value
        }))} />
   <Text type="secondary">平台模板 · {filtered.length} 个</Text><div className="mt-template-list">{filtered.map(item => <button key={item.id} className={`mt-template-item${selectedId === item.id ? ' selected' : ''}`} disabled={disabled} onClick={() => {
            setSelectedId(item.id);
            setRequestedRevision('');
            setVersionInput('');
          }}><strong>{item.name}</strong><small>{item.models.join(' / ')}</small><small>版本 {item.revision} · {item.point_count} 个点位</small></button>)}{!filtered.length && !loading && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="平台暂无可用模板" />}</div>
  </aside><section className="mt-detail">{loading ? <Spin tip="正在获取平台点表…"><div style={{
            height: 100
          }} /></Spin> : entry ? <>
   <div className="mt-heading"><div>{isHistorical && <Tag color="orange">历史版本 {entry.summary.revision} · 当前版本 {summary?.revision}</Tag>}<Title level={5}>{entry.template.name}</Title><Text type="secondary">平台版本 {entry.summary.revision} · {entry.template.protocol_version} · {entry.template.models.join(' / ')}</Text></div><Button size="small" onClick={() => modal.info({
              title: '模板适用说明',
              content: <div style={{
                maxHeight: '60vh',
                overflow: 'auto'
              }}>{entry.template.notes.map((note, index) => <p key={index}>{note}</p>)}</div>,
              okText: '已阅读'
            })}>适用说明</Button></div>
   {applications.length > 1 && <div className="mt-meta"><Text>模板应用记录</Text><Select aria-label="模板应用记录" disabled={disabled} style={{ minWidth: 220 }} value={applicationId} onChange={id => {
            setApplicationId(id);
            setPointSearch('');
            setSelected([]);
          }} options={applications.map(app => ({ value: app.application_id, label: `${app.prefix || '无前缀'} · 版本 ${app.revision}` }))} /></div>}
   {application ? <Alert type="info" title={`完整应用版本 ${application.revision} → 平台版本 ${entry.summary.revision}；标签前缀：${application.prefix || '无前缀'}。新增、更新和删除可一起勾选，未选项保留现场配置；已添加且无平台变化的点不可重复选择。`} style={{ marginBottom: 10 }} /> : <div className="mt-prefix"><label htmlFor="modbus-template-prefix">标签前缀（可选）</label><Input id="modbus-template-prefix" maxLength={256} value={prefix} onChange={event => setPrefix(event.target.value)} placeholder="默认不加前缀" /><Text type="secondary">请手动勾选需要添加的点位</Text></div>}
   <Input prefix={<SearchOutlined />} aria-label="搜索点位" placeholder="搜索点位名称、地址或变更字段" value={pointSearch} onChange={event => setPointSearch(event.target.value)} allowClear />
   <div className="mt-selection"><Text>共 {planResult.rows.length} 个点位 · 已添加 {planResult.rows.filter(row => row.applied).length} 个 · 请手动选择变更</Text><Button size="small" disabled={disabled} onClick={() => setSelected([])}>清空选择</Button></div>
   <div className="mt-table-area"><Table<PreviewRow> rowKey="id" size="small" columns={columns} dataSource={rows} pagination={false} scroll={{
              x: 1000,
              y: '100%'
            }} rowSelection={{
              selectedRowKeys: selected.filter(id => !planResult.rows.find(row => row.id === id)?.applied),
              preserveSelectedRowKeys: true,
              onChange: keys => setSelected(keys.map(String)),
              getCheckboxProps: row => ({
                disabled: disabled || !!row.blocked || !!row.applied
              })
            }} locale={{
              emptyText: '没有匹配点位'
            }} /></div>
  </> : <Empty description="从平台获取模板后选择点位" />}</section></div>
 </Modal>;
}
