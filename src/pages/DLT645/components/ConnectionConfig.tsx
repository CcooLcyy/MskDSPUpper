import React from 'react';
import { Alert, Button, Card, Descriptions, Popconfirm, Space, Tag, Typography } from 'antd';
import { DisconnectOutlined, EditOutlined, LinkOutlined } from '@ant-design/icons';
import type { Dlt645LinkInfo } from '../../../adapters';

const { Text } = Typography;

const PROTOCOL_VARIANT_LABELS: Record<number, string> = {
  0: '未指定',
  1: 'DLT645 标准版',
  2: 'DLT645 PCD 版',
};

const COMM_MODE_LABELS: Record<number, string> = {
  0: '未指定',
  1: '载波',
  2: '串口',
  3: 'LoRa',
};

const PARITY_LABELS: Record<number, string> = {
  0: '未指定',
  1: '无校验',
  2: '奇校验',
  3: '偶校验',
};

const STOP_BITS_LABELS: Record<number, string> = {
  0: '未指定',
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
  link: Dlt645LinkInfo | null;
  selectedConn: string | null;
  pointCount: number;
  blockCount: number;
  busy: boolean;
  runtimeAction: 'start' | 'stop' | null;
  globalAction?: React.ReactNode;
  onEdit: () => void;
  onStart: () => void;
  onStop: () => void;
}

const ConnectionConfig: React.FC<Props> = ({
  link,
  selectedConn,
  pointCount,
  blockCount,
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
  const hasSelection = Boolean(selectedConn && config);

  return (
    <Card
      title={(
        <Space size={8} wrap className="dlt645-connection-title">
          <span className="dlt645-connection-name">{config?.conn_name || '连接详情'}</span>
          {config ? <Tag color={state.color}>{state.label}</Tag> : null}
          {config ? (
            <Text type="secondary" className="dlt645-connection-meter">
              表计 {config.meter_addr || '-'}
            </Text>
          ) : null}
        </Space>
      )}
      size="small"
      bordered
      className="dlt645-connection-card"
      extra={(
        <Space size={8} wrap className="dlt645-connection-actions">
          {globalAction}
          {config ? (
            <>
              <Button icon={<EditOutlined />} disabled={!hasSelection || isPendingDelete || busy} onClick={onEdit}>
                编辑配置
              </Button>
              <Button
                type="primary"
                icon={<LinkOutlined />}
                disabled={!isStopped || !hasSelection || busy}
                loading={runtimeAction === 'start'}
                onClick={onStart}
              >
                {runtimeAction === 'start' ? '启动中…' : '启动轮询'}
              </Button>
              <Popconfirm
                title="确认停止轮询？"
                description="停止后将不再轮询和处理该连接的数据。"
                disabled={!isRunning || !hasSelection || busy}
                onConfirm={onStop}
              >
                <Button
                  danger
                  icon={<DisconnectOutlined />}
                  disabled={!isRunning || !hasSelection || busy}
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
          <div className="dlt645-connection-section">
            <div className="dlt645-connection-section-title">基础信息</div>
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 2, lg: 3 }}
              colon={false}
              className="dlt645-connection-descriptions"
            >
              <Descriptions.Item label="传输方式">MQTT 透传</Descriptions.Item>
              <Descriptions.Item label="协议变体">
                {PROTOCOL_VARIANT_LABELS[config.protocol_variant] ?? '未指定'}
              </Descriptions.Item>
              <Descriptions.Item label="通信方式">
                {COMM_MODE_LABELS[config.comm_mode] ?? '未指定'}
              </Descriptions.Item>
              <Descriptions.Item label="连接编号">{link?.conn_id || '-'}</Descriptions.Item>
              {config.protocol_variant === 2 ? (
                <Descriptions.Item label="设备序号">{config.device_no || '-'}</Descriptions.Item>
              ) : null}
              <Descriptions.Item label="点表状态">
                <Space size={4} wrap>
                  <Tag color={pointCount > 0 ? 'success' : 'warning'}>单点 {pointCount}</Tag>
                  <Tag color={blockCount > 0 ? 'success' : 'default'}>数据块 {blockCount}</Tag>
                </Space>
              </Descriptions.Item>
            </Descriptions>
          </div>

          <div className="dlt645-connection-section">
            <div className="dlt645-connection-section-title">轮询参数</div>
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 2, lg: 3 }}
              colon={false}
              className="dlt645-connection-descriptions"
            >
              <Descriptions.Item label="轮询间隔">{config.poll_interval_ms} ms</Descriptions.Item>
              <Descriptions.Item label="点抄间隔">{config.poll_item_interval_ms} ms</Descriptions.Item>
              <Descriptions.Item label="请求超时">{config.request_timeout_ms} ms</Descriptions.Item>
            </Descriptions>
          </div>

          {config.comm_mode === 2 ? (
            <div className="dlt645-connection-section dlt645-connection-section--serial">
              <div className="dlt645-connection-section-title">串口参数</div>
              <Descriptions
                size="small"
                column={{ xs: 1, sm: 2, lg: 3 }}
                colon={false}
                className="dlt645-connection-descriptions"
              >
                <Descriptions.Item label="串口标识">{config.serial_port || '-'}</Descriptions.Item>
                <Descriptions.Item label="波特率">{config.serial_baud_rate || '默认'}</Descriptions.Item>
                <Descriptions.Item label="数据位">{config.serial_data_bits || '默认'}</Descriptions.Item>
                <Descriptions.Item label="校验位">
                  {PARITY_LABELS[config.serial_parity] ?? '未指定'}
                </Descriptions.Item>
                <Descriptions.Item label="停止位">
                  {STOP_BITS_LABELS[config.serial_stop_bits] ?? '未指定'}
                </Descriptions.Item>
                <Descriptions.Item label="字节超时">{config.serial_byte_timeout_ms} ms</Descriptions.Item>
                <Descriptions.Item label="帧超时">{config.serial_frame_timeout_ms} ms</Descriptions.Item>
                <Descriptions.Item label="估算帧长度">{config.serial_est_size || '默认'}</Descriptions.Item>
              </Descriptions>
            </div>
          ) : null}
          {isPendingDelete ? (
            <Alert
              className="dlt645-last-error"
              type="warning"
              showIcon
              message="连接待删除"
              description="当前连接不可编辑或启动，请处理删除失败原因后重试删除。"
            />
          ) : null}
          {link?.last_error ? (
            <Alert
              className="dlt645-last-error"
              type="error"
              showIcon
              message="最近错误"
              description={link.last_error}
            />
          ) : null}
        </>
      ) : (
        <div className="dlt645-connection-empty">
          <Text type="secondary">请从左侧选择连接，或新建一条连接。</Text>
        </div>
      )}
    </Card>
  );
};

export default ConnectionConfig;
