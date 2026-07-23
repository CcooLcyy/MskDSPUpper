import React from 'react';
import { Alert, Button, Card, Descriptions, Popconfirm, Space, Tag, Typography } from 'antd';
import { DisconnectOutlined, EditOutlined, LinkOutlined } from '@ant-design/icons';
import type { ModbusLinkInfo } from '../../../adapters';

const { Text } = Typography;

const TRANSPORT_TYPE_LABELS: Record<number, string> = {
  1: '本地串口',
  2: 'MQTT 透传',
};

const ADDRESS_BASE_LABELS: Record<number, string> = {
  1: '0 基（协议偏移）',
  2: '1 基（设备编号）',
};

const READ_PLAN_MODE_LABELS: Record<number, string> = {
  1: '逐点读取',
  2: '区间读取',
};

const PARITY_LABELS: Record<number, string> = {
  1: '无校验',
  2: '奇校验',
  3: '偶校验',
};

const STOP_BITS_LABELS: Record<number, string> = {
  1: '1',
  2: '2',
};

const STATE_MAP: Record<number, { label: string; color: string }> = {
  0: { label: '状态未知', color: 'default' },
  1: { label: '已停止', color: 'default' },
  2: { label: '运行中', color: 'success' },
  3: { label: '待删除', color: 'warning' },
};

interface Props {
  link: ModbusLinkInfo | null;
  pointCount: number;
  busy: boolean;
  runtimeAction: 'start' | 'stop' | null;
  globalAction: React.ReactNode;
  onEdit: () => void;
  onStart: () => void;
  onStop: () => void;
}

const ConnectionConfig: React.FC<Props> = ({
  link,
  pointCount,
  busy,
  runtimeAction,
  globalAction,
  onEdit,
  onStart,
  onStop,
}) => {
  const config = link?.config;
  const state = STATE_MAP[link?.state ?? 0] ?? STATE_MAP[0];
  const isStopped = link?.state === 1;
  const isRunning = link?.state === 2;
  const isPendingDelete = link?.state === 3;
  const readBlockCount = config?.read_plan?.blocks.length ?? 0;
  const pointTableReady = pointCount > 0;

  return (
    <Card
      title={(
        <Space size={8} wrap>
          <span>{config?.conn_name || '连接详情'}</span>
          {config ? <Tag color={state.color}>{state.label}</Tag> : null}
          {config ? <Text type="secondary">从站 {config.device_id}</Text> : null}
        </Space>
      )}
      size="small"
      bordered
      className="modbus-connection-card"
      extra={(
        <Space size={8} wrap className="modbus-connection-actions">
          {globalAction}
          {config ? (
            <>
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
                description="停止后将不再采集或处理该连接的写点。"
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
            </>
          ) : null}
        </Space>
      )}
    >
      {config ? (
        <>
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} colon={false}>
            <Descriptions.Item label="传输方式">
              {TRANSPORT_TYPE_LABELS[config.transport_type] ?? '未指定'}
            </Descriptions.Item>
            <Descriptions.Item label="连接编号">{link?.conn_id || '-'}</Descriptions.Item>
            <Descriptions.Item label="轮询周期">{config.poll_interval_ms} ms</Descriptions.Item>
            <Descriptions.Item label="地址基准">
              {ADDRESS_BASE_LABELS[config.address_base] ?? '未指定'}
            </Descriptions.Item>
            <Descriptions.Item label="读取策略">
              {READ_PLAN_MODE_LABELS[config.read_plan?.mode ?? 0] ?? '未指定'}
              {config.read_plan?.mode === 2 ? `（${readBlockCount} 个区间）` : ''}
            </Descriptions.Item>
            <Descriptions.Item label="点表状态">
              {pointTableReady ? <Tag color="success">已配置 {pointCount} 个点位</Tag> : <Tag color="warning">未配置</Tag>}
            </Descriptions.Item>

            {config.transport_type === 1 && config.serial ? (
              <>
                <Descriptions.Item label="串口设备">{config.serial.device || '-'}</Descriptions.Item>
                <Descriptions.Item label="波特率">{config.serial.baud_rate}</Descriptions.Item>
                <Descriptions.Item label="数据位">{config.serial.data_bits}</Descriptions.Item>
                <Descriptions.Item label="校验位">
                  {PARITY_LABELS[config.serial.parity] ?? '未指定'}
                </Descriptions.Item>
                <Descriptions.Item label="停止位">
                  {STOP_BITS_LABELS[config.serial.stop_bits] ?? '未指定'}
                </Descriptions.Item>
                <Descriptions.Item label="读取超时">{config.serial.read_timeout_ms} ms</Descriptions.Item>
              </>
            ) : null}

            {config.transport_type === 2 ? (
              <>
                <Descriptions.Item label="远端串口">{config.serial_port || '-'}</Descriptions.Item>
                <Descriptions.Item label="波特率">{config.serial?.baud_rate ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="串口格式">
                  {config.serial
                    ? `${config.serial.data_bits}-${PARITY_LABELS[config.serial.parity] ?? '?'}-${STOP_BITS_LABELS[config.serial.stop_bits] ?? '?'}`
                    : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="请求超时">{config.request_timeout_ms} ms</Descriptions.Item>
                <Descriptions.Item label="字节 / 帧超时">
                  {config.serial_byte_timeout_ms} / {config.serial_frame_timeout_ms} ms
                </Descriptions.Item>
                <Descriptions.Item label="最大响应">{config.serial_est_size} 字节</Descriptions.Item>
              </>
            ) : null}
          </Descriptions>
          {!pointTableReady && isStopped ? (
            <Alert
              className="modbus-last-error"
              type="warning"
              showIcon
              message="点表未就绪"
              description="请先在下方点表配置中添加至少一个点位，再启动轮询。"
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
              message="最近错误"
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
