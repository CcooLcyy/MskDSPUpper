import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Col, Form, Input, InputNumber, message, Modal, Row, Select, Switch } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { api } from '../../adapters';
import type { Dlt645LinkConfig, Dlt645LinkInfo, Dlt645Point, Dlt645Block, Dlt645BlockItem } from '../../adapters';
import ConnectionList from './components/ConnectionList';
import ConnectionConfig from './components/ConnectionConfig';
import StatusPanel from './components/StatusPanel';
import OperationsPanel from './components/OperationsPanel';
import PointTable from './components/PointTable';
import MqttConfigPanel from './components/MqttConfigPanel';

const PROTOCOL_VARIANT_OPTIONS = [
  { value: 1, label: 'DLT645 标准版' },
  { value: 2, label: 'DLT645 PCD 版' },
];
const COMM_MODE_OPTIONS = [
  { value: 1, label: '载波 (Carrier)' },
  { value: 2, label: '串口 (Serial)' },
  { value: 3, label: 'LoRa' },
];
const DATA_TYPE_OPTIONS = [
  { value: 1, label: 'BOOL' },
  { value: 2, label: 'UINT16' },
  { value: 3, label: 'UINT32' },
  { value: 4, label: 'FLOAT' },
  { value: 5, label: 'STRING' },
  { value: 6, label: 'BCD' },
];
const ACCESS_MODE_OPTIONS = [
  { value: 1, label: '只读' },
  { value: 2, label: '只写' },
  { value: 3, label: '读写' },
];
const PARITY_OPTIONS = [
  { value: 0, label: '未指定' },
  { value: 1, label: 'None' },
  { value: 2, label: 'Odd' },
  { value: 3, label: 'Even' },
];
const STOP_BITS_OPTIONS = [
  { value: 0, label: '未指定' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
];

const DLT645: React.FC = () => {
  const [links, setLinks] = useState<Dlt645LinkInfo[]>([]);
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [points, setPoints] = useState<Dlt645Point[]>([]);
  const [blocks, setBlocks] = useState<Dlt645Block[]>([]);
  const [loading, setLoading] = useState(false);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<Dlt645LinkConfig | null>(null);
  const [pointModalOpen, setPointModalOpen] = useState(false);
  const [editingPointIndex, setEditingPointIndex] = useState<number | null>(null);
  const [blockModalOpen, setBlockModalOpen] = useState(false);
  const [editingBlockIndex, setEditingBlockIndex] = useState<number | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const [linkForm] = Form.useForm();
  const [pointForm] = Form.useForm();
  const [blockForm] = Form.useForm();

  const selectedLink = links.find((l) => l.config?.conn_name === selectedConn) ?? null;

  const protocolVariant = Form.useWatch('protocol_variant', linkForm);
  const commMode = Form.useWatch('comm_mode', linkForm);

  // ── Data fetching ──

  const refreshLinks = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.dlt645ListLinks();
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

  const loadPointTable = useCallback(async (connName: string) => {
    try {
      const table = await api.dlt645GetPointTable(connName);
      setPoints(table.points);
      setBlocks(table.blocks);
    } catch {
      setPoints([]);
      setBlocks([]);
    }
  }, []);

  // ── Link CRUD ──

  const openCreateLink = useCallback(() => {
    setEditingLink(null);
    linkForm.resetFields();
    linkForm.setFieldsValue({
      conn_name: '',
      protocol_variant: 1,
      meter_addr: '',
      device_no: '',
      comm_mode: 3,
      poll_interval_ms: 1000,
      poll_item_interval_ms: 0,
      request_timeout_ms: 3000,
      serial_port: '',
      serial_baud_rate: 2400,
      serial_data_bits: 8,
      serial_parity: 3,
      serial_stop_bits: 1,
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
      protocol_variant: c.protocol_variant || 1,
      meter_addr: c.meter_addr,
      device_no: c.device_no,
      comm_mode: c.comm_mode || 3,
      poll_interval_ms: c.poll_interval_ms,
      poll_item_interval_ms: c.poll_item_interval_ms,
      request_timeout_ms: c.request_timeout_ms,
      serial_port: c.serial_port,
      serial_baud_rate: c.serial_baud_rate || 2400,
      serial_data_bits: c.serial_data_bits || 8,
      serial_parity: c.serial_parity ?? 3,
      serial_stop_bits: c.serial_stop_bits ?? 1,
      serial_byte_timeout_ms: c.serial_byte_timeout_ms,
      serial_frame_timeout_ms: c.serial_frame_timeout_ms,
      serial_est_size: c.serial_est_size,
    });
    setLinkModalOpen(true);
  }, [selectedLink, linkForm]);

  const handleLinkSubmit = useCallback(async () => {
    try {
      const values = await linkForm.validateFields();
      const config: Dlt645LinkConfig = {
        conn_name: values.conn_name,
        protocol_variant: values.protocol_variant ?? 1,
        meter_addr: values.meter_addr ?? '',
        device_no: values.device_no ?? '',
        transport_type: 1, // TRANSPORT_MQTT
        comm_mode: values.comm_mode ?? 3,
        poll_interval_ms: values.poll_interval_ms ?? 1000,
        poll_item_interval_ms: values.poll_item_interval_ms ?? 0,
        request_timeout_ms: values.request_timeout_ms ?? 3000,
        serial_port: values.serial_port ?? '',
        serial_baud_rate: values.serial_baud_rate ?? 0,
        serial_data_bits: values.serial_data_bits ?? 0,
        serial_parity: values.serial_parity ?? 0,
        serial_stop_bits: values.serial_stop_bits ?? 0,
        serial_byte_timeout_ms: values.serial_byte_timeout_ms ?? 0,
        serial_frame_timeout_ms: values.serial_frame_timeout_ms ?? 0,
        serial_est_size: values.serial_est_size ?? 0,
      };
      const createOnly = !editingLink;
      await api.dlt645UpsertLink(config, createOnly);
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
      await api.dlt645DeleteLink(connName);
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
      await api.dlt645StartLink(selectedConn);
      messageApi.success('启动连接功能请求已发送');
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
      await api.dlt645StopLink(selectedConn);
      messageApi.success('停止连接功能请求已发送');
      window.setTimeout(() => {
        void refreshLinks();
      }, 1000);
    } catch (error) {
      messageApi.error(`停止失败: ${error}`);
    }
  }, [messageApi, refreshLinks, selectedConn]);

  // ── Point CRUD ──

  const openCreatePoint = useCallback(() => {
    setEditingPointIndex(null);
    pointForm.resetFields();
    pointForm.setFieldsValue({
      tag: '',
      di: '',
      data_len: 4,
      data_type: 6,
      access: 1,
      scale: 1,
      offset: 0,
      deadband: 0,
    });
    setPointModalOpen(true);
  }, [pointForm]);

  const openEditPoint = useCallback((index: number) => {
    const point = points[index];
    setEditingPointIndex(index);
    pointForm.setFieldsValue({
      tag: point.tag,
      di: point.di,
      data_len: point.data_len,
      data_type: point.data_type,
      access: point.access,
      scale: point.scale,
      offset: point.offset,
      deadband: point.deadband,
    });
    setPointModalOpen(true);
  }, [pointForm, points]);

  const handlePointSubmit = useCallback(async () => {
    if (!selectedConn) {
      return;
    }
    try {
      const values = await pointForm.validateFields();
      const newPoint: Dlt645Point = {
        tag: values.tag,
        di: values.di,
        data_len: values.data_len ?? 4,
        data_type: values.data_type ?? 6,
        access: values.access ?? 1,
        scale: values.scale ?? 1,
        offset: values.offset ?? 0,
        deadband: values.deadband ?? 0,
      };
      const newPoints = editingPointIndex !== null
        ? points.map((point, index) => (index === editingPointIndex ? newPoint : point))
        : [...points, newPoint];
      await api.dlt645UpsertPointTable(selectedConn, newPoints, blocks, true);
      setPoints(newPoints);
      setPointModalOpen(false);
      messageApi.success(editingPointIndex !== null ? '点位已更新' : '点位已添加');
    } catch (error) {
      messageApi.error(`保存点位失败: ${error}`);
    }
  }, [blocks, editingPointIndex, messageApi, pointForm, points, selectedConn]);

  const handleDeletePoint = useCallback(async (index: number) => {
    if (!selectedConn) {
      return;
    }
    try {
      const newPoints = points.filter((_point, pointIndex) => pointIndex !== index);
      await api.dlt645UpsertPointTable(selectedConn, newPoints, blocks, true);
      setPoints(newPoints);
      messageApi.success('点位已删除');
    } catch (error) {
      messageApi.error(`删除点位失败: ${error}`);
    }
  }, [blocks, messageApi, points, selectedConn]);

  // ── Block CRUD ──

  const openCreateBlock = useCallback(() => {
    setEditingBlockIndex(null);
    blockForm.resetFields();
    blockForm.setFieldsValue({
      block_di: '',
      block_data_len: 0,
      items: [],
    });
    setBlockModalOpen(true);
  }, [blockForm]);

  const openEditBlock = useCallback((index: number) => {
    const block = blocks[index];
    setEditingBlockIndex(index);
    blockForm.setFieldsValue({
      block_di: block.block_di,
      block_data_len: block.block_data_len,
      items: block.items.map((item) => ({
        tag: item.tag,
        data_len: item.data_len,
        data_type: item.data_type,
        access: item.access,
        scale: item.scale,
        offset: item.offset,
        deadband: item.deadband,
        trim_right_space: item.trim_right_space ?? true,
      })),
    });
    setBlockModalOpen(true);
  }, [blockForm, blocks]);

  const handleBlockSubmit = useCallback(async () => {
    if (!selectedConn) {
      return;
    }
    try {
      const values = await blockForm.validateFields();
      const newBlock: Dlt645Block = {
        block_di: values.block_di,
        block_data_len: values.block_data_len ?? 0,
        items: (values.items || []).map((item: Dlt645BlockItem) => ({
          tag: item.tag,
          data_len: item.data_len ?? 0,
          data_type: item.data_type ?? 6,
          access: item.access ?? 1,
          scale: item.scale ?? 1,
          offset: item.offset ?? 0,
          deadband: item.deadband ?? 0,
          trim_right_space: item.trim_right_space ?? null,
        })),
      };
      const newBlocks = editingBlockIndex !== null
        ? blocks.map((block, index) => (index === editingBlockIndex ? newBlock : block))
        : [...blocks, newBlock];
      await api.dlt645UpsertPointTable(selectedConn, points, newBlocks, true);
      setBlocks(newBlocks);
      setBlockModalOpen(false);
      messageApi.success(editingBlockIndex !== null ? '数据块已更新' : '数据块已添加');
    } catch (error) {
      messageApi.error(`保存数据块失败: ${error}`);
    }
  }, [blocks, editingBlockIndex, messageApi, blockForm, points, selectedConn]);

  const handleDeleteBlock = useCallback(async (index: number) => {
    if (!selectedConn) {
      return;
    }
    try {
      const newBlocks = blocks.filter((_block, blockIndex) => blockIndex !== index);
      await api.dlt645UpsertPointTable(selectedConn, points, newBlocks, true);
      setBlocks(newBlocks);
      messageApi.success('数据块已删除');
    } catch (error) {
      messageApi.error(`删除数据块失败: ${error}`);
    }
  }, [blocks, messageApi, points, selectedConn]);

  // ── Effects ──

  useEffect(() => {
    void refreshLinks();
  }, [refreshLinks]);

  useEffect(() => {
    if (selectedConn) {
      void loadPointTable(selectedConn);
    } else {
      setPoints([]);
      setBlocks([]);
    }
  }, [selectedConn, loadPointTable]);

  // ── Link Modal ──

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
            <Form.Item label="协议变体" name="protocol_variant" rules={[{ required: true, message: '请选择协议变体' }]}>
              <Select options={PROTOCOL_VARIANT_OPTIONS} placeholder="请选择协议变体" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="表计地址"
              name="meter_addr"
              rules={[{ required: true, message: '请输入表计地址' }]}
            >
              <Input placeholder="000000000000" maxLength={12} />
            </Form.Item>
          </Col>
        </Row>

        {protocolVariant === 2 ? (
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label="设备序号 (PCD)"
                name="device_no"
                rules={[{ required: true, message: '请输入设备序号' }]}
              >
                <Input placeholder="0A" maxLength={2} />
              </Form.Item>
            </Col>
          </Row>
        ) : null}

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="通信方式" name="comm_mode" rules={[{ required: true, message: '请选择通信方式' }]}>
              <Select options={COMM_MODE_OPTIONS} placeholder="请选择通信方式" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="轮询间隔（毫秒）" name="poll_interval_ms" rules={[{ required: true, message: '请输入轮询间隔' }]}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="点抄间隔（毫秒）" name="poll_item_interval_ms">
              <InputNumber min={0} style={{ width: '100%' }} placeholder="0=无额外等待" />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="请求超时（毫秒）" name="request_timeout_ms">
              <InputNumber min={0} style={{ width: '100%' }} placeholder="0=默认" />
            </Form.Item>
          </Col>
        </Row>

        {commMode === 2 ? (
          <>
            <Row gutter={16}>
              <Col span={6}>
                <Form.Item label="串口标识" name="serial_port" rules={[{ required: true, message: '请输入串口标识' }]}>
                  <Input placeholder="RS485-1" />
                </Form.Item>
              </Col>
              <Col span={4}>
                <Form.Item label="波特率" name="serial_baud_rate">
                  <InputNumber style={{ width: '100%' }} placeholder="2400" />
                </Form.Item>
              </Col>
              <Col span={4}>
                <Form.Item label="数据位" name="serial_data_bits">
                  <InputNumber min={5} max={8} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={5}>
                <Form.Item label="校验位" name="serial_parity">
                  <Select options={PARITY_OPTIONS} />
                </Form.Item>
              </Col>
              <Col span={5}>
                <Form.Item label="停止位" name="serial_stop_bits">
                  <Select options={STOP_BITS_OPTIONS} />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item label="字节超时（毫秒）" name="serial_byte_timeout_ms">
                  <InputNumber min={0} style={{ width: '100%' }} placeholder="0=默认" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="帧超时（毫秒）" name="serial_frame_timeout_ms">
                  <InputNumber min={0} style={{ width: '100%' }} placeholder="0=默认" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="估算帧长度" name="serial_est_size">
                  <InputNumber min={0} style={{ width: '100%' }} placeholder="0=默认" />
                </Form.Item>
              </Col>
            </Row>
          </>
        ) : null}
      </Form>
    </Modal>
  );

  // ── Point Modal ──

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
            <Form.Item
              label="数据标识 (DI)"
              name="di"
              rules={[{ required: true, message: '请输入数据标识' }]}
            >
              <Input placeholder="02010100" maxLength={8} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="数据长度" name="data_len" rules={[{ required: true, message: '请输入数据长度' }]}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item label="数据类型" name="data_type" rules={[{ required: true, message: '请选择数据类型' }]}>
              <Select options={DATA_TYPE_OPTIONS} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="读写属性" name="access" rules={[{ required: true, message: '请选择读写属性' }]}>
              <Select options={ACCESS_MODE_OPTIONS} />
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
        </Row>
      </Form>
    </Modal>
  );

  // ── Block Modal ──

  const renderBlockModal = (): React.ReactNode => (
    <Modal
      title={editingBlockIndex !== null ? '编辑数据块' : '新增数据块'}
      open={blockModalOpen}
      onCancel={() => setBlockModalOpen(false)}
      onOk={() => void handleBlockSubmit()}
      width={800}
      destroyOnClose
    >
      <Form form={blockForm} layout="vertical" size="small">
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item
              label="块数据标识 (Block DI)"
              name="block_di"
              rules={[{ required: true, message: '请输入块数据标识' }]}
            >
              <Input placeholder="02010100" maxLength={8} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="块数据长度" name="block_data_len" rules={[{ required: true, message: '请输入块数据长度' }]}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <Row gutter={8} key={field.key} align="middle">
                  <Col span={4}>
                    <Form.Item
                      label={field.key === 0 ? '标签' : undefined}
                      name={[field.name, 'tag']}
                      rules={[{ required: true, message: '标签' }]}
                    >
                      <Input placeholder="标签" />
                    </Form.Item>
                  </Col>
                  <Col span={3}>
                    <Form.Item
                      label={field.key === 0 ? '长度' : undefined}
                      name={[field.name, 'data_len']}
                      rules={[{ required: true, message: '长度' }]}
                    >
                      <InputNumber min={0} style={{ width: '100%' }} placeholder="长度" />
                    </Form.Item>
                  </Col>
                  <Col span={4}>
                    <Form.Item
                      label={field.key === 0 ? '类型' : undefined}
                      name={[field.name, 'data_type']}
                      rules={[{ required: true, message: '类型' }]}
                    >
                      <Select options={DATA_TYPE_OPTIONS} placeholder="类型" />
                    </Form.Item>
                  </Col>
                  <Col span={3}>
                    <Form.Item
                      label={field.key === 0 ? '读写' : undefined}
                      name={[field.name, 'access']}
                    >
                      <Select options={ACCESS_MODE_OPTIONS} placeholder="读写" />
                    </Form.Item>
                  </Col>
                  <Col span={3}>
                    <Form.Item
                      label={field.key === 0 ? 'Scale' : undefined}
                      name={[field.name, 'scale']}
                    >
                      <InputNumber step={0.01} style={{ width: '100%' }} placeholder="1" />
                    </Form.Item>
                  </Col>
                  <Col span={3}>
                    <Form.Item
                      label={field.key === 0 ? 'Offset' : undefined}
                      name={[field.name, 'offset']}
                    >
                      <InputNumber step={0.01} style={{ width: '100%' }} placeholder="0" />
                    </Form.Item>
                  </Col>
                  <Col span={2}>
                    <Form.Item
                      label={field.key === 0 ? 'Trim' : undefined}
                      name={[field.name, 'trim_right_space']}
                      valuePropName="checked"
                    >
                      <Switch size="small" />
                    </Form.Item>
                  </Col>
                  <Col span={2}>
                    <Button
                      danger
                      type="text"
                      icon={<MinusCircleOutlined />}
                      style={field.key === 0 ? { marginTop: 30 } : undefined}
                      onClick={() => remove(field.name)}
                    />
                  </Col>
                </Row>
              ))}
              <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ data_type: 6, access: 1, scale: 1, offset: 0, deadband: 0, trim_right_space: true })}>
                添加子项
              </Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );

  // ── Render ──

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
          blocks={blocks}
          selectedConn={selectedConn}
          onAddPoint={openCreatePoint}
          onEditPoint={(index) => openEditPoint(index)}
          onDeletePoint={(index) => void handleDeletePoint(index)}
          onAddBlock={openCreateBlock}
          onEditBlock={(index) => openEditBlock(index)}
          onDeleteBlock={(index) => void handleDeleteBlock(index)}
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
      {renderBlockModal()}
    </div>
  );
};

export default DLT645;
