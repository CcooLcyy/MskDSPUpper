import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Input, InputNumber, Select, Space, Statistic, Table, Typography, message } from 'antd';
import { DownloadOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api, type Iec104Point, type Iec104SoeQuery, type Iec104SoeRecord } from '../../adapters';

const { Text } = Typography;
const PAGE_SIZE = 100;

const formatBeijingTime = (tsMs: number): string => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(new Date(tsMs));

const parseBeijingInput = (value: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0'] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second));
};

const stateLabel = (state: boolean): string => state ? '合' : '分';
const qualityLabel = (quality: number): string => `0x${quality.toString(16).padStart(2, '0').toUpperCase()}`;

const csvCell = (value: unknown): string => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

interface Props {
  connName: string | null;
  points: Iec104Point[];
}

const SoeHistoryPanel: React.FC<Props> = ({ connName, points }) => {
  const [rows, setRows] = useState<Iec104SoeRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [unacknowledgedCount, setUnacknowledgedCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startInput, setStartInput] = useState('');
  const [endInput, setEndInput] = useState('');
  const [ioaInput, setIoaInput] = useState<number | null>(null);
  const [acknowledgedFilter, setAcknowledgedFilter] = useState<number | undefined>(undefined);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const loadRef = useRef<(beforeEventSequence?: number, silent?: boolean) => Promise<void>>(() => Promise.resolve());
  const requestIdRef = useRef(0);
  const pointNameByIoa = useMemo(
    () => new Map(points.map((point) => [point.ioa, point.tag.trim()])),
    [points],
  );
  const getPointName = useCallback(
    (ioa: number): string => pointNameByIoa.get(ioa) || '未配置',
    [pointNameByIoa],
  );

  const buildQuery = useCallback((beforeEventSequence?: number): Iec104SoeQuery | null => {
    if (!connName) return null;
    return {
      conn_name: connName,
      start_ts_ms: parseBeijingInput(startInput),
      end_ts_ms: parseBeijingInput(endInput),
      ioa: ioaInput == null ? null : ioaInput,
      acknowledged_filter: acknowledgedFilter ?? 0,
      page_size: PAGE_SIZE,
      before_event_sequence: beforeEventSequence ?? null,
    };
  }, [acknowledgedFilter, connName, endInput, ioaInput, startInput]);

  const load = useCallback(async (beforeEventSequence?: number, silent = false): Promise<void> => {
    const query = buildQuery(beforeEventSequence);
    if (!query) {
      setRows([]); setTotalCount(0); setUnacknowledgedCount(0); setHasMore(false); return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true); setError(null);
    try {
      const page = await api.iec104QuerySoe(query);
      if (requestId !== requestIdRef.current) return;
      setRows(page.events);
      setTotalCount(page.total_count);
      setUnacknowledgedCount(page.unacknowledged_count);
      setHasMore(page.has_more);
      setLastRefreshAt(Date.now());
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      const text = cause instanceof Error ? cause.message : String(cause);
      setError(text);
      if (!silent) messageApi.error(`SOE 查询失败：${text}`);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [buildQuery, messageApi]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
    // 连接切换时立即加载；筛选条件由“查询”按钮显式提交。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connName]);

  useEffect(() => {
    if (!connName) return undefined;
    const timer = window.setInterval(() => { void loadRef.current(undefined, true); }, 5000);
    return () => window.clearInterval(timer);
    // 自动刷新仅随连接切换重建，筛选条件由“查询”按钮提交。
  }, [connName]);

  const exportRows = useCallback((items: Iec104SoeRecord[], filename: string) => {
    const header = ['事件序号', 'IOA', '名称', '状态', '事件时标（北京时间）', '品质', '确认状态'];
    const lines = [header, ...items.map((row) => [
      row.event_sequence, row.ioa, getPointName(row.ioa), stateLabel(row.state), formatBeijingTime(row.ts_ms), qualityLabel(row.quality), row.acknowledged ? '已确认' : '未确认',
    ])].map((line) => line.map(csvCell).join(','));
    const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
  }, [getPointName]);

  const exportAll = useCallback(async (): Promise<void> => {
    const first = buildQuery();
    if (!first) return;
    setLoading(true);
    try {
      const all: Iec104SoeRecord[] = [];
      let cursor: number | undefined;
      let guard = 0;
      do {
        const page = await api.iec104QuerySoe({ ...first, before_event_sequence: cursor ?? null, page_size: 8000 });
        all.push(...page.events);
        cursor = page.has_more ? (page.next_event_sequence ?? undefined) : undefined;
        guard += 1;
      } while (cursor != null && guard < 4);
      exportRows(all, `iec104-soe-${connName}-${new Date().toISOString().slice(0, 10)}.csv`);
      messageApi.success(`已导出 ${all.length} 条 SOE 记录`);
    } catch (cause) {
      messageApi.error(`导出失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { setLoading(false); }
  }, [buildQuery, connName, exportRows, messageApi]);

  const columns = useMemo<ColumnsType<Iec104SoeRecord>>(() => [
    { title: '事件序号', dataIndex: 'event_sequence', key: 'sequence', width: 110 },
    { title: 'IOA', dataIndex: 'ioa', key: 'ioa', width: 90 },
    { title: '名称', key: 'name', width: 180, ellipsis: true, render: (_value: unknown, row: Iec104SoeRecord) => getPointName(row.ioa) },
    { title: '状态', dataIndex: 'state', key: 'state', width: 90, render: (value: boolean) => stateLabel(value) },
    { title: '事件时标（北京时间）', dataIndex: 'ts_ms', key: 'ts', width: 210, render: (value: number) => formatBeijingTime(value) },
    { title: '品质', dataIndex: 'quality', key: 'quality', width: 90, render: (value: number) => qualityLabel(value) },
    { title: '确认状态', dataIndex: 'acknowledged', key: 'ack', width: 110, render: (value: boolean) => value ? <Text type="success">已确认</Text> : <Text type="warning">未确认</Text> },
  ], [getPointName]);

  if (!connName) return <Card title="SOE 历史" size="small"><Text type="secondary">请先从左侧选择连接。</Text></Card>;

  return <>
    {contextHolder}
    <Card title={<Space><span>SOE 历史</span><Text type="secondary">{connName}</Text></Space>} size="small" bordered className="protocol-soe-card"
      extra={<Space><Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button><Button size="small" icon={<DownloadOutlined />} disabled={rows.length === 0} onClick={() => exportRows(rows, `iec104-soe-${connName}-当前页.csv`)}>导出当前页</Button><Button size="small" icon={<DownloadOutlined />} loading={loading} disabled={totalCount === 0} onClick={() => void exportAll()}>导出全部</Button></Space>}
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Input aria-label="开始时间（北京时间）" type="datetime-local" size="small" value={startInput} onChange={(event) => setStartInput(event.target.value)} />
        <span>至</span>
        <Input aria-label="结束时间（北京时间）" type="datetime-local" size="small" value={endInput} onChange={(event) => setEndInput(event.target.value)} />
        <InputNumber aria-label="IOA" size="small" min={0} max={16777215} placeholder="IOA" value={ioaInput ?? undefined} onChange={(value) => setIoaInput(value == null ? null : Number(value))} />
        <Select aria-label="确认状态" size="small" allowClear placeholder="全部确认状态" value={acknowledgedFilter} options={[{ value: 1, label: '已确认' }, { value: 2, label: '未确认' }]} onChange={(value) => setAcknowledgedFilter(value)} />
        <Button type="primary" size="small" icon={<SearchOutlined />} onClick={() => void load()}>查询</Button>
      </Space>
      {error ? <Alert type="warning" showIcon message="SOE 查询失败" description={error} style={{ marginBottom: 12 }} /> : null}
      <Space size={24} style={{ marginBottom: 12 }}>
        <Statistic title="缓存总数" value={totalCount} suffix="条" />
        <Statistic title="未确认" value={unacknowledgedCount} suffix="条" />
        <Text type="secondary">每 5 秒自动刷新{lastRefreshAt ? ` · 最近 ${formatBeijingTime(lastRefreshAt)}` : ''}</Text>
      </Space>
      <Table<Iec104SoeRecord> rowKey="event_sequence" size="small" loading={loading} columns={columns} dataSource={rows} pagination={false} scroll={{ x: 940 }} locale={{ emptyText: '暂无 SOE 记录' }} />
      {hasMore ? <Button type="link" size="small" onClick={() => void load(rows[rows.length - 1]?.event_sequence)}>加载更早记录</Button> : null}
    </Card>
  </>;
};

export default SoeHistoryPanel;
