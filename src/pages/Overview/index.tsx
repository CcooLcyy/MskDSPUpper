import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Space,
  Statistic,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  AlertOutlined,
  ApiOutlined,
  AppstoreOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  ControlOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  NodeIndexOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../../adapters';
import type { DcConnectionInfo, DcPointValue, DcSourcePointUpdate, ModuleInfo, ModuleRunningInfo } from '../../adapters';
import type { DataBusThroughputSample, DataBusThroughputSnapshot } from '../../adapters';
import { loadDashboardAfterRunningModules } from '../../utils/dashboard-loading';
import { startOverviewPolling } from '../../utils/overview-polling';
import { subscribeManagerRuntimeRefreshed } from '../../utils/manager-runtime-events';
import { getStoredManagerAddress } from '../../utils/app-settings';
import { useWorkbench } from '../../workbench/workbench-context';
import { useAppMode } from '../../offline/app-mode-context';
import { EngineeringStart } from '../../workbench/EngineeringStart';
import './index.css';

const { Text, Title } = Typography;

const DEFAULT_MANAGER_ADDR = '127.0.0.1:17000';

type SyncState = 'idle' | 'loading' | 'success' | 'partial' | 'error';

type SummaryCard = {
  title: string;
  value: number | string;
  icon: React.ReactNode;
  path: string;
  hint: string;
  color?: string;
  iconColor?: string;
};

type DashboardData = {
  modules: ModuleInfo[];
  runningModules: ModuleRunningInfo[];
  protocolLinkCount: number;
  agcGroupCount: number;
  routeCount: number;
};

function formatSyncTime(timestamp: number | null) {
  if (!timestamp) {
    return '尚未同步';
  }

  return `最近同步 ${new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp)}`;
}

const DEVICE_RUNTIME_MODULE = 'DeviceInfo';
const DEVICE_RUNTIME_CONNECTION = 'device-runtime';
const DEVICE_RUNTIME_TAGS = ['cpu.usage_percent', 'memory.usage_percent'] as const;

type DeviceRuntimeMetric = {
  value: number | null;
  tsMs: number;
  quality: number;
};

type DeviceRuntimeState = {
  cpu: DeviceRuntimeMetric;
  memory: DeviceRuntimeMetric;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  error: string;
};

const EMPTY_DEVICE_RUNTIME_METRIC: DeviceRuntimeMetric = { value: null, tsMs: 0, quality: 0 };

const emptyDeviceRuntimeState = (): DeviceRuntimeState => ({
  cpu: EMPTY_DEVICE_RUNTIME_METRIC,
  memory: EMPTY_DEVICE_RUNTIME_METRIC,
  status: 'idle',
  error: '',
});

function pointValueToNumber(value: DcPointValue | null): number | null {
  if (!value) {
    return null;
  }
  const numericValue = value.type === 'Double'
    ? value.value
    : value.type === 'Decimal'
      ? Number(value.value)
      : Number.NaN;
  if (!Number.isFinite(numericValue)) return null;
  return Math.max(0, Math.min(100, numericValue));
}

function deviceRuntimeMetric(updates: DcSourcePointUpdate[], tag: string): DeviceRuntimeMetric {
  const update = updates.find((item) => item.tag === tag);
  return update
    ? { value: pointValueToNumber(update.value), tsMs: update.ts_ms, quality: update.quality }
    : EMPTY_DEVICE_RUNTIME_METRIC;
}

function deviceQuality(quality: number): { label: string; color: string } {
  if (quality === 1) return { label: '正常', color: 'green' };
  if (quality === 2) return { label: '异常', color: 'red' };
  if (quality === 3) return { label: '不确定', color: 'orange' };
  return { label: '未指定', color: 'default' };
}

function deviceMetricTime(tsMs: number): string {
  if (tsMs <= 0) return '暂无数据时间';
  return `数据时间 ${new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(tsMs)}`;
}

type ThroughputChartPoint = {
  x: number;
  y: number;
};

type ThroughputChartTick = {
  label: string;
  x?: number;
  y?: number;
  position?: 'first' | 'middle' | 'last';
};

type ThroughputChartGeometry = {
  areaPath: string;
  linePath: string;
  points: ThroughputChartPoint[];
  xTicks: ThroughputChartTick[];
  yTicks: ThroughputChartTick[];
};

const THROUGHPUT_CHART_WIDTH = 720;
const THROUGHPUT_CHART_HEIGHT = 208;
const THROUGHPUT_CHART_PADDING_LEFT = 58;
const THROUGHPUT_CHART_PADDING_RIGHT = 16;
const THROUGHPUT_CHART_PADDING_TOP = 26;
const THROUGHPUT_CHART_PADDING_BOTTOM = 34;
const THROUGHPUT_CHART_MIN_RANGE = 20;

function formatThroughputChartTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function buildThroughputChartGeometry(samples: DataBusThroughputSample[]): ThroughputChartGeometry {
  if (samples.length === 0) {
    return { areaPath: '', linePath: '', points: [], xTicks: [], yTicks: [] };
  }

  const values = samples.map((sample) => sample.routed_points_per_second);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valuePadding = Math.max(1, (maxValue - minValue) * 0.15);
  let chartMin = Math.max(0, minValue - valuePadding);
  let chartMax = maxValue + valuePadding;
  if (chartMax - chartMin < THROUGHPUT_CHART_MIN_RANGE) {
    const center = (chartMin + chartMax) / 2;
    chartMin = Math.max(0, center - THROUGHPUT_CHART_MIN_RANGE / 2);
    chartMax = chartMin + THROUGHPUT_CHART_MIN_RANGE;
  }
  const chartRange = Math.max(1, chartMax - chartMin);
  const chartWidth = THROUGHPUT_CHART_WIDTH - THROUGHPUT_CHART_PADDING_LEFT - THROUGHPUT_CHART_PADDING_RIGHT;
  const chartHeight = THROUGHPUT_CHART_HEIGHT - THROUGHPUT_CHART_PADDING_TOP - THROUGHPUT_CHART_PADDING_BOTTOM;
  const baselineY = THROUGHPUT_CHART_HEIGHT - THROUGHPUT_CHART_PADDING_BOTTOM;

  const points: ThroughputChartPoint[] = values.map((value, index) => ({
    x: THROUGHPUT_CHART_PADDING_LEFT + (values.length === 1 ? chartWidth / 2 : (index / (values.length - 1)) * chartWidth),
    y: THROUGHPUT_CHART_PADDING_TOP + ((chartMax - value) / chartRange) * chartHeight,
  }));

  let linePath = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midpointX = (previous.x + current.x) / 2;
    const midpointY = (previous.y + current.y) / 2;
    linePath += ` Q ${previous.x} ${previous.y} ${midpointX} ${midpointY}`;
  }

  const lastPoint = points[points.length - 1];
  linePath += ` Q ${lastPoint.x} ${lastPoint.y} ${lastPoint.x} ${lastPoint.y}`;
  const areaPath = `${linePath} L ${lastPoint.x} ${baselineY} L ${points[0].x} ${baselineY} Z`;
  const yTicks = Array.from({ length: 4 }, (_, index) => {
    const ratio = index / 3;
    return {
      label: String(Math.round(chartMax - chartRange * ratio)),
      y: THROUGHPUT_CHART_PADDING_TOP + chartHeight * ratio,
    };
  });
  const xTickIndexes = Array.from(
    new Set([0, Math.floor((samples.length - 1) / 2), samples.length - 1]),
  );
  const xTicks = xTickIndexes.map((index) => ({
    label: formatThroughputChartTime(samples[index].timestamp_ms),
    x: points[index].x,
    position: index === 0 ? 'first' as const : index === samples.length - 1 ? 'last' as const : 'middle' as const,
  }));

  return { areaPath, linePath, points, xTicks, yTicks };
}

const OnlineOverview: React.FC = () => {
  const navigate = useNavigate();
  const { view } = useWorkbench();
  const [dashboardData, setDashboardData] = useState<DashboardData>({
    modules: [],
    runningModules: [],
    protocolLinkCount: 0,
    agcGroupCount: 0,
    routeCount: 0,
  });
  const [loading, setLoading] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [failedSections, setFailedSections] = useState<string[]>([]);
  const [throughput, setThroughput] = useState<DataBusThroughputSnapshot | null>(null);
  const [deviceRuntime, setDeviceRuntime] = useState<DeviceRuntimeState>(emptyDeviceRuntimeState);
  const [runtimeRefreshKey, setRuntimeRefreshKey] = useState(0);
  const refreshGeneration = useRef(0);
  const [messageApi, contextHolder] = message.useMessage();

  const refresh = useCallback(async ({ preserveConnection = false }: { preserveConnection?: boolean } = {}) => {
    const generation = ++refreshGeneration.current;
    setRuntimeRefreshKey(0);
    setLoading(true);
    setSyncState('loading');

    try {
      if (!preserveConnection) {
        const managerAddr = getStoredManagerAddress(DEFAULT_MANAGER_ADDR);
        await api.setManagerAddr(managerAddr);
      }
      if (generation !== refreshGeneration.current) return;

      const {
        modules: modulesResult,
        runningModules: runningModulesResult,
        iec104Links: iec104LinksResult,
        modbusLinks: modbusLinksResult,
        modbusTcpLinks: modbusTcpLinksResult,
        dlt645Links: dlt645LinksResult,
        agcGroups: agcGroupsResult,
        routes: routesResult,
      } = await loadDashboardAfterRunningModules({
        getModuleInfo: api.getModuleInfo,
        getRunningModuleInfo: api.getRunningModuleInfo,
        listIec104Links: api.iec104ListLinks,
        listModbusLinks: api.modbusRtuListLinks,
        listModbusTcpLinks: api.modbusTcpListLinks,
        listDlt645Links: api.dlt645ListLinks,
        listAgcGroups: api.agcListGroups,
        listRoutes: () => api.dcListRoutes(0, '', 0, ''),
      });

      if (generation !== refreshGeneration.current) return;
      if (runningModulesResult.status === 'fulfilled') {
        setRuntimeRefreshKey(generation);
        console.info('[系统总览] 模块地址已就绪，开始读取设备指标与吞吐量', { generation });
      } else {
        console.warn('[系统总览] 运行模块地址刷新失败，已暂停指标读取', runningModulesResult.reason);
      }

      const modules = modulesResult.status === 'fulfilled' ? modulesResult.value : [];
      const runningModules = runningModulesResult.status === 'fulfilled' ? runningModulesResult.value : [];
      const protocolLinkCount =
        (iec104LinksResult.status === 'fulfilled' ? iec104LinksResult.value.length : 0) +
        (modbusLinksResult.status === 'fulfilled' ? modbusLinksResult.value.length : 0) +
        (modbusTcpLinksResult.status === 'fulfilled' ? modbusTcpLinksResult.value.length : 0) +
        (dlt645LinksResult.status === 'fulfilled' ? dlt645LinksResult.value.length : 0);
      const agcGroupCount = agcGroupsResult.status === 'fulfilled' ? agcGroupsResult.value.length : 0;
      const routeCount = routesResult.status === 'fulfilled' ? routesResult.value.length : 0;

      setDashboardData({
        modules,
        runningModules,
        protocolLinkCount,
        agcGroupCount,
        routeCount,
      });

      const failed = [
        modulesResult.status === 'rejected' ? '模块清单' : null,
        runningModulesResult.status === 'rejected' ? '运行状态' : null,
        iec104LinksResult.status === 'rejected' ? 'IEC104 链路' : null,
        modbusLinksResult.status === 'rejected' ? 'ModbusRTU 链路' : null,
        modbusTcpLinksResult.status === 'rejected' ? 'ModbusTCP 链路' : null,
        dlt645LinksResult.status === 'rejected' ? 'DLT645 链路' : null,
        agcGroupsResult.status === 'rejected' ? 'AGC 控制组' : null,
        routesResult.status === 'rejected' ? '数据路由' : null,
      ].filter((item): item is string => item !== null);

      setFailedSections(failed);
      setLastSyncedAt(Date.now());
      setSyncState(failed.length > 0 ? 'partial' : 'success');

      if (failed.length > 0) {
        messageApi.warning(`部分首页数据加载失败: ${failed.join('、')}`);
      }
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      console.warn('[系统总览] 地址初始化失败，已暂停指标读取', error);
      setFailedSections(['ModuleManager 连接']);
      setSyncState('error');
      messageApi.error(`首页数据加载失败: ${error}`);
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    void refresh();
    return () => { refreshGeneration.current += 1; };
  }, [refresh]);

  useEffect(() => subscribeManagerRuntimeRefreshed(() => {
    // 更新任务已经恢复当前连接，读取概况与指标时保留当前目标和地址。
    void refresh({ preserveConnection: true });
  }), [refresh]);

  useEffect(() => {
    if (runtimeRefreshKey === 0) return;
    let failed = false;
    return startOverviewPolling({
      isCurrent: () => runtimeRefreshKey === refreshGeneration.current,
      read: async () => {
        const connections = await api.dcListConnections();
        const connection = connections.find(
          (item: DcConnectionInfo) => item.module_name === DEVICE_RUNTIME_MODULE
            && item.conn_name === DEVICE_RUNTIME_CONNECTION,
        );
        if (!connection) {
          throw new Error('DeviceInfo 运行指标连接未注册');
        }
        const connTags = await api.dcGetConnTags(connection.conn_id);
        const missingTags = DEVICE_RUNTIME_TAGS.filter((tag) => !connTags.tags.includes(tag));
        if (missingTags.length > 0) {
          throw new Error(`DeviceInfo 运行指标标签未注册: ${missingTags.join('、')}`);
        }
        const updates = await api.dcGetSourceLatest(connection.conn_id, [...DEVICE_RUNTIME_TAGS]);
        return {
          cpu: deviceRuntimeMetric(updates, DEVICE_RUNTIME_TAGS[0]),
          memory: deviceRuntimeMetric(updates, DEVICE_RUNTIME_TAGS[1]),
          status: 'ready' as const,
          error: '',
        };
      },
      onValue: (value) => {
        if (failed) console.info('[系统总览] 设备运行指标读取已恢复');
        failed = false;
        setDeviceRuntime(value);
      },
      onError: (error) => {
        if (!failed) console.warn('[系统总览] 设备运行指标读取失败，将继续重试', error);
        failed = true;
        setDeviceRuntime((current) => ({ ...current, status: 'unavailable', error: String(error) }));
      },
      intervalMs: 5000,
    });
  }, [runtimeRefreshKey]);

  useEffect(() => {
    if (runtimeRefreshKey === 0) return;
    let failed = false;
    return startOverviewPolling({
      isCurrent: () => runtimeRefreshKey === refreshGeneration.current,
      read: () => api.getDataBusThroughputSnapshot(),
      onValue: (value) => {
        if (failed) console.info('[系统总览] 吞吐量读取已恢复');
        failed = false;
        setThroughput(value);
      },
      onError: (error) => {
        setThroughput({
          source: 'unavailable',
          process_start_time_ms: null,
          samples: [],
          current_points_per_second: 0,
          peak_points_per_second: 0,
          updated_at_ms: null,
        });
        if (!failed) {
          console.warn('[系统总览] 吞吐量读取失败，将继续重试', error);
          messageApi.warning(`吞吐量数据暂不可用: ${error}`);
        }
        failed = true;
      },
      intervalMs: 1000,
    });
  }, [messageApi, runtimeRefreshKey]);

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      {
        title: '发现模块',
        value: failedSections.includes('模块清单') || syncState === 'error' || !lastSyncedAt ? '-' : dashboardData.modules.length,
        icon: <AppstoreOutlined />,
        path: '/module-ops',
        hint: '进入模块运维',
        iconColor: '#8b9aaa',
      },
      {
        title: '运行模块',
        value: failedSections.includes('运行状态') || syncState === 'error' || !lastSyncedAt ? '-' : dashboardData.runningModules.length,
        icon: <PlayCircleOutlined />,
        path: '/module-ops',
        hint: '查看运行状态',
        color: '#52c41a',
        iconColor: '#52c41a',
      },
      {
        title: '协议连接',
        value: failedSections.some(section => section.endsWith('链路')) || syncState === 'error' || !lastSyncedAt ? '-' : dashboardData.protocolLinkCount,
        icon: <ApiOutlined />,
        path: '/protocol/iec104',
        hint: '已配置 IEC104 / Modbus RTU、TCP / DLT645',
        iconColor: '#36cfc9',
      },
      {
        title: 'AGC 控制组',
        value: failedSections.includes('AGC 控制组') || syncState === 'error' || !lastSyncedAt ? '-' : dashboardData.agcGroupCount,
        icon: <ControlOutlined />,
        path: '/control?module=agc',
        hint: '查看控制策略',
        iconColor: '#faad14',
      },
      {
        title: '数据路由',
        value: failedSections.includes('数据路由') || syncState === 'error' || !lastSyncedAt ? '-' : dashboardData.routeCount,
        icon: <NodeIndexOutlined />,
        path: '/data-bus',
        hint: '进入数据总线',
        iconColor: '#69b1ff',
      },
    ],
    [dashboardData, failedSections, syncState, lastSyncedAt],
  );

  const syncBadgeStatus = loading
    ? 'processing'
    : syncState === 'error'
      ? 'error'
      : syncState === 'partial'
        ? 'warning'
        : syncState === 'success'
          ? 'success'
          : 'default';
  const syncLabel = loading
    ? '同步中'
    : syncState === 'error'
      ? '同步失败'
      : syncState === 'partial'
        ? '部分同步'
        : syncState === 'success'
          ? '已同步'
          : '等待同步';

  const navigateToCard = useCallback(
    (path: string) => {
      navigate(path);
    },
    [navigate],
  );

  const throughputValues = throughput?.samples.map((sample) => sample.routed_points_per_second) ?? [];
  const throughputChartGeometry = buildThroughputChartGeometry(throughput?.samples ?? []);
  const latestThroughputPoint = throughputChartGeometry.points.at(-1);
  const throughputSourceLabel = throughput?.source === 'browser-demo'
    ? '浏览器演示'
    : throughput?.source === 'backend'
      ? '真实数据'
      : '接口待接入';

  return (
    <div className="overview-page">
      {contextHolder}

      <header className="overview-header">
        <div className="overview-heading">
          <Text className="overview-eyebrow">MSKDSP / RUNTIME</Text>
          <Title level={2} className="overview-title">
            {view === 'engineering' ? '工程总览' : '运行总览'}
          </Title>
        </div>
        <div className="overview-header-actions">
          <div className="overview-sync-status" aria-live="polite">
            <Badge status={syncBadgeStatus} text={syncLabel} />
            <Text type="secondary">{formatSyncTime(lastSyncedAt)}</Text>
          </div>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void refresh()}
          >
            刷新
          </Button>
        </div>
      </header>

      {view === 'engineering' ? <EngineeringStart /> : <div className="workbench-runtime-intro"><Text strong>运行监视</Text><Text type="secondary">模块、协议数量表示配置规模；链路健康、实时品质及控制状态请进入对应对象查看。</Text><Space wrap><Button onClick={() => navigate('/data-bus')}>查看实时数据</Button><Button onClick={() => navigate('/control')}>查看控制状态</Button></Space></div>}

      {failedSections.length > 0 && (
        <div className="overview-sync-warning" role="status">
          <AlertOutlined />
          <span>以下数据未能同步：{failedSections.join('、')}</span>
        </div>
      )}

      <section className="overview-section" aria-labelledby="overview-summary-title">
        <div className="overview-section-heading">
          <div>
            <Text id="overview-summary-title" strong>
              运行概况
            </Text>
            <Text type="secondary">已接入接口返回的当前快照</Text>
          </div>
          <Space size={6} className="overview-source-note">
            <CheckCircleOutlined />
            <Text type="secondary">ModuleManager</Text>
          </Space>
        </div>

        <div className="overview-summary-grid">
          {summaryCards.map((card) => (
            <Card
              key={card.title}
              size="small"
              bordered
              className="overview-stat-card overview-stat-card--link"
              role="link"
              tabIndex={0}
              aria-label={`${card.title} ${card.value}，${card.hint}`}
              onClick={() => navigateToCard(card.path)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  navigateToCard(card.path);
                }
              }}
            >
              <div className="overview-stat-card-head">
                <Text type="secondary">{card.title}</Text>
                <span
                  className="overview-stat-icon"
                  aria-hidden="true"
                  style={{
                    color: card.iconColor,
                    borderColor: card.iconColor ? `${card.iconColor}66` : undefined,
                    backgroundColor: card.iconColor ? `${card.iconColor}16` : undefined,
                  }}
                >
                  {card.icon}
                </span>
              </div>
              <Statistic
                value={card.value}
                valueStyle={{ color: card.color, fontSize: 28 }}
              />
              <div className="overview-stat-card-footer">
                <Text type="secondary">{card.hint}</Text>
                <ArrowRightOutlined />
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="overview-section" aria-labelledby="overview-device-runtime-title">
        <div className="overview-section-heading">
          <div>
            <Text id="overview-device-runtime-title" strong>设备运行指标</Text>
            <Text type="secondary">来自 DeviceInfo / device-runtime</Text>
          </div>
          <Tag color={deviceRuntime.status === 'ready' ? 'success' : deviceRuntime.status === 'loading' ? 'processing' : 'default'}>
            {deviceRuntime.status === 'ready' ? '已连接' : deviceRuntime.status === 'loading' ? '读取中' : '暂不可用'}
          </Tag>
        </div>
        <div className="overview-runtime-grid">
          {[
            { key: 'cpu', title: 'CPU 占用率', icon: <DashboardOutlined />, metric: deviceRuntime.cpu, color: '#69b1ff' },
            { key: 'memory', title: '内存占用率', icon: <DatabaseOutlined />, metric: deviceRuntime.memory, color: '#95de64' },
          ].map(({ key, title, icon, metric, color }) => {
            const quality = deviceQuality(metric.quality);
            return (
              <Card key={key} size="small" className="overview-runtime-card" bordered>
                <div className="overview-runtime-card-head">
                  <Space size={8}><span className="overview-runtime-icon" style={{ color }}>{icon}</span><Text type="secondary">{title}</Text></Space>
                  <Tag color={quality.color}>{quality.label}</Tag>
                </div>
                <Statistic value={metric.value === null ? '-' : metric.value} suffix={metric.value === null ? undefined : '%'} precision={metric.value === null ? undefined : 1} valueStyle={{ color, fontSize: 28 }} />
                <Text type="secondary" className="overview-runtime-time">{metric.value === null ? (deviceRuntime.error || '暂无可用数据') : deviceMetricTime(metric.tsMs)}</Text>
              </Card>
            );
          })}
        </div>
      </section>

      <Card
        size="small"
        bordered
        className="overview-throughput-card"
        title={
          <Space size={8}>
            <span>数据总线转发速率</span>
            <Tag bordered={false}>点/s</Tag>
          </Space>
        }
        extra={<Tag color={throughput?.source === 'backend' ? 'success' : 'default'}>{throughputSourceLabel}</Tag>}
      >
        <div className="overview-throughput-summary">
          <Statistic
            title="当前速率"
            value={!throughput || throughput.source === 'unavailable' ? '-' : throughput?.current_points_per_second ?? 0}
            suffix={throughput?.source === 'unavailable' ? undefined : '点/s'}
            valueStyle={{ fontSize: 26, color: throughput?.source === 'backend' ? '#52c41a' : undefined }}
          />
          <Statistic
            title="窗口峰值"
            value={!throughput || throughput.source === 'unavailable' ? '-' : throughput?.peak_points_per_second ?? 0}
            suffix={throughput?.source === 'unavailable' ? undefined : '点/s'}
            valueStyle={{ fontSize: 20 }}
          />
          <Text type="secondary" className="overview-throughput-note">
            {throughput?.source === 'browser-demo'
              ? '仅用于验证界面，数据不代表真实下位机吞吐量。'
              : throughput?.source === 'backend'
                ? '统计口径：按路由生成的目的端点更新数量。'
                : 'DataCenter 吞吐量统计接口尚未接入。'}
          </Text>
        </div>
        <div className="overview-throughput-chart" aria-label="最近转发速率趋势">
          {throughputValues.length > 0 ? (
            <div className="overview-throughput-plot">
              <div className="overview-throughput-y-axis" aria-hidden="true">
                <span className="overview-throughput-axis-unit">点/s</span>
                {throughputChartGeometry.yTicks.map((tick) => (
                  <span
                    className="overview-throughput-y-tick"
                    key={tick.label}
                    style={{ top: `${((tick.y ?? 0) / THROUGHPUT_CHART_HEIGHT) * 100}%` }}
                  >
                    {tick.label}
                  </span>
                ))}
              </div>
              <div className="overview-throughput-plot-main">
                <svg
                  className="overview-throughput-svg"
                  viewBox={`0 0 ${THROUGHPUT_CHART_WIDTH} ${THROUGHPUT_CHART_HEIGHT}`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label="数据总线转发速率平滑折线图"
                >
                  <title>数据总线转发速率平滑折线图</title>
                  {throughputChartGeometry.yTicks.map((tick) => (
                    <g className="overview-throughput-y-tick" key={tick.label}>
                      <line
                        className="overview-throughput-grid-line"
                        x1={THROUGHPUT_CHART_PADDING_LEFT}
                        y1={tick.y}
                        x2={THROUGHPUT_CHART_WIDTH - THROUGHPUT_CHART_PADDING_RIGHT}
                        y2={tick.y}
                      />
                    </g>
                  ))}
                  <line
                    className="overview-throughput-axis overview-throughput-axis-y"
                    x1={THROUGHPUT_CHART_PADDING_LEFT}
                    y1={THROUGHPUT_CHART_PADDING_TOP}
                    x2={THROUGHPUT_CHART_PADDING_LEFT}
                    y2={THROUGHPUT_CHART_HEIGHT - THROUGHPUT_CHART_PADDING_BOTTOM}
                  />
                  <line
                    className="overview-throughput-axis overview-throughput-axis-x"
                    x1={THROUGHPUT_CHART_PADDING_LEFT}
                    y1={THROUGHPUT_CHART_HEIGHT - THROUGHPUT_CHART_PADDING_BOTTOM}
                    x2={THROUGHPUT_CHART_WIDTH - THROUGHPUT_CHART_PADDING_RIGHT}
                    y2={THROUGHPUT_CHART_HEIGHT - THROUGHPUT_CHART_PADDING_BOTTOM}
                  />
                  <path className="overview-throughput-area" d={throughputChartGeometry.areaPath} />
                  <path className="overview-throughput-line" d={throughputChartGeometry.linePath} />
                  {latestThroughputPoint ? (
                    <circle
                      className="overview-throughput-latest-point"
                      cx={latestThroughputPoint.x}
                      cy={latestThroughputPoint.y}
                      r="3.5"
                    />
                  ) : null}
                </svg>
                <div className="overview-throughput-x-axis" aria-hidden="true">
                  {throughputChartGeometry.xTicks.map((tick) => (
                    <span
                      className={`overview-throughput-x-tick overview-throughput-x-tick--${tick.position ?? 'middle'}`}
                      key={`${tick.x}-${tick.label}`}
                      style={{ left: `${((tick.x ?? 0) / THROUGHPUT_CHART_WIDTH) * 100}%` }}
                    >
                      <i />
                      <span>{tick.label}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <Text type="secondary">
              {throughput?.source === 'backend' ? '等待 DataCenter 产生路由数据' : '接口待接入'}
            </Text>
          )}
        </div>
      </Card>
    </div>
  );
};

const Overview: React.FC = () => {
  const { mode } = useAppMode();
  return mode === 'offline' ? <div className="overview-page"><EngineeringStart /></div> : <OnlineOverview />;
};

export default Overview;
