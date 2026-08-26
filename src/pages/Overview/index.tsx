import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  NodeIndexOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../../adapters';
import type { ModuleInfo, ModuleRunningInfo } from '../../adapters';
import type { DataBusThroughputSample, DataBusThroughputSnapshot } from '../../adapters';
import { loadDashboardAfterRunningModules } from '../../utils/dashboard-loading';
import { getStoredManagerAddress } from '../../utils/app-settings';
import './index.css';

const { Text, Title } = Typography;

const DEFAULT_MANAGER_ADDR = '127.0.0.1:17000';

type SyncState = 'idle' | 'loading' | 'success' | 'partial' | 'error';

type SummaryCard = {
  title: string;
  value: number;
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

const Overview: React.FC = () => {
  const navigate = useNavigate();
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
  const [messageApi, contextHolder] = message.useMessage();

  const refresh = useCallback(async () => {
    setLoading(true);
    setSyncState('loading');

    try {
      const managerAddr = getStoredManagerAddress(DEFAULT_MANAGER_ADDR);
      await api.setManagerAddr(managerAddr);

      const {
        modules: modulesResult,
        runningModules: runningModulesResult,
        iec104Links: iec104LinksResult,
        modbusLinks: modbusLinksResult,
        dlt645Links: dlt645LinksResult,
        agcGroups: agcGroupsResult,
        routes: routesResult,
      } = await loadDashboardAfterRunningModules({
        getModuleInfo: api.getModuleInfo,
        getRunningModuleInfo: api.getRunningModuleInfo,
        listIec104Links: api.iec104ListLinks,
        listModbusLinks: api.modbusRtuListLinks,
        listDlt645Links: api.dlt645ListLinks,
        listAgcGroups: api.agcListGroups,
        listRoutes: () => api.dcListRoutes(0, '', 0, ''),
      });

      const modules = modulesResult.status === 'fulfilled' ? modulesResult.value : [];
      const runningModules = runningModulesResult.status === 'fulfilled' ? runningModulesResult.value : [];
      const protocolLinkCount =
        (iec104LinksResult.status === 'fulfilled' ? iec104LinksResult.value.length : 0) +
        (modbusLinksResult.status === 'fulfilled' ? modbusLinksResult.value.length : 0) +
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
      setFailedSections(['ModuleManager 连接']);
      setSyncState('error');
      messageApi.error(`首页数据加载失败: ${error}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;

    const loadThroughput = async (): Promise<DataBusThroughputSnapshot | null> => {
      try {
        const snapshot = await api.getDataBusThroughputSnapshot();
        if (!cancelled) {
          setThroughput(snapshot);
        }
        return snapshot;
      } catch (error) {
        if (!cancelled) {
          setThroughput({
            source: 'unavailable',
            process_start_time_ms: null,
            samples: [],
            current_points_per_second: 0,
            peak_points_per_second: 0,
            updated_at_ms: null,
          });
          messageApi.warning(`吞吐量数据暂不可用: ${error}`);
        }
        return null;
      }
    };

    let timer: number | undefined;

    const startDemoPolling = async () => {
      const initialSnapshot = await loadThroughput();
      if (cancelled) {
        return;
      }

      if (initialSnapshot && initialSnapshot.source !== 'unavailable') {
        timer = window.setInterval(() => {
          void loadThroughput();
        }, 1000);
      }
    };

    void startDemoPolling();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
    };
  }, [messageApi]);

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      {
        title: '发现模块',
        value: dashboardData.modules.length,
        icon: <AppstoreOutlined />,
        path: '/module-ops',
        hint: '进入模块运维',
        iconColor: '#8b9aaa',
      },
      {
        title: '运行模块',
        value: dashboardData.runningModules.length,
        icon: <PlayCircleOutlined />,
        path: '/module-ops',
        hint: '查看运行状态',
        color: '#52c41a',
        iconColor: '#52c41a',
      },
      {
        title: '协议连接',
        value: dashboardData.protocolLinkCount,
        icon: <ApiOutlined />,
        path: '/protocol/iec104',
        hint: '进入协议接入',
        iconColor: '#36cfc9',
      },
      {
        title: 'AGC 控制组',
        value: dashboardData.agcGroupCount,
        icon: <ControlOutlined />,
        path: '/control?module=agc',
        hint: '查看控制策略',
        iconColor: '#faad14',
      },
      {
        title: '数据路由',
        value: dashboardData.routeCount,
        icon: <NodeIndexOutlined />,
        path: '/data-bus',
        hint: '进入数据总线',
        iconColor: '#69b1ff',
      },
    ],
    [dashboardData],
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
            系统总览
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
            value={throughput?.source === 'unavailable' ? '-' : throughput?.current_points_per_second ?? 0}
            suffix={throughput?.source === 'unavailable' ? undefined : '点/s'}
            valueStyle={{ fontSize: 26, color: throughput?.source === 'backend' ? '#52c41a' : undefined }}
          />
          <Statistic
            title="窗口峰值"
            value={throughput?.source === 'unavailable' ? '-' : throughput?.peak_points_per_second ?? 0}
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

export default Overview;
