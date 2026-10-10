import { useEffect, useRef, useState } from 'react';
import { Space, Tag, Tooltip, Typography } from 'antd';
import type { DcPointUpdate } from '../../adapters';
import { CONTROL_RUNTIME_FUTURE_TOLERANCE_MS, summarizeControlRuntime } from '../../utils/control-runtime-values';

interface ControlRuntimeStatusProps {
  updates: Record<string, DcPointUpdate>;
  tags: string[];
  maxAgeMs?: number;
  offline?: boolean;
}

const statusLabels = {
  waiting: '等待数据',
  ok: '数据正常',
  stale: '数据陈旧',
  quality: '质量异常',
  missing: '点值缺失',
};

const ControlRuntimeStatus = ({
  updates,
  tags,
  maxAgeMs = 5000,
  offline = false,
}: ControlRuntimeStatusProps) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const previousStatus = useRef<string | null>(null);
  const ageLimit = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 5000;
  const summary = summarizeControlRuntime(updates, tags, nowMs, ageLimit);
  const status = offline ? 'offline' : summary.state;

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (previousStatus.current !== status) {
      console.info('控制运行数据状态变化', {
        状态: offline ? '连接异常' : statusLabels[summary.state],
        数据时间: summary.latestTimestamp,
        陈旧点数: summary.staleCount,
        缺失点数: summary.missingCount,
        质量异常点数: summary.uncertainCount,
      });
      previousStatus.current = status;
    }
  }, [status, offline, summary.state, summary.latestTimestamp, summary.staleCount, summary.missingCount, summary.uncertainCount]);

  const timestamp = summary.latestTimestamp;
  const invalidTimestamp = timestamp !== null && (timestamp - nowMs > CONTROL_RUNTIME_FUTURE_TOLERANCE_MS || !Number.isFinite(new Date(timestamp).getTime()));
  const timestampText = timestamp === null ? '未知'
    : Number.isFinite(new Date(timestamp).getTime()) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '异常';
  const issues = [
    offline ? '连接异常，保留最后收到的点值' : '',
    summary.missingCount > 0 ? `缺少 ${summary.missingCount} 个点值` : '',
    summary.staleCount > 0 ? `${summary.staleCount} 个点值超时或时间异常` : '',
    summary.uncertainCount > 0 ? `${summary.uncertainCount} 个点值质量未指定、无效或不确定` : '',
  ].filter(Boolean);

  return (
    <Space size={[8, 4]} wrap>
      <Tag color={offline ? 'error' : summary.state === 'ok' ? 'success' : summary.state === 'waiting' ? 'default' : 'warning'}>
        <span role="status" aria-live="polite">{offline ? '连接异常' : statusLabels[summary.state]}</span>
      </Tag>
      <Typography.Text type="secondary">
        数据更新时间：{timestampText}{invalidTimestamp ? '（时间异常）' : ''}
      </Typography.Text>
      {issues.length > 0 && <Typography.Text type="warning">{issues.join('；')}</Typography.Text>}
      <Tooltip title="依据点值时间与质量判断，质量仅为有效且所有点值新鲜时显示正常；时间未知或领先展示时钟超过一秒均视为陈旧，一秒以内的容差用于避免计时刷新误报。此阈值仅用于运行监视展示，不改变控制逻辑。">
        <Typography.Text type="secondary">新鲜度阈值：{ageLimit / 1000} 秒</Typography.Text>
      </Tooltip>
    </Space>
  );
};

export default ControlRuntimeStatus;
