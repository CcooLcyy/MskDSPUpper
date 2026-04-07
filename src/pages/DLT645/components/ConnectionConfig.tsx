import React from 'react';
import { Card, Descriptions, Button, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
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

interface Props {
  link: Dlt645LinkInfo | null;
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
          <Descriptions.Item label="连接标识">{link?.conn_id ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="协议变体">
            {PROTOCOL_VARIANT_LABELS[config.protocol_variant] ?? '未指定'}
          </Descriptions.Item>
          <Descriptions.Item label="表计地址">{config.meter_addr || '-'}</Descriptions.Item>
          {config.protocol_variant === 2 ? (
            <Descriptions.Item label="设备序号">{config.device_no || '-'}</Descriptions.Item>
          ) : null}
          <Descriptions.Item label="通信方式">
            {COMM_MODE_LABELS[config.comm_mode] ?? '未指定'}
          </Descriptions.Item>
          <Descriptions.Item label="轮询间隔">{config.poll_interval_ms} ms</Descriptions.Item>
          <Descriptions.Item label="点抄间隔">{config.poll_item_interval_ms} ms</Descriptions.Item>
          <Descriptions.Item label="请求超时">{config.request_timeout_ms} ms</Descriptions.Item>

          {config.comm_mode === 2 ? (
            <>
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
