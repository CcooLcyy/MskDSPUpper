import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Col, Form, Input, InputNumber, message, Modal, Row, Select } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { api } from '../../adapters';
import type { ModbusLinkConfig, ModbusLinkInfo, ModbusPoint, ModbusReadPlan, ModbusSerialConfig } from '../../adapters';
import ConnectionList from './components/ConnectionList';
import ConnectionConfig from './components/ConnectionConfig';
import StatusPanel from './components/StatusPanel';
import OperationsPanel from './components/OperationsPanel';
import PointTable from './components/PointTable';
import MqttConfigPanel from './components/MqttConfigPanel';

const TRANSPORT_TYPE_OPTIONS = [
  { value: 1, label: '串口 (Serial)' },
  { value: 2, label: 'MQTT 透传 (MQTT_UART)' },
];
const ADDRESS_BASE_OPTIONS = [
  { value: 1, label: '0 基 (协议偏移)' },
  { value: 2, label: '1 基 (人类编号)' },
];
const PARITY_OPTIONS = [
  { value: 1, label: 'None' },
  { value: 2, label: 'Odd' },
  { value: 3, label: 'Even' },
];
const STOP_BITS_OPTIONS = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
];
const READ_PLAN_MODE_OPTIONS = [
  { value: 1, label: '逐点抄读 (POINT)' },
  { value: 2, label: '区间抄读 (EXPLICIT)' },
];
const READ_FUNCTION_CODE_OPTIONS = [
  { value: 1, label: '0x01 读线圈' },
  { value: 2, label: '0x03 读保持寄存器' },
  { value: 3, label: '0x04 读输入寄存器' },
];
const ALL_FUNCTION_CODE_OPTIONS = [
  ...READ_FUNCTION_CODE_OPTIONS,
  { value: 4, label: '0x06 写单寄存器' },
  { value: 5, label: '0x10 写多寄存器' },
];
const DATA_TYPE_OPTIONS = [
  { value: 1, label: 'BOOL' },
  { value: 2, label: 'UINT16' },
  { value: 3, label: 'UINT32' },
  { value: 4, label: 'INT16' },
  { value: 5, label: 'INT32' },
];
const WORD_ORDER_OPTIONS = [
  { value: 0, label: '默认 (HL)' },
  { value: 1, label: 'HL' },
  { value: 2, label: 'LH' },
];
const BYTE_ORDER_OPTIONS = [
  { value: 0, label: '默认 (AB)' },
  { value: 1, label: 'AB' },
  { value: 2, label: 'BA' },
];

const ModbusRTU: React.FC = () => {
  const [links, setLinks] = useState<ModbusLinkInfo[]>([]);
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [points, setPoints] = useState<ModbusPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<ModbusLinkConfig | null>(null);
  const [pointModalOpen, setPointModalOpen] = useState(false);
  const [editingPointIndex, setEditingPointIndex] = useState<number | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const [linkForm] = Form.useForm();
  const [pointForm] = Form.useForm();

  const selectedLink = links.find((l) => l.config?.conn_name === selectedConn) ?? null;

  const transportType = Form.useWatch('transport_type', linkForm);
  const readPlanMode = Form.useWatch('read_plan_mode', linkForm);

  const refreshLinks = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.modbusRtuListLinks();
      setLinks(list);
      if (selectedConn && !list.some((item) => item.config?.conn_name === selectedConn)) {
        setSelectedConn(null);
      }
    } catch (error) {
      messageApi.error(`刷新连接列表失败: ${error}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi, selectedConn]);

  const loadPoints = useCallback(async (connName: string) => {
    try {
      const table = await api.modbusRtuGetPointTable(connName);
      setPoints(table.points);
    } catch {
      setPoints([]);
    }
  }, []);

  const openCreateLink = useCallback(() => {
    setEditingLink(null);
    linkForm.resetFields();
    linkForm.setFieldsValue({
      conn_name: '',
      transport_type: 1,
      device_id: 1,
      poll_interval_ms: 1000,
      address_base: 1,
      serial_device: '',
      baud_rate: 9600,
      data_bits: 8,
      parity: 1,
      stop_bits: 1,
      read_timeout_ms: 0,
      read_plan_mode: 1,
      read_plan_blocks: [],
      serial_port: '',
      request_timeout_ms: 0,
      serial_byte_timeout_ms: 0,
      serial_frame_timeout_ms: 0,
      serial_est_size: 0,
    });
    setLinkModalOpen(true);
  }, [linkForm]);

  const openEditLink = useCallback(() => {
    if (!selectedLink?.config) {
      return;
    }
    const c = selectedLink.config;
    setEditingLink(c);
    linkForm.setFieldsValue({
      conn_name: c.conn_name,
      transport_type: c.transport_type || 1,
      device_id: c.device_id,
      serial_device: c.serial?.device || '',
      baud_rate: c.serial?.baud_rate ?? 9600,
      data_bits: c.serial?.data_bits ?? 8,
      parity: c.serial?.parity ?? 1,
      stop_bits: c.serial?.stop_bits ?? 1,
      read_timeout_ms: c.serial?.read_timeout_ms ?? 0,
      serial_port: c.serial_port,
      request_timeout_ms: c.request_timeout_ms,
      serial_byte_timeout_ms: c.serial_byte_timeout_ms,
      serial_frame_timeout_ms: c.serial_frame_timeout_ms,
      serial_est_size: c.serial_est_size,
      poll_interval_ms: c.poll_interval_ms,
      address_base: c.address_base || 1,
      read_plan_mode: c.read_plan?.mode ?? 1,
      read_plan_blocks: c.read_plan?.blocks ?? [],
    });
    setLinkModalOpen(true);
  }, [selectedLink, linkForm]);

  const handleLinkSubmit = useCallback(async () => {
    try {
      const values = await linkForm.validateFields();
      const serial: ModbusSerialConfig | null = values.transport_type === 1
        ? {
          device: values.serial_device || '',
          baud_rate: values.baud_rate ?? 9600,
          data_bits: values.data_bits ?? 8,
          parity: values.parity ?? 1,
          stop_bits: values.stop_bits ?? 1,
          read_timeout_ms: values.read_timeout_ms ?? 0,
        }
        : (values.transport_type === 2
            ? {
              device: '',
              baud_rate: values.baud_rate ?? 9600,
              data_bits: values.data_bits ?? 8,
              parity: values.parity ?? 1,
              stop_bits: values.stop_bits ?? 1,
              read_timeout_ms: 0,
            }
            : null);

      const readPlan: ModbusReadPlan | null = values.read_plan_mode
        ? {
          mode: values.read_plan_mode,
          blocks: values.read_plan_mode === 2
            ? (values.read_plan_blocks || []).map((block: { function: number; start: number; quantity: number }) => ({
              function: block.function,
              start: block.start,
              quantity: block.quantity,
            }))
            : [],
        }
        : null;

      const config: ModbusLinkConfig = {
        conn_name: values.conn_name,
        serial,
        device_id: values.device_id ?? 1,
        poll_interval_ms: values.poll_interval_ms ?? 1000,
        address_base: values.address_base ?? 1,
        read_plan: readPlan,
        transport_type: values.transport_type ?? 1,
        serial_port: values.serial_port || '',
        request_timeout_ms: values.request_timeout_ms ?? 0,
        serial_byte_timeout_ms: values.serial_byte_timeout_ms ?? 0,
        serial_frame_timeout_ms: values.serial_frame_timeout_ms ?? 0,
        serial_est_size: values.serial_est_size ?? 0,
      };

      const createOnly = !editingLink;
      await api.modbusRtuUpsertLink(config, createOnly);
      messageApi.success(createOnly ? '连接创建成功' : '连接更新成功');
      setLinkModalOpen(false);
      await refreshLinks();
      setSelectedConn(config.conn_name);
    } catch (error) {
      messageApi.error(`保存连接失败: ${error}`);
    }
  }, [editingLink, linkForm, messageApi, refreshLinks]);

  const handleDeleteLink = useCallback(async (connName: string) => {
    try {
      await api.modbusRtuDeleteLink(connName);
      messageApi.success(`连接 ${connName} 已删除`);
      if (selectedConn === connName) {
        setSelectedConn(null);
      }
      await refreshLinks();
    } catch (error) {
      messageApi.error(`删除连接失败: ${error}`);
    }
  }, [messageApi, refreshLinks, selectedConn]);

  const handleStartLink = useCallback(async () => {
    if (!selectedConn) {
      return;
    }
    try {
      await api.modbusRtuStartLink(selectedConn);
      messageApi.success('启动请求已发送');
      window.setTimeout(() => {
        void refreshLinks();
      }, 1000);
    } catch (error) {
      messageApi.error(`启动失败: ${error}`);
    }
  }, [messageApi, refreshLinks, selectedConn]);

  const handleStopLink = useCallback(async () => {
    if (!selectedConn) {
      return;
    }
    try {
      await api.modbusRtuStopLink(selectedConn);
      messageApi.success('停止请求已发送');
      window.setTimeout(() => {
        void refreshLinks();
      }, 1000);
    } catch (error) {
      messageApi.error(`停止失败: ${error}`);
    }
  }, [messageApi, refreshLinks, selectedConn]);

  const openCreatePoint = useCallback(() => {
    setEditingPointIndex(null);
    pointForm.resetFields();
    pointForm.setFieldsValue({
      tag: '',
      function: 1,
      address: 0,
      reg_count: 0,
      data_type: 1,
      scale: 1,
      offset: 0,
      deadband: 0,
      word_order: 0,
      byte_order: 0,
    });
    setPointModalOpen(true);
  }, [pointForm]);

  const openEditPoint = useCallback((index: number) => {
    const point = points[index];
    setEditingPointIndex(index);
    pointForm.setFieldsValue({
      tag: point.tag,
      function: point.function,
      address: point.address,
      reg_count: point.reg_count,
      data_type: point.data_type,
      scale: point.scale,
      offset: point.offset,
      deadband: point.deadband,
      word_order: point.word_order,
      byte_order: point.byte_order,
    });
    setPointModalOpen(true);
  }, [pointForm, points]);

  const handlePointSubmit = useCallback(async () => {
    if (!selectedConn) {
      return;
    }
    try {
      const values = await pointForm.validateFields();
      const newPoint: ModbusPoint = {
        tag: values.tag,
        function: values.function,
        address: values.address,
        data_type: values.data_type,
        scale: values.scale ?? 1,
        offset: values.offset ?? 0,
        deadband: values.deadband ?? 0,
        reg_count: values.reg_count ?? 0,
        word_order: values.word_order ?? 0,
        byte_order: values.byte_order ?? 0,
      };
      const newPoints = editingPointIndex !== null
        ? points.map((point, index) => (index === editingPointIndex ? newPoint : point))
        : [...points, newPoint];
      await api.modbusRtuUpsertPointTable(selectedConn, newPoints, true);
      setPoints(newPoints);
      setPointModalOpen(false);
      messageApi.success(editingPointIndex !== null ? '点位已更新' : '点位已添加');
    } catch (error) {
      messageApi.error(`保存点位失败: ${error}`);
    }
  }, [editingPointIndex, messageApi, pointForm, points, selectedConn]);

  const handleDeletePoint = useCallback(async (index: number) => {
    if (!selectedConn) {
      return;
    }
    try {
      const newPoints = points.filter((_point, pointIndex) => pointIndex !== index);
      await api.modbusRtuUpsertPointTable(selectedConn, newPoints, true);
      setPoints(newPoints);
      messageApi.success('点位已删除');
    } catch (error) {
      messageApi.error(`删除点位失败: ${error}`);
    }
  }, [messageApi, points, selectedConn]);

  useEffect(() => {
    void refreshLinks();
  }, [refreshLinks]);

  useEffect(() => {
    if (selectedConn) {
      void loadPoints(selectedConn);
    } else {
      setPoints([]);
    }
  }, [selectedConn, loadPoints]);

  const renderLinkModal = (): React.ReactNode => (
    <Modal
      title={editingLink ? '编辑连接' : '新增连接'}
      open={linkModalOpen}
      onCancel={() => setLinkModalOpen(false)}
      onOk={() => void handleLinkSubmit()}
      width={720}
      destroyOnClose
    >
      <Form form={linkForm} layout="vertical" size="small">
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="连接名称" name="conn_name" rules={[{ required: true, message: '请输入连接名称' }]}>
              <Input disabled={!!editingLink} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="传输类型" name="transport_type" rules={[{ required: true, message: '请选择传输类型' }]}>
              <Select options={TRANSPORT_TYPE_OPTIONS} placeholder="请选择传输类型" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="设备地址" name="device_id" rules={[{ required: true, message: '请输入设备地址' }]}>
              <InputNumber min={1} max={247} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        {transportType === 1 ? (
          <>
            <Row gutter={16}>
              <Col span={6}>
                <Form.Item label="串口设备" name="serial_device" rules={[{ required: true, message: '请输入串口设备' }]}>
                  <Input placeholder="/dev/ttyUSB0" />
                </Form.Item>
              </Col>
              <Col span={4}>
                <Form.Item label="波特率" name="baud_rate" rules={[{ required: true, message: '请输入波特率' }]}>
                  <InputNumber style={{ width: '100%' }} placeholder="9600" />
                </Form.Item>
              </Col>
              <Col span={4}>
                <Form.Item label="数据位" name="data_bits" rules={[{ required: true, message: '请输入数据位' }]}>
                  <InputNumber min={5} max={8} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={5}>
                <Form.Item label="校验位" name="parity" rules={[{ required: true, message: '请选择校验位' }]}>
                  <Select options={PARITY_OPTIONS} />
                </Form.Item>
              </Col>
              <Col span={5}>
                <Form.Item label="停止位" name="stop_bits" rules={[{ required: true, message: '请选择停止位' }]}>
                  <Select options={STOP_BITS_OPTIONS} />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col span={6}>
                <Form.Item label="读超时（毫秒）" name="read_timeout_ms">
                  <InputNumber min={0} style={{ width: '100%' }} placeholder="0=默认" />
                </Form.Item>
              </Col>
            </Row>
          </>
        ) : null}

        {transportType === 2 ? (
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item label="远端串口标识" name="serial_port" rules={[{ required: true, message: '请输入远端串口标识' }]}>
                <Input placeholder="RS485-1" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="请求超时（毫秒）" name="request_timeout_ms" rules={[{ required: true, message: '请输入请求超时' }]}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="字节超时（毫秒）" name="serial_byte_timeout_ms" rules={[{ required: true, message: '请输入字节超时' }]}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="帧超时（毫秒）" name="serial_frame_timeout_ms" rules={[{ required: true, message: '请输入帧超时' }]}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="估算帧长度" name="serial_est_size" rules={[{ required: true, message: '请输入估算帧长度' }]}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        ) : null}

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="轮询间隔（毫秒）" name="poll_interval_ms" rules={[{ required: true, message: '请输入轮询间隔' }]}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="地址基准" name="address_base" rules={[{ required: true, message: '请选择地址基准' }]}>
              <Select options={ADDRESS_BASE_OPTIONS} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="抄读模式" name="read_plan_mode" rules={[{ required: true, message: '请选择抄读模式' }]}>
              <Select options={READ_PLAN_MODE_OPTIONS} />
            </Form.Item>
          </Col>
        </Row>

        {readPlanMode === 2 ? (
          <Form.List name="read_plan_blocks">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Row gutter={16} key={field.key} align="middle">
                    <Col span={8}>
                      <Form.Item
                        label="功能码"
                        name={[field.name, 'function']}
                        rules={[{ required: true, message: '请选择功能码' }]}
                      >
                        <Select options={READ_FUNCTION_CODE_OPTIONS} />
                      </Form.Item>
                    </Col>
                    <Col span={6}>
                      <Form.Item
                        label="起始地址"
                        name={[field.name, 'start']}
                        rules={[{ required: true, message: '请输入起始地址' }]}
                      >
                        <InputNumber min={0} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col span={6}>
                      <Form.Item
                        label="数量"
                        name={[field.name, 'quantity']}
                        rules={[{ required: true, message: '请输入数量' }]}
                      >
                        <InputNumber min={1} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col span={4}>
                      <Button
                        danger
                        type="text"
                        icon={<MinusCircleOutlined />}
                        style={{ marginTop: 30 }}
                        onClick={() => remove(field.name)}
                      >
                        删除
                      </Button>
                    </Col>
                  </Row>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add()}>
                  添加区间
                </Button>
              </>
            )}
          </Form.List>
        ) : null}
      </Form>
    </Modal>
  );

  const renderPointModal = (): React.ReactNode => (
    <Modal
      title={editingPointIndex !== null ? '编辑点位' : '新增点位'}
      open={pointModalOpen}
      onCancel={() => setPointModalOpen(false)}
      onOk={() => void handlePointSubmit()}
      width={640}
      destroyOnClose
    >
      <Form form={pointForm} layout="vertical" size="small">
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="标签" name="tag" rules={[{ required: true, message: '请输入标签' }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="功能码" name="function" rules={[{ required: true, message: '请选择功能码' }]}>
              <Select options={ALL_FUNCTION_CODE_OPTIONS} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="地址" name="address" rules={[{ required: true, message: '请输入地址' }]}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item label="寄存器数" name="reg_count">
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="数据类型" name="data_type" rules={[{ required: true, message: '请选择数据类型' }]}>
              <Select options={DATA_TYPE_OPTIONS} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="缩放系数" name="scale">
              <InputNumber step={0.01} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="偏移量" name="offset">
              <InputNumber step={0.01} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="死区" name="deadband">
              <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="字序" name="word_order">
              <Select options={WORD_ORDER_OPTIONS} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="字节序" name="byte_order">
              <Select options={BYTE_ORDER_OPTIONS} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );

  return (
    <div>
      {contextHolder}

      <div style={{ display: 'flex', gap: 16 }}>
        <ConnectionList
          links={links}
          selectedConn={selectedConn}
          loading={loading}
          onSelect={setSelectedConn}
          onCreate={openCreateLink}
          onDelete={(connName) => void handleDeleteLink(connName)}
          onRefresh={() => void refreshLinks()}
        />

        <ConnectionConfig link={selectedLink} onEdit={openEditLink} />

        <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <StatusPanel link={selectedLink} />
          <OperationsPanel
            selectedConn={selectedConn}
            onStart={() => void handleStartLink()}
            onStop={() => void handleStopLink()}
            extraAction={<MqttConfigPanel block />}
          />
        </div>
      </div>


      <div style={{ marginTop: 16 }}>
        <PointTable
          points={points}
          selectedConn={selectedConn}
          onAdd={openCreatePoint}
          onEdit={(index) => openEditPoint(index)}
          onDelete={(index) => void handleDeletePoint(index)}
        />
      </div>

      <Card title="报文日志" size="small" bordered style={{ marginTop: 16 }}>
        <div
          style={{
            background: '#1e1e1e',
            borderRadius: 4,
            padding: 16,
            fontFamily: '"Consolas", monospace',
            fontSize: 12,
            lineHeight: '22px',
            minHeight: 180,
            color: '#aaa',
          }}
        >
          <div>
            <span style={{ color: '#007acc' }}>[TX]</span>
            {' '}
            --:--:--.--- - 报文日志 — 接入实时数据后渲染
          </div>
          <div style={{ marginTop: 8, color: '#666' }}>等待链路启动后显示报文收发记录...</div>
        </div>
      </Card>

      {renderLinkModal()}
      {renderPointModal()}
    </div>
  );
};

export default ModbusRTU;
