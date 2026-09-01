import React, { useEffect, useRef, useState } from 'react';
import { Button, Col, Form, Input, InputNumber, Modal, Row, Switch, message } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { api } from '../../../adapters';
import type { ModbusMqttConfig } from '../../../adapters';
import { createDefaultMqttConfig, loadStoredMqttConfig, saveStoredMqttConfig } from '../../../utils/mqtt';
import { initializeMqttConfig } from '../../../utils/mqtt-initialization';

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
  const [storedMqttConfig] = useState<ModbusMqttConfig | null>(() =>
    loadStoredMqttConfig<ModbusMqttConfig>(STORAGE_KEY),
  );
  const [initialMqttConfig] = useState<ModbusMqttConfig>(() => storedMqttConfig ?? DEFAULT_MQTT_CONFIG);
  const [mqttConfig, setMqttConfig] = useState<ModbusMqttConfig>(() => initialMqttConfig);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<ModbusMqttConfig>();
  const initializationVersionRef = useRef(0);

  useEffect(() => {
    const initializationVersion = ++initializationVersionRef.current;
    const initialize = async (): Promise<void> => {
      try {
        const result = await initializeMqttConfig({
          getConfig: api.modbusRtuGetConfig,
          updateConfig: api.modbusRtuUpdateConfig,
          refreshRuntime: api.getRunningModuleInfo,
          storedConfig: storedMqttConfig,
          defaultConfig: DEFAULT_MQTT_CONFIG,
          isCancelled: () => initializationVersion !== initializationVersionRef.current,
          onRetry: (attempt, error) => {
            console.warn(`ModbusRTU MQTT 配置初始化第 ${attempt} 次尝试失败，将重试: ${String(error)}`);
          },
        });
        if (result.cancelled || initializationVersion !== initializationVersionRef.current) {
          return;
        }
        setMqttConfig(result.config);
        try {
          await saveStoredMqttConfig(STORAGE_KEY, result.config);
        } catch (error) {
          console.warn(`ModbusRTU MQTT 配置已下发，但本地缓存保存失败: ${String(error)}`);
        }
        console.info(
          result.initialized
            ? 'ModbusRTU MQTT 默认配置已自动初始化'
            : 'ModbusRTU MQTT 配置已从模块端同步',
        );
      } catch (error) {
        if (initializationVersion === initializationVersionRef.current) {
          console.warn(`ModbusRTU MQTT 配置初始化失败: ${String(error)}`);
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
    initializationVersionRef.current += 1;
    let values: ModbusMqttConfig;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    setSubmitting(true);
    try {
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
      <Button block={block} icon={<SettingOutlined />} onClick={openModal} style={{ whiteSpace: 'nowrap' }}>
        MQTT 全局配置
      </Button>

      <Modal
        title="MQTT 连接配置"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSubmit()}
        okText="保存配置"
        cancelText="取消"
        confirmLoading={submitting}
        maskClosable={!submitting}
        closable={!submitting}
        className="modbus-config-modal"
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} sm={16}>
              <Form.Item label="主机地址" name="host" rules={[{ required: true, message: '请输入主机地址' }]}>
                <Input placeholder="127.0.0.1" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item label="端口" name="port" rules={[{ required: true, message: '请输入端口' }]}>
                <InputNumber min={1} max={65535} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="客户端标识" name="client_id" rules={[{ required: true, message: '请输入客户端标识' }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="保活时间（秒）" name="keepalive_sec">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="用户名" name="username">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="密码" name="password">
                <Input.Password />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="连接超时（毫秒）" name="connect_timeout_ms">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="清理会话" name="clean_session" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
};

export default MqttConfigPanel;
