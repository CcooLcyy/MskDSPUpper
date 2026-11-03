import { useEffect, useState } from 'react';
import { Alert, Button, Collapse, Descriptions, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import type { AgcGroupInfo, AgcMemberConfig, AgcSignalSpec, DcPointUpdate } from '../../adapters';
import CapabilityGate from '../../offline/ui/CapabilityGate';
import ControlRuntimeStatus from './ControlRuntimeStatus';
import { calculateControlAllocationShares } from '../../utils/control-allocation';
import { inferAgcAllocationMode, resolveAgcDecimalText } from '../../utils/agc-decimal';
import { formatDecimalDisplay } from '../../utils/realtime-value';
import { getMemberRuntimeDifference, readRuntimeNumericText, runtimePointState, selectAgcOverviewUpdates } from '../../utils/agc-runtime-overview';
import './agc-runtime-overview.css';

export interface AgcRuntimeOverviewProps {
  group: AgcGroupInfo;
  updates: Record<string, DcPointUpdate>;
  publishedUpdates: Record<string, DcPointUpdate>;
  offline: boolean;
  loading: boolean;
  maxAgeMs: number;
  controlModeLabel: string;
  allocationLabel: string;
  commandModeLabel: string;
  runtimeAction: 'start' | 'stop' | 'delete' | null;
  startDisabled: boolean;
  stopDisabled: boolean;
  tuningDisabled: boolean;
  functionEnabled: boolean;
  remoteEnabled: boolean;
  pendingRouteError: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onStart: () => void;
  onStop: () => void;
  onTuning: () => void;
  onRefresh: () => void;
}

const { Text } = Typography;
const stateLabels: Record<number, string> = { 0: '未知', 1: '已停止', 2: '运行中', 3: '待删除' };
const qualityLabels: Record<number, string> = { 0: '未指定', 1: '有效', 2: '无效', 3: '不确定' };
const timestamp = (update: DcPointUpdate | undefined) => update && Number.isFinite(update.ts_ms) && update.ts_ms > 0
  && Number.isFinite(new Date(update.ts_ms).getTime()) ? new Date(update.ts_ms).toLocaleString('zh-CN', { hour12: false }) : '未知';
const cached = (update: DcPointUpdate | undefined) => {
  const value = readRuntimeNumericText(update);
  return value === null ? '—' : formatDecimalDisplay(value);
};

/** 集中展示真实缓存功率和成员对照，所有控制操作沿用页面回调。 */
export default function AgcRuntimeOverview(props: AgcRuntimeOverviewProps) {
  const { group, offline, maxAgeMs } = props;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const config = group.config;
  if (!config) return null;
  const publishedTags = [
    ...Object.values(config.outputs ?? {}).map(signal => signal?.tag ?? ''),
    ...config.members.map(member => member.p_set?.signal?.tag ?? ''),
  ];
  const updates = selectAgcOverviewUpdates(props.updates, props.publishedUpdates, publishedTags);
  const allocation = inferAgcAllocationMode(config.members);
  const shares = calculateControlAllocationShares(config.members.map(member => ({ controllable: member.controllable, weight: member.weight, basis: member.capacity_kw })));
  const observedTags = new Set<string>(group.default_points.map(point => point.tag));
  const add = (tag: string | undefined) => { if (tag?.trim()) observedTags.add(tag.trim()); };
  add(config.p_cmd?.signal?.tag);
  if (config.p_cmd?.mode === 2 && config.p_cmd.delta_base === 3) add(config.p_cmd.base_tag);
  Object.values(config.outputs ?? {}).forEach(signal => add(signal?.tag));
  config.members.forEach(member => {
    add(member.p_meas?.tag); add(member.p_set?.signal?.tag);
    if (member.p_set?.mode === 2 && member.p_set.delta_base === 3) add(member.p_set.base_tag);
  });
  const pointDetails = (label: string, signal: AgcSignalSpec | null | undefined) => {
    const point = signal?.tag ? updates[signal.tag] : undefined;
    return <Descriptions size="small" column={1} title={label}>
      <Descriptions.Item label="本地点名">{signal?.tag || '未配置'}</Descriptions.Item>
      <Descriptions.Item label="配置单位 / 缩放 / 偏移">{signal ? `${signal.unit || '未知'} / ${resolveAgcDecimalText(signal, 'scale', 'scale_decimal', '1')} / ${resolveAgcDecimalText(signal, 'offset', 'offset_decimal')}` : '—'}</Descriptions.Item>
      <Descriptions.Item label="点值时间">{timestamp(point)}</Descriptions.Item>
      <Descriptions.Item label="质量">{point ? qualityLabels[point.quality] ?? '未知' : '未知'}</Descriptions.Item>
    </Descriptions>;
  };
  const columns: ColumnsType<AgcMemberConfig> = [
    { title: '成员', key: 'name', width: 180, render: (_, member, index) => <div><Text strong>{member.member_name}</Text>
      <div className="agc-runtime-member-caption"><Text type="secondary">{member.controllable ? '可控' : '仅测量'} · 容量 {formatDecimalDisplay(resolveAgcDecimalText(member, 'capacity_kw', 'capacity_kw_decimal'))} kW</Text></div>
      {member.controllable && <div className="agc-runtime-member-caption"><Text type="secondary">{allocation === 'custom' ? `权重 ${formatDecimalDisplay(resolveAgcDecimalText(member, 'weight', 'weight_decimal', '1'))}` : `理论占比 ${((shares[index] ?? 0) * 100).toFixed(1)}%`}</Text></div>}
    </div> },
    { title: <Tooltip title="测量为数据中心缓存原值；非默认换算参数请展开详情核对。">实测</Tooltip>, key: 'measurement', align: 'right', width: 120, render: (_, member) => <span>{cached(member.p_meas?.tag ? updates[member.p_meas.tag] : undefined)} <Text type="secondary">{member.p_meas?.unit || ''}</Text></span> },
    { title: <Tooltip title="AGC 发布到数据中心的 kW 设定缓存，不等于设备已执行或执行成功；增量指令发布的是变化量。">已发布设定</Tooltip>, key: 'setpoint', align: 'right', width: 140, render: (_, member) => member.controllable ? <span>{cached(member.p_set?.signal?.tag ? updates[member.p_set.signal.tag] : undefined)} <Text type="secondary">kW{member.p_set?.mode === 2 ? '（增量）' : ''}</Text></span> : '—' },
    { title: <Tooltip title="仅比较同单位、默认换算参数的缓存值；不同时间的缓存差不代表设备跟踪故障。">设定 − 实测</Tooltip>, key: 'difference', align: 'right', width: 150, render: (_, member) => {
      const difference = getMemberRuntimeDifference(member, member.p_meas?.tag ? updates[member.p_meas.tag] : undefined, member.p_set?.signal?.tag ? updates[member.p_set.signal.tag] : undefined);
      return difference === null ? <Tooltip title={member.p_set?.mode === 2 ? '增量设定，不计算绝对偏差' : '仅绝对值指令、默认换算、kW 单位且两个缓存均为合法数值时比较；请展开核对配置'}>—</Tooltip> : <Tooltip title={`缓存原始差值 ${difference} kW`}>{formatDecimalDisplay(difference)} kW</Tooltip>;
    } },
    { title: '测量状态', key: 'quality', width: 150, render: (_, member) => {
      const state = runtimePointState(member.p_meas?.tag ? updates[member.p_meas.tag] : undefined, nowMs, maxAgeMs, offline);
      return <Text type={state === '新鲜 · 有效' ? 'success' : 'warning'}>{state}</Text>;
    } },
  ];
  return <section className="agc-runtime-overview" aria-label="AGC 功率总览">
    <div className="agc-runtime-heading">
      <div><Space wrap><Typography.Title level={4}>{config.group_name}</Typography.Title><Tag color={group.state === 2 ? 'green' : 'default'}>{stateLabels[group.state] ?? '未知'}</Tag><Tag>{props.functionEnabled ? '功能投入' : '功能退出'}</Tag><Tag>{props.remoteEnabled ? '远方' : '就地'}</Tag></Space>
        <div className="agc-runtime-context"><Text type="secondary">{props.controlModeLabel} · {props.allocationLabel} · {props.commandModeLabel}</Text></div>
      </div>
      <Space wrap>
        <Button icon={<EditOutlined />} onClick={props.onEdit} disabled={props.runtimeAction !== null || props.pendingRouteError}>编辑</Button>
        <Button aria-label="刷新运行数据" icon={<ReloadOutlined />} loading={props.loading} onClick={props.onRefresh} />
        <CapabilityGate need="runtime.control">
          {group.state === 2 ? <Popconfirm title="确认停止该控制组？" okText="停止控制组" cancelText="取消" onConfirm={props.onStop}><Button danger icon={<PauseCircleOutlined />} loading={props.runtimeAction === 'stop'} disabled={props.stopDisabled}>停止控制组</Button></Popconfirm>
            : <Button type="primary" icon={<PlayCircleOutlined />} loading={props.runtimeAction === 'start'} disabled={props.startDisabled} onClick={props.onStart}>启动控制组</Button>}
        </CapabilityGate>
      </Space>
    </div>
    <ControlRuntimeStatus updates={updates} tags={[...observedTags]} maxAgeMs={maxAgeMs} offline={offline} details />
    <div className="agc-runtime-power-grid">
      {[
        { label: '总有功目标', signal: config.outputs?.p_total_target, description: 'AGC 本轮实际可下发的总目标，受成员出力约束。' },
        { label: '总有功实测', signal: config.outputs?.p_total_meas, description: 'AGC 已发布的总有功测量工程量，单位为 kW。' },
        { label: '总有功偏差', signal: config.outputs?.p_total_error, description: 'AGC 按期望总目标减总实测计算的偏差；受限时与实际可下发目标的口径可能不同。' },
      ].map(({ label, signal, description }) => {
        const point = signal?.tag ? updates[signal.tag] : undefined;
        const state = runtimePointState(point, nowMs, maxAgeMs, offline);
        return <article key={label} aria-label={label} className="agc-runtime-power-card"><Tooltip title={description}><Text type="secondary">{label}</Text></Tooltip><div className="agc-runtime-power-value">{cached(point)} <span>kW</span></div><Text type={state === '新鲜 · 有效' ? 'secondary' : 'warning'}>{signal?.tag ? state : '未配置输出点'}</Text></article>;
      })}
    </div>
    {group.last_error && <Alert type="error" showIcon title="最近错误" description={group.last_error} />}
    <div className="agc-runtime-section-heading"><Text strong>成员运行</Text><Text type="secondary">{config.members.length} 个成员 · 缓存值对照</Text></div>
    <Table<AgcMemberConfig> className="agc-runtime-members" rowKey={(member, index) => `${member.member_name}-${index}`} columns={columns} dataSource={config.members} pagination={false} size="small" scroll={{ x: 800 }} locale={{ emptyText: '暂无成员配置' }} expandable={{
      expandedRowRender: member => <div className="agc-runtime-point-details">{pointDetails('测量点', member.p_meas)}{member.controllable && pointDetails('已发布设定点', member.p_set?.signal)}<Text type="secondary">调节范围 {formatDecimalDisplay(resolveAgcDecimalText(member, 'min_kw', 'min_kw_decimal'))}～{formatDecimalDisplay(resolveAgcDecimalText(member, 'max_kw', 'max_kw_decimal'))} kW</Text></div>,
      expandIcon: ({ expanded, onExpand, record }) => <Button type="link" size="small" aria-label={`${expanded ? '收起' : '展开'}成员 ${record.member_name}`} onClick={event => {
        console.info('AGC 成员运行详情切换', { 成员: record.member_name, 展开: !expanded }); onExpand(record, event);
      }}>{expanded ? '收起' : '展开'}</Button>,
      columnTitle: '详情', columnWidth: 72,
    }} />
    <Collapse ghost items={[{ key: 'config', label: '配置与点位详情', children: <>
      <Descriptions size="small" column={{ xs: 1, sm: 2 }}><Descriptions.Item label="连接 ID">{group.conn_id}</Descriptions.Item><Descriptions.Item label="成员数量">{config.members.length}</Descriptions.Item><Descriptions.Item label="控制方式">{props.controlModeLabel}</Descriptions.Item><Descriptions.Item label="分配方式">{props.allocationLabel}</Descriptions.Item><Descriptions.Item label="命令模式">{props.commandModeLabel}</Descriptions.Item>{config.control_mode === 2 && <Descriptions.Item label="控制周期">计算 {config.calculation_execution_period_seconds} 秒 / 命令 {config.command_control_period_seconds} 秒</Descriptions.Item>}</Descriptions>
      {pointDetails('总控输入', config.p_cmd?.signal)}
      <div className="agc-runtime-point-details">{pointDetails('总有功目标', config.outputs?.p_total_target)}{pointDetails('总有功实测', config.outputs?.p_total_meas)}{pointDetails('总有功偏差', config.outputs?.p_total_error)}</div>
      <Space wrap><CapabilityGate need="runtime.control"><Tooltip title={props.tuningDisabled ? group.state === 3 ? '待删除的控制组不能开始自动调试。' : '运行中的控制组须先停止后才能开始新的自动调试；已有调试任务可继续查看。' : '查看或启动自动调试任务'}><span><Button onClick={props.onTuning} disabled={props.tuningDisabled}>自动调试参数</Button></span></Tooltip></CapabilityGate>
        <Popconfirm title={`确认删除 ${config.group_name}？${group.state === 2 ? ' 删除前会停止正在运行的控制组。' : ''}`} onConfirm={props.onDelete}><Button danger icon={<DeleteOutlined />} loading={props.runtimeAction === 'delete'} disabled={props.runtimeAction !== null || props.pendingRouteError}>{group.state === 3 ? '重试删除' : '删除'}</Button></Popconfirm>
      </Space>
    </> }]} onChange={keys => console.info('AGC 配置详情切换', { 展开项: keys })} />
  </section>;
}
