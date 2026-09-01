import React, { useEffect, useRef, useState } from 'react';
import { Button, Form, Input, InputNumber, Modal, Switch, message } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { api } from '../../../adapters';
import type { Dlt645MqttConfig } from '../../../adapters';
import { createDefaultMqttConfig, loadStoredMqttConfig, saveStoredMqttConfig } from '../../../utils/mqtt';
import { initializeMqttConfig } from '../../../utils/mqtt-initialization';

interface Props {
  block?: boolean;
}

const STORAGE_KEY = 'protocol.dlt645.mqtt';
const DEFAULT_MQTT_CONFIG: Dlt645MqttConfig = createDefaultMqttConfig({
  port: 1883,
  keepalive_sec: 30,
  connect_timeout_ms: 3000,
  client_id: 'mskdsp-dlt645',
});

const MqttConfigPanel: React.FC<Props> = ({ block = false }) => {
  const [storedMqttConfig] = useState<Dlt645MqttConfig | null>(() =>
    loadStoredMqttConfig<Dlt645MqttConfig>(STORAGE_KEY),
  );
  const [initialMqttConfig] = useState<Dlt645MqttConfig>(() => storedMqttConfig ?? DEFAULT_MQTT_CONFIG);
  const [mqttConfig, setMqttConfig] = useState<Dlt645MqttConfig>(() => initialMqttConfig);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<Dlt645MqttConfig>();
  const initializationVersionRef = useRef(0);

  useEffect(() => {
    const initializationVersion = ++initializationVersionRef.current;
    const initialize = async (): Promise<void> => {
      try {
        const result = await initializeMqttConfig({
          getConfig: api.dlt645GetConfig,
          updateConfig: api.dlt645UpdateConfig,
          refreshRuntime: api.getRunningModuleInfo,
          storedConfig: storedMqttConfig,
          defaultConfig: DEFAULT_MQTT_CONFIG,
          isCancelled: () => initializationVersion !== initializationVersionRef.current,
          onRetry: (attempt, error) => {
            console.warn(`DLT645 MQTT 配置初始化第 ${attempt} 次尝试失败，将重试: ${String(error)}`);
          },
        });
        if (result.cancelled || initializationVersion !== initializationVersionRef.current) {
          return;
        }
        setMqttConfig(result.config);
        try {
          await saveStoredMqttConfig(STORAGE_KEY, result.config);
        } catch (error) {
          console.warn(`DLT645 MQTT 配置已下发，但本地缓存保存失败: ${String(error)}`);
        }
        console.info(
          result.initialized
            ? 'DLT645 MQTT 默认配置已自动初始化'
            : 'DLT645 MQTT 配置已从模块端同步',
        );
      } catch (error) {
        if (initializationVersion === initializationVersionRef.current) {
          console.warn(`DLT645 MQTT 配置初始化失败: ${String(error)}`);
        }
      }
    };

    void initialize();
  }, [storedMqttConfig]);

  const openModal = (): void => {
    form.setFieldsValue(mqttConfig);
    setModalOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (submitting) {
      return;
    }
    initializationVersionRef.current += 1;
    setSubmitting(true);
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
      await saveStoredMqttConfig(STORAGE_KEY, payload);
      messageApi.success(response.message || 'MQTT 配置已保存');
      setModalOpen(false);
    } catch (error) {
      messageApi.error(`保存 MQTT 配置失败: ${error}`);
    } finally {
      setSubmitting(false);
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
        confirmLoading={submitting}
        maskClosable={!submitting}
        closable={!submitting}
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
