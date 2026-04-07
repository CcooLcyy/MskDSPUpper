import React, { useState } from 'react';
import { Button, Card, Form, Input, InputNumber, Modal, Switch, Typography, message } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { api } from '../../../adapters';
import type { Dlt645MqttConfig } from '../../../adapters';

const { Text } = Typography;

const MqttConfigPanel: React.FC = () => {
  const [mqttConfig, setMqttConfig] = useState<Dlt645MqttConfig | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<Dlt645MqttConfig>();

  const openModal = (): void => {
    if (mqttConfig) {
      form.setFieldsValue(mqttConfig);
    } else {
      form.setFieldsValue({
        host: '',
        port: 1883,
        client_id: '',
        username: '',
        password: '',
        keepalive_sec: 30,
        clean_session: true,
        connect_timeout_ms: 3000,
      });
    }
    setModalOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      const payload: Dlt645MqttConfig = {
        host: values.host,
        port: values.port,
        client_id: values.client_id,
        username: values.username ?? '',
        password: values.password ?? '',
        keepalive_sec: values.keepalive_sec ?? 30,
        clean_session: values.clean_session ?? true,
        connect_timeout_ms: values.connect_timeout_ms ?? 3000,
      };
      const response = await api.dlt645UpdateConfig(payload);
      setMqttConfig(payload);
      messageApi.success(response.message || 'MQTT 配置已保存');
      setModalOpen(false);
    } catch (error) {
      messageApi.error(`保存 MQTT 配置失败: ${error}`);
    }
  };

  return (
    <>
      {contextHolder}
      <Card
        title="MQTT 全局配置"
        size="small"
        bordered
        extra={(
          <Button type="text" size="small" icon={<EditOutlined />} onClick={openModal}>
            编辑
          </Button>
        )}
      >
        <Text type="secondary">
          MQTT 配置用于 DLT645 模块与 LoRa/载波/串口头端的通信通道。点击编辑按钮配置 MQTT 连接参数。
        </Text>
      </Card>

      <Modal
        title="MQTT 连接配置"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSubmit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item label="主机地址" name="host" rules={[{ required: true, message: '请输入主机地址' }]}>
            <Input placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item label="端口" name="port" rules={[{ required: true, message: '请输入端口' }]}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="客户端标识" name="client_id" rules={[{ required: true, message: '请输入客户端标识' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="用户名" name="username">
            <Input />
          </Form.Item>
          <Form.Item label="密码" name="password">
            <Input.Password />
          </Form.Item>
          <Form.Item label="保活时间（秒）" name="keepalive_sec">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="清理会话" name="clean_session" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="连接超时（毫秒）" name="connect_timeout_ms">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};

export default MqttConfigPanel;
