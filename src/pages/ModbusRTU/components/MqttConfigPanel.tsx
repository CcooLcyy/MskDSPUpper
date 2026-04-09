import React, { useEffect, useState } from 'react';
import { Button, Form, Input, InputNumber, Modal, Switch, message } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { api } from '../../../adapters';
import type { ModbusMqttConfig } from '../../../adapters';
import { createDefaultMqttConfig, loadStoredMqttConfig, saveStoredMqttConfig } from '../../../utils/mqtt';

interface Props {
  block?: boolean;
}

const STORAGE_KEY = 'protocol.modbus_rtu.mqtt';
const DEFAULT_MQTT_CONFIG: ModbusMqttConfig = createDefaultMqttConfig({
  port: 1883,
  keepalive_sec: 60,
  connect_timeout_ms: 5000,
  client_id: 'mskdsp-modbus-rtu',
});

const MqttConfigPanel: React.FC<Props> = ({ block = false }) => {
  const [initialMqttConfig] = useState<ModbusMqttConfig>(() =>
    loadStoredMqttConfig<ModbusMqttConfig>(STORAGE_KEY) ?? DEFAULT_MQTT_CONFIG,
  );
  const [mqttConfig, setMqttConfig] = useState<ModbusMqttConfig>(() => initialMqttConfig);
  const [modalOpen, setModalOpen] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<ModbusMqttConfig>();

  useEffect(() => {
    const syncDefaultConfig = async (): Promise<void> => {
      try {
        await api.modbusRtuUpdateConfig(initialMqttConfig);
        saveStoredMqttConfig(STORAGE_KEY, initialMqttConfig);
      } catch (error) {
        console.warn('Failed to apply default Modbus MQTT config automatically:', error);
      }
    };

    void syncDefaultConfig();
  }, [initialMqttConfig]);

  const openModal = (): void => {
    form.setFieldsValue(mqttConfig);
    setModalOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      const payload: ModbusMqttConfig = {
        host: values.host,
        port: values.port,
        client_id: values.client_id,
        username: values.username ?? '',
        password: values.password ?? '',
        keepalive_sec: values.keepalive_sec ?? 60,
        clean_session: values.clean_session ?? true,
        connect_timeout_ms: values.connect_timeout_ms ?? 5000,
      };
      const response = await api.modbusRtuUpdateConfig(payload);
      setMqttConfig(payload);
      saveStoredMqttConfig(STORAGE_KEY, payload);
      messageApi.success(response.message || 'MQTT 配置已保存');
      setModalOpen(false);
    } catch (error) {
      messageApi.error(`保存 MQTT 配置失败: ${error}`);
    }
  };

  return (
    <>
      {contextHolder}
      <Button block={block} icon={<EditOutlined />} onClick={openModal} style={{ whiteSpace: 'nowrap' }}>
        编辑 MQTT 全局配置
      </Button>

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
