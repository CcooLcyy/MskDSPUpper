import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Empty, Input, Modal, Select, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { ModbusPointTable } from '../../adapters/types';
import { PlatformAuthContext } from '../../auth/platform-auth-context';
import { platformTemplateCatalog } from './catalog';
import { normalizePlatformId } from './catalog-core';
import type { PlatformTemplateEntry, PlatformTemplateSummary } from './catalog-core';
import { isTemplateWritePoint, planTemplateApplication } from './model';
import { applyApplicationUpdate, createApplication, parseTemplateBindings, planApplicationUpdate, positiveRevision } from './bindings';
import type { TemplateBindings, TemplateCommit, TemplateUpdateRow } from './bindings';
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
}
const {
  Text,
  Title
} = Typography;
const initialSelection = (entry: PlatformTemplateEntry) => entry.template.points.filter(point => !isTemplateWritePoint(point) && !point.condition && point.default_selected !== false).map(point => point.id);
const names: Record<string, string> = {
  added: '新增',
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
      if (matching && table) {
        try {
          setSelected(planApplicationUpdate(matching, table.points, result.template, result.summary.revision, addressBase, result.summary.revision !== summary.revision).filter(row => row.selected).map(row => row.id));
        } catch {
          setSelected([]);
        }
      } else setSelected(initialSelection(result));
    }).catch(cause => {
      if (current()) setError(`获取平台点表失败：${String(cause)}`);
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [open, summary, platformId, username, bindings, table, addressBase, requestedRevision, detailRefresh]);
  const planResult = useMemo(() => {
    if (!entry || !table) return {
      rows: [] as PreviewRow[],
      updates: [] as TemplateUpdateRow[],
      error: ''
    };
    try {
      if (application) {
        const updates = planApplicationUpdate(application, table.points, entry.template, entry.summary.revision, addressBase, isHistorical);
        return {
          updates,
          error: '',
          rows: updates.map(row => ({
            id: row.id,
            tag: row.next?.tag ?? row.current?.tag ?? row.id,
            address: row.next && row.current ? `${row.current.address} → ${row.next.address}` : String(row.next?.address ?? row.current?.address ?? '—'),
            kind: row.kind,
            fields: row.fields.map(key => names[key] ?? key).join('、'),
            detail: JSON.stringify({
              现场: row.current,
              平台: row.next
            }, null, 2),
            blocked: row.blocked,
            condition: row.source?.condition,
            write: !!row.source && isTemplateWritePoint(row.source)
          }))
        };
      }
      const plan = planTemplateApplication(entry.template, {
        existingPoints: table.points,
        addressBase,
        prefix,
        selectedIds: selected
      });
      return {
        updates: [] as TemplateUpdateRow[],
        error: '',
        rows: plan.rows.map(row => ({
          id: row.id,
          tag: row.finalTag,
          address: String(row.point.address),
          kind: 'added',
          fields: row.source.group,
          detail: row.source.description,
          blocked: row.conflict ?? undefined,
          condition: row.source.condition,
          write: isTemplateWritePoint(row.source)
        }))
      };
    } catch (cause) {
      return {
        rows: [] as PreviewRow[],
        updates: [] as TemplateUpdateRow[],
        error: String(cause)
      };
    }
  }, [entry, table, application, addressBase, prefix, selected, isHistorical]);
  const filtered = summaries.filter(item => (!manufacturer || manufacturer === item.manufacturer) && `${item.name} ${item.manufacturer} ${item.models.join(' ')} ${item.protocol_version}`.toLowerCase().includes(search.toLowerCase()));
  const rows = planResult.rows.filter(row => `${row.tag} ${row.address} ${row.fields}`.toLowerCase().includes(pointSearch.toLowerCase()));
  const chosen = planResult.rows.filter(row => selected.includes(row.id) && !row.blocked);
  const acknowledgeOnly = !!application && !!entry && !planResult.rows.length && !planResult.error && application.revision !== entry.summary.revision;
  const selectApplication = (id: string) => {
    setApplicationId(id);
    setPrefix('');
    if (!entry || !table) return;
    const app = applications.find(item => item.application_id === id);
    try {
      setSelected(app ? planApplicationUpdate(app, table.points, entry.template, entry.summary.revision, addressBase, isHistorical).filter(row => row.selected).map(row => row.id) : initialSelection(entry));
    } catch {
      setSelected([]);
    }
  };
  const apply = async () => {
    if (disabled || !entry || !table || !chosen.length && !acknowledgeOnly) return;
    const perform = async () => {
      setWorking(true);
      try {
        // 预览期间注销或切换平台时不得提交旧响应。
        if (authRef.current?.snapshot.phase !== 'authenticated' || normalizePlatformId(authRef.current.snapshot.settings?.grpc_endpoint ?? '') !== platformId || authRef.current.snapshot.status?.username !== username) throw Error('平台登录会话已变化，请重新打开模板窗口');
        let commit: TemplateCommit;
        if (application) {
          const next = applyApplicationUpdate(application, table.points, entry.template, entry.summary.revision, chosen.map(row => row.id), addressBase, isHistorical);
          commit = {
            expected: table,
            points: next.points,
            bindings: {
              ...bindings,
              applications: bindings.applications.map(app => app.application_id === application.application_id ? next.application : app)
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
          commit = {
            expected: table,
            points: [...table.points, ...next.points],
            bindings: {
              ...bindings,
              applications: [...bindings.applications, next.application]
            }
          };
        }
        if (await onApply(commit)) onClose();
      } catch (cause) {
        void message.error(`应用平台点表失败：${String(cause)}`);
        console.error('应用平台点表失败', cause);
      } finally {
        setWorking(false);
      }
    };
    if (isHistorical || chosen.some(row => row.write || row.condition || row.kind === 'deleted' || row.kind === 'conflict')) modal.confirm({
      title: isHistorical ? `确认使用历史版本 ${entry.summary.revision}` : '确认所选更新',
      content: `${isHistorical ? '已选择历史版本，所选点位将按该版本更正。' : ''}勾选的冲突点将采用平台配置，勾选的删除项将移除现场点。写控制点和条件点需要核对型号及适用说明；保存点表不会立即执行写控制。`,
      okText: '确认应用',
      cancelText: '返回核对',
      onOk: perform
    });else await perform();
  };
  const columns: ColumnsType<PreviewRow> = [{
    title: '应用后的标签',
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
    render: (_, row) => <Tag color={row.blocked || row.kind === 'conflict' ? 'orange' : row.kind === 'deleted' ? 'red' : 'blue'}>{row.blocked ? '冲突，禁止应用' : names[row.kind]}</Tag>
  }, {
    title: application ? '变更字段' : '分组',
    dataIndex: 'fields',
    width: 200
  }, {
    title: '适用条件 / 冲突',
    width: 230,
    render: (_, row) => <Text type={row.blocked ? 'danger' : row.condition || row.write ? 'warning' : undefined}>{row.blocked ?? row.condition ?? (row.write ? '写控制点' : '—')}</Text>
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
  }} footer={<div className="mt-footer"><Text>已选 {chosen.length} 项{application ? '；未选差异保留现场配置，下次仍会提示。' : ''}</Text><Space><Button disabled={busy || working} onClick={onClose}>取消</Button><Button type="primary" loading={working || busy} disabled={disabled || !!blocking || !chosen.length && !acknowledgeOnly} onClick={() => void apply()}>{acknowledgeOnly ? '确认版本信息' : application ? '应用所选更新' : '添加所选点位'}</Button></Space></div>}>
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
   <div className="mt-meta"><Text>操作</Text><Select aria-label="模板应用记录" style={{
              minWidth: 300
            }} value={applicationId} onChange={selectApplication} options={[{
              value: '',
              label: '作为新的模板应用（可使用不同前缀）'
            }, ...applications.map(app => ({
              value: app.application_id,
              label: `更新已应用点位：${app.prefix || '无前缀'} · 完整版本 ${app.revision}`
            }))]} /></div>
   {application ? <Alert type="info" title={`完整应用版本 ${application.revision} → 平台版本 ${entry.summary.revision}。勾选采用平台值；不勾选保留现场值，删除及现场冲突默认不选。`} style={{
            marginBottom: 10
          }} /> : <div className="mt-prefix"><label htmlFor="modbus-template-prefix">标签前缀（可选）</label><Input id="modbus-template-prefix" maxLength={256} value={prefix} onChange={event => setPrefix(event.target.value)} placeholder="例如：逆变器01_" /><Text type="secondary">仅添加，不覆盖已有点位</Text></div>}
   <Input prefix={<SearchOutlined />} aria-label="搜索点位" placeholder="搜索点位名称、地址或变更字段" value={pointSearch} onChange={event => setPointSearch(event.target.value)} allowClear />
   <div className="mt-selection"><Text>共 {planResult.rows.length} 项{application ? '差异' : ''}</Text><Space><Button size="small" onClick={() => setSelected(application ? planResult.updates.filter(row => row.selected).map(row => row.id) : initialSelection(entry))}>默认选择</Button><Button size="small" onClick={() => setSelected([])}>清空选择</Button></Space></div>
   <div className="mt-table-area"><Table<PreviewRow> rowKey="id" size="small" columns={columns} dataSource={rows} pagination={false} scroll={{
              x: 1000,
              y: 'max(150px, calc(100dvh - 490px))'
            }} rowSelection={{
              selectedRowKeys: selected,
              preserveSelectedRowKeys: true,
              onChange: keys => setSelected(keys.map(String)),
              getCheckboxProps: row => ({
                disabled: disabled || !!row.blocked
              })
            }} locale={{
              emptyText: application ? '没有待处理差异' : '没有匹配点位'
            }} /></div>
  </> : <Empty description="从平台获取模板后选择点位" />}</section></div>
 </Modal>;
}
