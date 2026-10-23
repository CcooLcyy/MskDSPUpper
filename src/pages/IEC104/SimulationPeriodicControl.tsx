import { useEffect, useRef, useState } from 'react';
import { Alert, Button, InputNumber, Space, Switch, Tag, Typography } from 'antd';
import { api, type Iec104SimulationPeriodicStatus } from '../../adapters';
import { formatErrorText } from '../../utils/runtime-restart';
import { DEFAULT_SIMULATION_INTERVAL, getSimulationPeriodicInterval } from './simulation-periodic';

type Props = {
  connName: string;
  visible: boolean;
  supported: boolean;
  pointCount: number;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
};

export default function SimulationPeriodicControl({ connName, visible, supported, pointCount, disabled, onBusyChange }: Props) {
  const [status, setStatus] = useState<Iec104SimulationPeriodicStatus | null>(null);
  const [interval, setInterval] = useState<number | null>(DEFAULT_SIMULATION_INTERVAL);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const operationRef = useRef(false);
  const revisionRef = useRef(0);
  const draftInitializedRef = useRef(false);

  useEffect(() => {
    if (!visible || !supported) return;
    let disposed = false;
    let timer: ReturnType<typeof window.setTimeout> | undefined;
    const poll = async () => {
      const revision = revisionRef.current;
      let retryAllowed = true;
      try {
        if (operationRef.current) return;
        const next = await api.iec104GetSimulationPeriodicStatus(connName);
        if (disposed || revision !== revisionRef.current) return;
        if (next.conn_name !== connName) throw new Error('下位机返回的周期上报连接不匹配');
        setStatus(next);
        setError('');
        if (!draftInitializedRef.current) {
          setInterval(next.interval_seconds);
          draftInitializedRef.current = true;
        }
      } catch (cause) {
        if (disposed || revision !== revisionRef.current) return;
        const detail = formatErrorText(cause);
        setError(`读取周期上报状态失败：${detail}`);
        retryAllowed = !/不支持|未实现|unimplemented/i.test(detail);
      } finally {
        if (!disposed && retryAllowed) timer = window.setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [connName, visible, supported, pointCount, retry]);

  const apply = async (enabled: boolean, changingInterval = false) => {
    if (operationRef.current || disabled) return;
    try {
      const seconds = getSimulationPeriodicInterval(enabled, interval, status?.interval_seconds ?? DEFAULT_SIMULATION_INTERVAL, changingInterval);
      operationRef.current = true;
      revisionRef.current += 1;
      setBusy(true);
      onBusyChange(true);
      const next = await api.iec104SetSimulationPeriodicReport(connName, enabled, seconds);
      if (next.conn_name !== connName) throw new Error('下位机返回的周期上报连接不匹配');
      setStatus(next);
      setInterval(next.interval_seconds);
      draftInitializedRef.current = true;
      setError('');
      console.info('IEC104 模拟值周期上报设置完成', next);
    } catch (cause) {
      setError(`设置周期上报失败：${formatErrorText(cause)}`);
    } finally {
      operationRef.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };

  const controlsDisabled = disabled || busy || !supported || status === null;
  return (
    <div style={{ marginBottom: 12 }}>
      <Space wrap>
        <Typography.Text>周期上报</Typography.Text>
        <Switch aria-label="模拟值周期上报" checked={status?.enabled ?? false} loading={busy}
          disabled={controlsDisabled || (!status?.enabled && pointCount === 0)} onChange={(enabled) => void apply(enabled)} />
        <Typography.Text>间隔</Typography.Text>
        <InputNumber aria-label="周期上报间隔（秒）" min={1} max={3600} precision={0} value={interval}
          onChange={setInterval} disabled={controlsDisabled} suffix="秒" style={{ width: 140 }} />
        <Button disabled={controlsDisabled || interval === status?.interval_seconds || interval === null}
          onClick={() => void apply(status?.enabled ?? false, true)}>应用间隔</Button>
        <Tag color={status?.running ? 'success' : status?.enabled ? 'warning' : 'default'}>
          {status === null ? '状态未知' : status.running ? '周期上报中' : status.enabled ? '等待链路激活' : '已关闭'}
        </Tag>
        <Typography.Text type="secondary">
          最近周期发送：{status?.last_sent_ms ? new Date(status.last_sent_ms).toLocaleString() : '尚未发送'}
        </Typography.Text>
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
        每周期发送当前模拟值，数值保持不变；关闭此窗口仍继续上报。断线暂停，恢复后继续；清除模拟值时关闭。
      </Typography.Paragraph>
      {error && <Alert type="warning" showIcon title={error} style={{ marginTop: 8 }}
        action={<Button size="small" disabled={busy || disabled} onClick={() => setRetry((value) => value + 1)}>重试查询</Button>} />}
    </div>
  );
}
