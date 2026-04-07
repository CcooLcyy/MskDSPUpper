import React from 'react';
import { Button, Card, Descriptions, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import type { ModbusLinkInfo } from '../../../adapters';

const { Text } = Typography;

const TRANSPORT_TYPE_LABELS: Record<number, string> = {
  1: 'SERIAL',
  2: 'MQTT_UART',
};

const ADDRESS_BASE_LABELS: Record<number, string> = {
  1: '0基',
  2: '1基',
};

const READ_PLAN_MODE_LABELS: Record<number, string> = {
  1: '逐点',
  2: '区间',
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

interface Props {
  link: ModbusLinkInfo | null;
  onEdit: () => void;
}

const ConnectionConfig: React.FC<Props> = ({ link, onEdit }) => {
  const config = link?.config;

  return (
    <Card
      title="连接配置"
      size="small"
      bordered
      style={{ flex: 1 }}
      extra={config ? <Button type="text" size="small" icon={<EditOutlined />} onClick={onEdit}>编辑</Button> : null}
    >
      {config ? (
        <Descriptions size="small" column={2} colon={false}>
          <Descriptions.Item label="传输类型">
            {TRANSPORT_TYPE_LABELS[config.transport_type] ?? '未指定'}
          </Descriptions.Item>
          <Descriptions.Item label="设备地址">{config.device_id}</Descriptions.Item>
          <Descriptions.Item label="轮询间隔">{config.poll_interval_ms} ms</Descriptions.Item>
          <Descriptions.Item label="地址基准">
            {ADDRESS_BASE_LABELS[config.address_base] ?? '未指定'}
          </Descriptions.Item>
          <Descriptions.Item label="抄读模式">
            {READ_PLAN_MODE_LABELS[config.read_plan?.mode ?? 0] ?? '未指定'}
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
            </>
          ) : null}

          {config.transport_type === 2 ? (
            <>
              <Descriptions.Item label="远端串口标识">{config.serial_port || '-'}</Descriptions.Item>
              <Descriptions.Item label="请求超时">{config.request_timeout_ms} ms</Descriptions.Item>
              <Descriptions.Item label="字节超时">{config.serial_byte_timeout_ms} ms</Descriptions.Item>
              <Descriptions.Item label="帧超时">{config.serial_frame_timeout_ms} ms</Descriptions.Item>
            </>
          ) : null}
        </Descriptions>
      ) : (
        <Text type="secondary">请选择连接</Text>
      )}
    </Card>
  );
};

export default ConnectionConfig;
