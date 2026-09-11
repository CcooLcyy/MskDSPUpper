import React from 'react';
import { Alert, Button, Card, Descriptions, Popconfirm, Space, Tag, Typography } from 'antd';
import { DisconnectOutlined, EditOutlined, LinkOutlined } from '@ant-design/icons';
import type { ModbusTcpLinkInfo } from '../../../adapters';

const { Text } = Typography;

const STATE_MAP: Record<number, { label: string; color: string }> = {
  0: { label: '状态未知', color: 'default' },
  1: { label: '已停止', color: 'default' },
  2: { label: '运行中', color: 'success' },
  3: { label: '待删除', color: 'warning' },
};

const ADDRESS_BASE_LABELS: Record<number, string> = {
  1: '0 基（协议偏移）',
  2: '1 基（设备编号）',
};

interface Props {
  link: ModbusTcpLinkInfo | null;
  pointCount: number;
  busy: boolean;
  runtimeAction: 'start' | 'stop' | null;
  onEdit: () => void;
  onStart: () => void;
  onStop: () => void;
}

const ConnectionConfig: React.FC<Props> = ({
  link,
  pointCount,
  busy,
  runtimeAction,
  onEdit,
  onStart,
  onStop,
}) => {
  const config = link?.config;
  const tcp = config?.tcp;
  const state = STATE_MAP[link?.state ?? 0] ?? STATE_MAP[0];
  const isStopped = link?.state === 1;
  const isRunning = link?.state === 2;
  const isPendingDelete = link?.state === 3;
  const pointTableReady = pointCount > 0;

  return (
    <Card
      title={(
        <Space size={8} wrap>
          <span>{config?.conn_name || '连接详情'}</span>
          {config ? <Tag color={state.color}>{state.label}</Tag> : null}
          {tcp ? <Text type="secondary">Unit ID {tcp.unit_id}</Text> : null}
        </Space>
      )}
      size="small"
      bordered
      className="modbus-connection-card"
      extra={config ? (
        <Space size={8} wrap className="modbus-connection-actions">
          <Button icon={<EditOutlined />} disabled={busy || isPendingDelete} onClick={onEdit}>
            编辑配置
          </Button>
          <Button
            type="primary"
            icon={<LinkOutlined />}
            disabled={!isStopped || busy || !pointTableReady}
            loading={runtimeAction === 'start'}
            onClick={onStart}
          >
            {runtimeAction === 'start' ? '启动中…' : '启动轮询'}
          </Button>
          <Popconfirm
            title="确认停止轮询？"
            description="停止后将断开 TCP 连接，并停止采集和写点。"
            disabled={!isRunning || busy}
            onConfirm={onStop}
          >
            <Button
              danger
              icon={<DisconnectOutlined />}
              disabled={!isRunning || busy}
              loading={runtimeAction === 'stop'}
            >
              {runtimeAction === 'stop' ? '停止中…' : '停止轮询'}
            </Button>
          </Popconfirm>
        </Space>
      ) : null}
    >
      {config ? (
        <>
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} colon={false}>
            <Descriptions.Item label="目标地址">{tcp ? `${tcp.host}:${tcp.port}` : '-'}</Descriptions.Item>
            <Descriptions.Item label="Unit ID">{tcp?.unit_id ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="连接编号">{link?.conn_id || '-'}</Descriptions.Item>
            <Descriptions.Item label="轮询周期">{config.poll_interval_ms} ms</Descriptions.Item>
            <Descriptions.Item label="连接超时">{tcp?.connect_timeout_ms ?? '-'} ms</Descriptions.Item>
            <Descriptions.Item label="请求超时">{tcp?.request_timeout_ms ?? '-'} ms</Descriptions.Item>
            <Descriptions.Item label="地址基准">
              {ADDRESS_BASE_LABELS[config.address_base] ?? '未指定'}
            </Descriptions.Item>
            <Descriptions.Item label="读取策略">逐点读取</Descriptions.Item>
            <Descriptions.Item label="点表状态">
              {pointTableReady
                ? <Tag color="success">已配置 {pointCount} 个点位</Tag>
                : <Tag color="warning">未配置</Tag>}
            </Descriptions.Item>
          </Descriptions>
          {!pointTableReady && isStopped ? (
            <Alert
              className="modbus-last-error"
              type="warning"
              showIcon
              message="点表未就绪"
              description="请先添加至少一个点位，再启动轮询。"
            />
          ) : null}
          {isPendingDelete ? (
            <Alert
              className="modbus-last-error"
              type="warning"
              showIcon
              message="连接待删除"
              description="当前连接不可编辑或启动，请处理删除失败原因后重试删除。"
            />
          ) : null}
          {link?.last_error ? (
            <Alert
              className="modbus-last-error"
              type="error"
              showIcon
              message="当前错误"
              description={link.last_error}
            />
          ) : null}
        </>
      ) : (
        <div className="modbus-connection-empty">
          <Text type="secondary">请从左侧选择连接，或新建一条连接。</Text>
        </div>
      )}
    </Card>
  );
};

export default ConnectionConfig;
