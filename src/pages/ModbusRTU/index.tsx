import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Form, Input, InputNumber, message, Modal, Row, Select, Typography } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../adapters';
import type { ModbusLinkConfig, ModbusLinkInfo, ModbusPoint, ModbusReadPlan, ModbusSerialConfig } from '../../adapters';
import ProtocolConnectionList from '../../components/protocol/ProtocolConnectionList';
import ResizableSplit from '../../components/layout/ResizableSplit';
import { normalizeProtocolView, PROTOCOL_VIEW_QUERY_KEY } from '../../components/protocol/protocol-view';
import { buildDuplicateConnectionName, isNotFoundError } from '../../utils/connection-copy';
import { formatErrorText, runWithRuntimeRestart } from '../../utils/runtime-restart';
import ConnectionConfig from './components/ConnectionConfig';
import PointTable from './components/PointTable';
import MqttConfigPanel from './components/MqttConfigPanel';
import { useProtocolShadowRealtime } from '../../components/protocol/protocol-realtime';
import {
  MODBUS_ADDRESS_BASE,
  MODBUS_DATA_TYPE,
  MODBUS_FUNCTION,
  createDefaultModbusPoint,
  getAllowedDataTypes,
  getAllowedRegCounts,
  getDefaultRegCount,
  getNextDuplicatePointAddress,
  getMinimumAddress,
} from './modbus-form-rules';
import type { ModbusPointFormValues } from './modbus-form-rules';

const { Text } = Typography;

const TRANSPORT_TYPE_OPTIONS = [
  { value: 1, label: '本地串口' },
  { value: 2, label: 'MQTT 透传' },
];
const ADDRESS_BASE_OPTIONS = [
  { value: 1, label: '0 基 (协议偏移)' },
  { value: 2, label: '1 基 (人类编号)' },
];
const PARITY_OPTIONS = [
  { value: 1, label: '无校验' },
  { value: 2, label: '奇校验' },
  { value: 3, label: '偶校验' },
];
const STOP_BITS_OPTIONS = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
];
const READ_FUNCTION_CODE_OPTIONS = [
  { value: 2, label: '0x03 读保持寄存器' },
  { value: 3, label: '0x04 读输入寄存器' },
];
const ALL_FUNCTION_CODE_OPTIONS = [
  { value: 1, label: '0x01 读线圈' },
  ...READ_FUNCTION_CODE_OPTIONS,
  { value: 4, label: '0x06 写单寄存器' },
  { value: 5, label: '0x10 写多寄存器' },
];
const LIST_STATE_COLOR_MAP: Record<number, string> = {
  0: '#8c8c8c',
  1: '#f44336',
  2: '#4caf50',
  3: '#ff9800',
};
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

const LINK_STATE_LABELS: Record<number, string> = {
  0: '状态未知',
  1: '已停止',
  2: '运行中',
  3: '待删除',
};


const MODBUS_DATA_TYPE_LABELS: Record<number, string> = {
  1: 'BOOL',
  2: 'UINT16',
  3: 'UINT32',
  4: 'INT16',
  5: 'INT32',
};

interface LinkFormValues {
  conn_name: string;
  transport_type: number;
  device_id: number;
  poll_interval_ms: number;
  address_base: number;
  serial_device: string;
  baud_rate: number;
  data_bits: number;
  parity: number;
  stop_bits: number;
  read_timeout_ms: number;
  serial_port: string;
  request_timeout_ms: number;
  serial_byte_timeout_ms: number;
  serial_frame_timeout_ms: number;
  serial_est_size: number;
}

const ModbusRTU: React.FC = () => {
  const [links, setLinks] = useState<ModbusLinkInfo[]>([]);
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [points, setPoints] = useState<ModbusPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [pointsLoading, setPointsLoading] = useState(false);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<ModbusLinkConfig | null>(null);
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [pointModalOpen, setPointModalOpen] = useState(false);
  const [editingPointIndex, setEditingPointIndex] = useState<number | null>(null);
  const [pointSubmitting, setPointSubmitting] = useState(false);
  const [readPlanSaving, setReadPlanSaving] = useState(false);
  const [runtimeAction, setRuntimeAction] = useState<'start' | 'stop' | null>(null);
  const [linkMutation, setLinkMutation] = useState<'copy' | 'delete' | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const [linkForm] = Form.useForm<LinkFormValues>();
  const [pointForm] = Form.useForm<ModbusPointFormValues & { address_base: number }>();
  const [searchParams] = useSearchParams();
  const pointLoadRequestRef = useRef(0);
  const readPlanDirtyRef = useRef(false);

  const selectedLink = links.find((l) => l.config?.conn_name === selectedConn) ?? null;
  const currentView = normalizeProtocolView(searchParams.get(PROTOCOL_VIEW_QUERY_KEY));
  const realtimeTags = useMemo(
    () => points.map((point) => point.tag),
    [points],
  );
  const {
    realtimeByTag,
    realtimeRevisionByTag,
    loading: realtimeLoading,
    error: realtimeError,
  } = useProtocolShadowRealtime(
    selectedLink?.conn_id ?? null,
    realtimeTags,
  );

  const transportType = Form.useWatch('transport_type', linkForm);
  const pointFunction = Form.useWatch('function', pointForm);
  const pointTag = Form.useWatch('tag', pointForm);
  const pointDataType = Form.useWatch('data_type', pointForm);
  const pointRegCount = Form.useWatch('reg_count', pointForm);
  const pointAddressBase = Form.useWatch('address_base', pointForm);
  const isCoilPoint = pointFunction === MODBUS_FUNCTION.READ_COILS;
  const isRegisterBoolPoint = pointDataType === MODBUS_DATA_TYPE.BOOL
    && (pointFunction === MODBUS_FUNCTION.READ_HOLDING_REGISTERS || pointFunction === MODBUS_FUNCTION.READ_INPUT_REGISTERS);
  const pointDataTypeOptions = getAllowedDataTypes(pointFunction ?? MODBUS_FUNCTION.READ_HOLDING_REGISTERS)
    .map((value) => ({ value, label: MODBUS_DATA_TYPE_LABELS[value] }));
  const pointRegCountOptions = (isCoilPoint ? [1] : getAllowedRegCounts(pointDataType ?? MODBUS_DATA_TYPE.UINT16))
    .map((value) => ({ value, label: `${value} 个寄存器` }));
  const pointBitMax = (pointRegCount ?? 1) * 16 - 1;
  const pointTagTrimmed = typeof pointTag === 'string' ? pointTag.trim() : '';
  const pointTagDuplicate = pointTagTrimmed.length > 0 && points.some(
    (point, index) => index !== editingPointIndex && point.tag.trim() === pointTagTrimmed,
  );
  const modalOpen = linkModalOpen || pointModalOpen;
  const actionsDisabled = pointsLoading
    || pointSubmitting
    || linkSubmitting
    || readPlanSaving
    || runtimeAction !== null
    || linkMutation !== null
    || modalOpen;

  const refreshLinks = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const list = (await api.modbusRtuListLinks()).sort((left, right) => {
        const leftName = left.config?.conn_name ?? `conn_${left.conn_id}`;
        const rightName = right.config?.conn_name ?? `conn_${right.conn_id}`;
        return leftName.localeCompare(rightName, 'zh-CN');
      });
      setLinks(list);
      setRefreshError(null);
      setLastRefreshAt(Date.now());
      if (selectedConn && !list.some((item) => item.config?.conn_name === selectedConn)) {
        setSelectedConn(null);
      } else if (!selectedConn && list.length === 1 && list[0].config?.conn_name) {
        setSelectedConn(list[0].config.conn_name);
      }
    } catch (error) {
      setRefreshError(formatErrorText(error));
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [selectedConn]);

  const loadPoints = useCallback(async (connName: string) => {
    const requestId = pointLoadRequestRef.current + 1;
    pointLoadRequestRef.current = requestId;
    setPoints([]);
    setPointsLoading(true);
    try {
      const table = await api.modbusRtuGetPointTable(connName);
      if (requestId !== pointLoadRequestRef.current) {
        return;
      }
      setPoints(table.points);
    } catch (error) {
      if (requestId !== pointLoadRequestRef.current) {
        return;
      }
      setPoints([]);
      messageApi.error(`加载 ModbusRTU 点表失败: ${error}`);
    } finally {
      if (requestId === pointLoadRequestRef.current) {
        setPointsLoading(false);
      }
    }
  }, [messageApi]);

  const getLinkState = useCallback(async (connName: string): Promise<number | null> => {
    const link = await api.modbusRtuGetLink(connName);
    return link.state;
  }, []);

  const waitForLinkState = useCallback(async (connName: string, targetState: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        if (await getLinkState(connName) === targetState) {
          return true;
        }
      } catch {
        return false;
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 250);
      });
    }

    return false;
  }, [getLinkState]);

  const runSelectedLinkStopped = useCallback(
    async (
      operation: () => Promise<void>,
      options?: {
        initialState?: number | null;
        originalConnName?: string;
        restartConnName?: string;
        restartAfterRun?: boolean;
      },
    ) => {
      if (!selectedConn) {
        await operation();
        return {
          stoppedBeforeRun: false,
          restartedAfterRun: false,
          retriedAfterRunningPrecondition: false,
          restartError: null,
        };
      }

      const originalConnName = options?.originalConnName ?? selectedConn;
      const restartConnName = options?.restartConnName ?? originalConnName;
      const initialState = options?.initialState ?? selectedLink?.state ?? null;

      return runWithRuntimeRestart({
        initialState,
        loadState: () => getLinkState(originalConnName),
        stop: () => api.modbusRtuStopLink(originalConnName),
        run: operation,
        start: () => api.modbusRtuStartLink(restartConnName),
        restoreStart: () => api.modbusRtuStartLink(originalConnName),
        restartAfterRun: options?.restartAfterRun,
        failOnRestartError: false,
      });
    },
    [getLinkState, selectedConn, selectedLink?.state],
  );

  const openCreateLink = useCallback(() => {
    setEditingLink(null);
    linkForm.resetFields();
    linkForm.setFieldsValue({
      conn_name: '',
      transport_type: 2,
      device_id: 1,
      poll_interval_ms: 1000,
      address_base: 1,
      serial_device: '',
      baud_rate: 9600,
      data_bits: 8,
      parity: 1,
      stop_bits: 1,
      read_timeout_ms: 0,
      serial_port: 'RS485-1',
      request_timeout_ms: 3000,
      serial_byte_timeout_ms: 100,
      serial_frame_timeout_ms: 100,
      serial_est_size: 256,
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
    });
    setLinkModalOpen(true);
  }, [selectedLink, linkForm]);

  const handleLinkSubmit = useCallback(async () => {
    let renameCompleted = false;
    let values: LinkFormValues;
    try {
      values = await linkForm.validateFields();
    } catch {
      return;
    }

    setLinkSubmitting(true);
    try {
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

      const readPlan: ModbusReadPlan = editingLink?.read_plan
        ? {
          mode: editingLink.read_plan.mode,
          blocks: editingLink.read_plan.blocks.map((block) => ({ ...block })),
        }
        : { mode: 1, blocks: [] };

      const config: ModbusLinkConfig = {
        conn_name: String(values.conn_name).trim(),
        serial,
        device_id: values.device_id ?? 1,
        poll_interval_ms: values.poll_interval_ms ?? 1000,
        address_base: values.address_base ?? 1,
        read_plan: readPlan,
        transport_type: values.transport_type ?? 1,
        serial_port: values.serial_port || 'RS485-1',
        request_timeout_ms: values.request_timeout_ms ?? 3000,
        serial_byte_timeout_ms: values.serial_byte_timeout_ms ?? 100,
        serial_frame_timeout_ms: values.serial_frame_timeout_ms ?? 100,
        serial_est_size: values.serial_est_size ?? 256,
      };

      const createOnly = !editingLink;
      const oldConnName = editingLink?.conn_name ?? null;
      const renamed = !createOnly && oldConnName !== config.conn_name;

      const saveLink = async () => {
        if (renamed && oldConnName) {
          await api.modbusRtuRenameLink(oldConnName, config.conn_name);
          renameCompleted = true;
        }

        await api.modbusRtuUpsertLink(config, createOnly);
      };
      const restartResult = createOnly
        ? await runWithRuntimeRestart({
          initialState: null,
          stop: () => api.modbusRtuStopLink(config.conn_name),
          run: saveLink,
          start: () => api.modbusRtuStartLink(config.conn_name),
          failOnRestartError: false,
        })
        : await runSelectedLinkStopped(saveLink, {
          originalConnName: oldConnName ?? config.conn_name,
          restartConnName: config.conn_name,
        });
      if (restartResult.restartError) {
        messageApi.warning(`连接配置已保存，但重新启动失败: ${formatErrorText(restartResult.restartError)}`);
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success(renamed ? '连接已改名、更新并重新启动成功' : '连接已更新并重新启动成功');
      } else {
        messageApi.success(createOnly ? '连接创建成功' : renamed ? '连接已改名并更新成功' : '连接更新成功');
      }
      setLinkModalOpen(false);
      await refreshLinks();
      setSelectedConn(config.conn_name);
    } catch (error) {
      if (renameCompleted) {
        try {
          await refreshLinks();
        } catch {
          // Best-effort refresh after a partial rename success.
        }
        const connName = linkForm.getFieldValue('conn_name');
        if (typeof connName === 'string' && connName) {
          setSelectedConn(connName);
        }
        messageApi.error(`连接已改名，但保存其他配置失败: ${error}`);
        return;
      }
      messageApi.error(`保存连接失败: ${error}`);
    } finally {
      setLinkSubmitting(false);
    }
  }, [editingLink, linkForm, messageApi, refreshLinks, runSelectedLinkStopped]);

  const handleReadPlanSave = useCallback(async (readPlan: ModbusReadPlan): Promise<boolean> => {
    if (!selectedLink?.config || !selectedConn) {
      return false;
    }
    setReadPlanSaving(true);
    try {
      const config: ModbusLinkConfig = {
        ...selectedLink.config,
        read_plan: {
          mode: readPlan.mode,
          blocks: readPlan.blocks.map((block) => ({ ...block })),
        },
      };
      const restartResult = await runSelectedLinkStopped(
        () => api.modbusRtuUpsertLink(config, false).then(() => undefined),
      );
      await refreshLinks({ silent: true });
      if (restartResult.restartError) {
        messageApi.warning(`读取策略已应用，但重新启动失败: ${formatErrorText(restartResult.restartError)}`);
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success('读取策略已应用并重新启动连接');
      } else {
        messageApi.success('读取策略已应用');
      }
      return true;
    } catch (error) {
      messageApi.error(`应用读取策略失败: ${error}`);
      return false;
    } finally {
      setReadPlanSaving(false);
    }
  }, [messageApi, refreshLinks, runSelectedLinkStopped, selectedConn, selectedLink]);

  const handleDeleteLink = useCallback(async (connName: string) => {
    if (linkMutation !== null) {
      return;
    }
    if (links.find((link) => link.config?.conn_name === connName)?.state === 2) {
      messageApi.warning('请先停止轮询，再删除运行中的连接');
      return;
    }
    setLinkMutation('delete');
    try {
      await api.modbusRtuDeleteLink(connName);
      messageApi.success(`连接 ${connName} 已删除`);
      if (selectedConn === connName) {
        setSelectedConn(null);
      }
      await refreshLinks();
    } catch (error) {
      messageApi.error(`删除连接失败: ${error}`);
      await refreshLinks({ silent: true });
    } finally {
      setLinkMutation(null);
    }
  }, [linkMutation, links, messageApi, refreshLinks, selectedConn]);

  const handleCopyLink = useCallback(async (sourceConnName: string) => {
    if (linkMutation !== null) {
      return;
    }
    const sourceConfig = links.find((link) => link.config?.conn_name === sourceConnName)?.config;
    if (!sourceConfig) {
      messageApi.error(`未找到连接 ${sourceConnName} 的配置`);
      return;
    }

    const nextConnName = buildDuplicateConnectionName(
      sourceConfig.conn_name,
      links
        .map((link) => link.config?.conn_name)
        .filter((connName): connName is string => Boolean(connName)),
    );
    const copiedConfig: ModbusLinkConfig = {
      ...sourceConfig,
      conn_name: nextConnName,
      serial: sourceConfig.serial ? { ...sourceConfig.serial } : null,
      read_plan: sourceConfig.read_plan
        ? {
          ...sourceConfig.read_plan,
          blocks: sourceConfig.read_plan.blocks.map((block) => ({ ...block })),
        }
        : null,
    };

    setLinkMutation('copy');
    try {
      await api.modbusRtuUpsertLink(copiedConfig, true);

      let pointCopyError: unknown = null;
      try {
        const pointTable = await api.modbusRtuGetPointTable(sourceConnName);
        if (pointTable.points.length > 0) {
          await api.modbusRtuUpsertPointTable(
            nextConnName,
            pointTable.points.map((point) => ({ ...point })),
            true,
          );
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          pointCopyError = error;
        }
      }

      await refreshLinks();
      setSelectedConn(nextConnName);

      if (pointCopyError) {
        messageApi.error(`连接已复制为 ${nextConnName}，但复制点表失败: ${pointCopyError}`);
        return;
      }

      messageApi.success(`已复制连接为 ${nextConnName}`);
    } catch (error) {
      messageApi.error(`复制连接失败: ${error}`);
    } finally {
      setLinkMutation(null);
    }
  }, [linkMutation, links, messageApi, refreshLinks]);

  const handleStartLink = useCallback(async () => {
    if (!selectedConn || runtimeAction !== null || selectedLink?.state !== 1) {
      return;
    }
    const connName = selectedConn;
    setRuntimeAction('start');
    try {
      await api.modbusRtuStartLink(connName);
      const confirmed = await waitForLinkState(connName, 2);
      await refreshLinks({ silent: true });
      if (confirmed) {
        messageApi.success('连接已进入运行中');
      } else {
        messageApi.warning('启动请求已发送，但暂未确认连接进入运行中');
      }
    } catch (error) {
      messageApi.error(`启动失败: ${error}`);
    } finally {
      setRuntimeAction(null);
    }
  }, [messageApi, refreshLinks, runtimeAction, selectedConn, selectedLink?.state, waitForLinkState]);

  const handleStopLink = useCallback(async () => {
    if (!selectedConn || runtimeAction !== null || selectedLink?.state !== 2) {
      return;
    }
    const connName = selectedConn;
    setRuntimeAction('stop');
    try {
      await api.modbusRtuStopLink(connName);
      const confirmed = await waitForLinkState(connName, 1);
      await refreshLinks({ silent: true });
      if (confirmed) {
        messageApi.success('连接已停止');
      } else {
        messageApi.warning('停止请求已发送，但暂未确认连接进入已停止状态');
      }
    } catch (error) {
      messageApi.error(`停止失败: ${error}`);
    } finally {
      setRuntimeAction(null);
    }
  }, [messageApi, refreshLinks, runtimeAction, selectedConn, selectedLink?.state, waitForLinkState]);

  const openCreatePoint = useCallback(() => {
    setEditingPointIndex(null);
    pointForm.resetFields();
    pointForm.setFieldsValue({
      ...createDefaultModbusPoint(selectedLink?.config?.address_base ?? MODBUS_ADDRESS_BASE.ZERO),
      address_base: selectedLink?.config?.address_base ?? MODBUS_ADDRESS_BASE.ZERO,
    });
    setPointModalOpen(true);
  }, [pointForm, selectedLink?.config?.address_base]);

  const openEditPoint = useCallback((index: number) => {
    const point = points[index];
    setEditingPointIndex(index);
    pointForm.setFieldsValue({
      tag: point.tag,
      function: point.function as ModbusPointFormValues['function'],
      address: point.address,
      reg_count: point.reg_count,
      data_type: point.data_type as ModbusPointFormValues['data_type'],
      scale: point.scale,
      offset: point.offset,
      deadband: point.deadband,
      word_order: point.word_order,
      byte_order: point.byte_order,
      bit_index: point.bit_index ?? null,
      address_base: selectedLink?.config?.address_base ?? MODBUS_ADDRESS_BASE.ZERO,
    });
    setPointModalOpen(true);
  }, [pointForm, points, selectedLink?.config?.address_base]);

  const openCopyPoint = useCallback((index: number) => {
    const point = points[index];
    if (!point) {
      return;
    }

    setEditingPointIndex(null);
    pointForm.resetFields();
    pointForm.setFieldsValue({
      tag: point.tag,
      function: point.function as ModbusPointFormValues['function'],
      address: getNextDuplicatePointAddress(point, points),
      reg_count: point.reg_count,
      data_type: point.data_type as ModbusPointFormValues['data_type'],
      scale: point.scale,
      offset: point.offset,
      deadband: point.deadband,
      word_order: point.word_order,
      byte_order: point.byte_order,
      bit_index: point.bit_index ?? null,
      address_base: selectedLink?.config?.address_base ?? MODBUS_ADDRESS_BASE.ZERO,
    });
    setPointModalOpen(true);
  }, [pointForm, points, selectedLink?.config?.address_base]);

  useEffect(() => {
    if (!pointModalOpen || editingPointIndex !== null) {
      return;
    }
    const tag = pointForm.getFieldValue('tag');
    if (typeof tag === 'string' && tag.trim() && points.some((point) => point.tag.trim() === tag.trim())) {
      pointForm.setFields([{ name: 'tag', errors: ['Tag 已存在'] }]);
    }
  }, [editingPointIndex, pointForm, pointModalOpen, points]);

  const handlePointSubmit = useCallback(async () => {
    if (!selectedConn) {
      return;
    }
    let values: ModbusPointFormValues & { address_base: number };
    try {
      values = await pointForm.validateFields();
    } catch {
      return;
    }

    const allowedDataTypes = getAllowedDataTypes(values.function);
    const allowedRegCounts = values.function === MODBUS_FUNCTION.READ_COILS
      ? [1]
      : getAllowedRegCounts(values.data_type);
    if (!allowedDataTypes.includes(values.data_type) || !allowedRegCounts.includes(values.reg_count)) {
      messageApi.error('功能码、数据类型和寄存器数不匹配');
      return;
    }
    if (values.address < getMinimumAddress(values.address_base)) {
      messageApi.error('点位地址不符合当前地址基准');
      return;
    }
    if (values.address > 65535 || (values.reg_count > 1 && values.address >= 65535)) {
      messageApi.error('点位地址超出寄存器可用范围');
      return;
    }

    setPointSubmitting(true);
    try {
      const newPoint: ModbusPoint = {
        tag: values.tag.trim(),
        function: values.function,
        address: values.address,
        data_type: values.data_type,
        scale: values.scale ?? 1,
        offset: values.offset ?? 0,
        deadband: values.deadband ?? 0,
        reg_count: values.reg_count ?? getDefaultRegCount(values.data_type) ?? 1,
        word_order: values.word_order ?? 0,
        byte_order: values.byte_order ?? 0,
        bit_index: values.data_type === MODBUS_DATA_TYPE.BOOL
          && (values.function === MODBUS_FUNCTION.READ_HOLDING_REGISTERS || values.function === MODBUS_FUNCTION.READ_INPUT_REGISTERS)
          ? (values.bit_index ?? null)
          : null,
      };
      const newPoints = editingPointIndex !== null
        ? points.map((point, index) => (index === editingPointIndex ? newPoint : point))
        : [...points, newPoint];
      const restartResult = await runSelectedLinkStopped(() => api.modbusRtuUpsertPointTable(selectedConn, newPoints, true));
      setPoints(newPoints);
      setPointModalOpen(false);
      messageApi.success(editingPointIndex !== null ? '点位已更新' : '点位已添加');
      if (restartResult.restartError) {
        messageApi.warning(`点表已保存，但重新启动失败: ${formatErrorText(restartResult.restartError)}`);
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success('点表已保存并重新启动连接');
      }
    } catch (error) {
      messageApi.error(`保存点位失败: ${error}`);
    } finally {
      setPointSubmitting(false);
    }
  }, [editingPointIndex, messageApi, pointForm, points, runSelectedLinkStopped, selectedConn]);

  const handleDeletePoint = useCallback(async (index: number) => {
    if (!selectedConn || pointSubmitting) {
      return;
    }
    setPointSubmitting(true);
    try {
      const newPoints = points.filter((_point, pointIndex) => pointIndex !== index);
      const restartResult = await runSelectedLinkStopped(() => api.modbusRtuUpsertPointTable(selectedConn, newPoints, true));
      setPoints(newPoints);
      messageApi.success('点位已删除');
      if (restartResult.restartError) {
        messageApi.warning(`点表已保存，但重新启动失败: ${formatErrorText(restartResult.restartError)}`);
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success('点表已保存并重新启动连接');
      }
    } catch (error) {
      messageApi.error(`删除点位失败: ${error}`);
    } finally {
      setPointSubmitting(false);
    }
  }, [messageApi, pointSubmitting, points, selectedConn, runSelectedLinkStopped]);

  const handleDeleteAllPoints = useCallback(async () => {
    if (!selectedConn || pointSubmitting) {
      return;
    }
    setPointSubmitting(true);
    try {
      const restartResult = await runSelectedLinkStopped(
        () => api.modbusRtuUpsertPointTable(selectedConn, [], true),
        { restartAfterRun: false },
      );
      setPoints([]);
      messageApi.success(restartResult.stoppedBeforeRun ? '全部点位已删除，连接保持停止' : '全部点位已删除');
    } catch (error) {
      messageApi.error(`删除全部点位失败: ${error}`);
    } finally {
      setPointSubmitting(false);
    }
  }, [messageApi, pointSubmitting, selectedConn, runSelectedLinkStopped]);

  const handleReadPlanDirtyChange = useCallback((dirty: boolean) => {
    readPlanDirtyRef.current = dirty;
  }, []);

  const selectConnection = useCallback((connName: string) => {
    if (actionsDisabled || connName === selectedConn) {
      return;
    }

    if (readPlanDirtyRef.current) {
      Modal.confirm({
        title: '放弃未保存的读取方案？',
        content: '切换连接会丢弃当前连接尚未应用的读取区间修改。',
        okText: '放弃并切换',
        cancelText: '继续编辑',
        onOk: () => {
          readPlanDirtyRef.current = false;
          setSelectedConn(connName);
        },
      });
      return;
    }

    setSelectedConn(connName);
  }, [actionsDisabled, selectedConn]);

  useEffect(() => {
    void refreshLinks();
    const refreshTimer = window.setInterval(() => {
      void refreshLinks({ silent: true });
    }, 5000);
    return () => window.clearInterval(refreshTimer);
  }, [refreshLinks]);

  useEffect(() => {
    if (selectedConn) {
      void loadPoints(selectedConn);
    } else {
      pointLoadRequestRef.current += 1;
      setPoints([]);
      setPointsLoading(false);
    }
  }, [selectedConn, loadPoints]);

  const renderLinkModal = (): React.ReactNode => (
    <Modal
      title={editingLink ? '编辑连接' : '新增连接'}
      open={linkModalOpen}
      onCancel={() => setLinkModalOpen(false)}
      onOk={() => void handleLinkSubmit()}
      okText={editingLink ? '保存修改' : '创建连接'}
      cancelText="取消"
      confirmLoading={linkSubmitting}
      maskClosable={!linkSubmitting}
      closable={!linkSubmitting}
      width={840}
      className="modbus-config-modal"
      destroyOnClose
    >
      <Form form={linkForm} layout="vertical" autoComplete="off">
        <div className="modbus-form-section">
          <Text className="modbus-form-section-title">基础信息</Text>
          <Row gutter={16}>
            <Col xs={24} sm={12} lg={8}>
              <Form.Item
                label="连接名称"
                name="conn_name"
                rules={[
                  { required: true, message: '请输入连接名称' },
                  { max: 64, message: '连接名称不能超过 64 个字符' },
                  {
                    validator: async (_, value: string) => {
                      const name = value?.trim();
                      if (!name) {
                        throw new Error('连接名称不能只包含空格');
                      }
                      if (links.some((item) => item.config?.conn_name?.trim() === name && item.config?.conn_name !== editingLink?.conn_name)) {
                        throw new Error('连接名称已存在');
                      }
                    },
                  },
                ]}
              >
                <Input autoComplete="off" placeholder="例如：电表-1" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={8}>
              <Form.Item label="传输方式" name="transport_type" rules={[{ required: true, message: '请选择传输方式' }]}>
                <Select options={TRANSPORT_TYPE_OPTIONS} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={8}>
              <Form.Item
                label="从站地址（1-247）"
                name="device_id"
                rules={[{ required: true, message: '请输入 1 到 247 的从站地址' }]}
              >
                <InputNumber min={1} max={247} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </div>

        <div className="modbus-form-section">
          <Text className="modbus-form-section-title">串口通信参数</Text>
          <Text className="modbus-form-section-hint">
            MQTT 透传模式下，这些参数表示远端 uartManager 的串口配置。
          </Text>
          <Row gutter={16}>
            <Col xs={24} sm={12} lg={8}>
              <Form.Item
                label={transportType === 2 ? '远端串口标识' : '本地串口设备'}
                name={transportType === 2 ? 'serial_port' : 'serial_device'}
                rules={[{ required: true, message: transportType === 2 ? '请输入远端串口标识' : '请输入本地串口设备' }]}
              >
                {transportType === 2 ? <Input placeholder="例如：RS485-1" /> : <Input placeholder="例如：/dev/ttyUSB0" />}
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={8}>
              <Form.Item label="波特率" name="baud_rate" rules={[{ required: true, message: '请输入波特率' }]}>
                <InputNumber min={1} precision={0} style={{ width: '100%' }} placeholder="9600" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={8}>
              <Form.Item label="数据位" name="data_bits" rules={[{ required: true, message: '请选择数据位' }]}>
                <InputNumber min={5} max={8} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={8}>
              <Form.Item label="校验位" name="parity" rules={[{ required: true, message: '请选择校验位' }]}>
                <Select options={PARITY_OPTIONS} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={8}>
              <Form.Item label="停止位" name="stop_bits" rules={[{ required: true, message: '请选择停止位' }]}>
                <Select options={STOP_BITS_OPTIONS} />
              </Form.Item>
            </Col>
            {transportType === 1 ? (
              <Col xs={24} sm={12} lg={8}>
                <Form.Item label="读取超时（毫秒）" name="read_timeout_ms">
                  <InputNumber min={0} precision={0} style={{ width: '100%' }} addonAfter="ms" />
                </Form.Item>
              </Col>
            ) : null}
          </Row>
        </div>

        {transportType === 2 ? (
          <div className="modbus-form-section">
            <Text className="modbus-form-section-title">透传超时参数</Text>
            <Text className="modbus-form-section-hint">填 0 表示使用模块默认值。</Text>
            <Row gutter={16}>
              <Col xs={24} sm={12} lg={8}>
                <Form.Item label="请求超时（毫秒）" name="request_timeout_ms" rules={[{ required: true, message: '请输入请求超时' }]}>
                  <InputNumber min={0} precision={0} style={{ width: '100%' }} addonAfter="ms" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} lg={8}>
                <Form.Item label="字节超时（毫秒）" name="serial_byte_timeout_ms" rules={[{ required: true, message: '请输入字节超时' }]}>
                  <InputNumber min={0} precision={0} style={{ width: '100%' }} addonAfter="ms" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} lg={8}>
                <Form.Item label="帧超时（毫秒）" name="serial_frame_timeout_ms" rules={[{ required: true, message: '请输入帧超时' }]}>
                  <InputNumber min={0} precision={0} style={{ width: '100%' }} addonAfter="ms" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} lg={8}>
                <Form.Item label="预计最大响应字节数" name="serial_est_size" rules={[{ required: true, message: '请输入预计最大响应字节数' }]}>
                  <InputNumber min={1} precision={0} style={{ width: '100%' }} addonAfter="字节" />
                </Form.Item>
              </Col>
            </Row>
          </div>
        ) : null}

        <div className="modbus-form-section">
          <Text className="modbus-form-section-title">采集基础参数</Text>
          <Row gutter={16}>
            <Col xs={24} sm={12} lg={8}>
              <Form.Item label="轮询周期（毫秒）" name="poll_interval_ms" rules={[{ required: true, message: '请输入轮询周期' }]}>
                <InputNumber min={1} precision={0} style={{ width: '100%' }} addonAfter="ms" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={8}>
              <Form.Item
                label="地址基准"
                name="address_base"
                extra={editingLink && points.length > 0
                  ? '已有点位时不能直接切换地址基准；请先完成点位迁移后再修改。'
                  : undefined}
                rules={[{ required: true, message: '请选择地址基准' }]}
              >
                <Select disabled={Boolean(editingLink && points.length > 0)} options={ADDRESS_BASE_OPTIONS} />
              </Form.Item>
            </Col>
          </Row>
        </div>

      </Form>
    </Modal>
  );

  const renderPointModal = (): React.ReactNode => (
    <Modal
      title={editingPointIndex !== null ? '编辑点位' : '新增点位'}
      open={pointModalOpen}
      onCancel={() => setPointModalOpen(false)}
      onOk={() => void handlePointSubmit()}
      okText={editingPointIndex !== null ? '保存修改' : '添加点位'}
      cancelText="取消"
      confirmLoading={pointSubmitting}
      maskClosable={!pointSubmitting}
      closable={!pointSubmitting}
      width={720}
      className="modbus-config-modal"
      destroyOnClose
    >
      <Form form={pointForm} layout="vertical">
        <Form.Item name="address_base" hidden>
          <InputNumber />
        </Form.Item>
        <Row gutter={16}>
          <Col xs={24} sm={12} lg={8}>
            <Form.Item
              label="Tag"
              name="tag"
              validateStatus={pointTagDuplicate ? 'error' : undefined}
              help={pointTagDuplicate ? 'Tag 已存在' : undefined}
              rules={[
                { required: true, message: '请输入 Tag' },
                { max: 128, message: 'Tag 不能超过 128 个字符' },
                {
                  validator: async (_, value: string) => {
                    const tag = value?.trim();
                    if (!tag) {
                      throw new Error('Tag 不能只包含空格');
                    }
                    if (points.some((point, index) => point.tag.trim() === tag && index !== editingPointIndex)) {
                      throw new Error('Tag 已存在');
                    }
                  },
                },
              ]}
            >
              <Input placeholder="例如：active_power" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} lg={8}>
            <Form.Item label="功能码" name="function" rules={[{ required: true, message: '请选择功能码' }]}>
              <Select
                options={ALL_FUNCTION_CODE_OPTIONS}
                onChange={(value: number) => {
                  const allowedTypes = getAllowedDataTypes(value);
                  const currentType = pointForm.getFieldValue('data_type');
                  const nextType = allowedTypes.includes(currentType) ? currentType : allowedTypes[0];
                  const registerBool = nextType === MODBUS_DATA_TYPE.BOOL
                    && (value === MODBUS_FUNCTION.READ_HOLDING_REGISTERS || value === MODBUS_FUNCTION.READ_INPUT_REGISTERS);
                  pointForm.setFieldsValue({
                    data_type: nextType,
                    reg_count: value === MODBUS_FUNCTION.READ_COILS
                      ? 1
                      : (getDefaultRegCount(nextType) ?? 1),
                    bit_index: registerBool ? (pointForm.getFieldValue('bit_index') ?? 0) : null,
                  });
                }}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} lg={8}>
            <Form.Item
              label={`地址（${pointAddressBase === MODBUS_ADDRESS_BASE.ONE ? '1 基' : '0 基'}）`}
              name="address"
              rules={[{ required: true, message: '请输入地址' }]}
            >
              <InputNumber
                min={getMinimumAddress(pointAddressBase)}
                max={65535}
                precision={0}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} sm={12} lg={8}>
            <Form.Item label="数据类型" name="data_type" rules={[{ required: true, message: '请选择数据类型' }]}>
              <Select
                options={pointDataTypeOptions}
                onChange={(value: number) => {
                  const registerBool = value === MODBUS_DATA_TYPE.BOOL
                    && (pointFunction === MODBUS_FUNCTION.READ_HOLDING_REGISTERS || pointFunction === MODBUS_FUNCTION.READ_INPUT_REGISTERS);
                  pointForm.setFieldsValue({
                    reg_count: pointFunction === MODBUS_FUNCTION.READ_COILS
                      ? 1
                      : (getDefaultRegCount(value) ?? 1),
                    bit_index: registerBool ? 0 : null,
                  });
                }}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} lg={8}>
            <Form.Item label="寄存器数" name="reg_count" rules={[{ required: true, message: '请选择寄存器数' }]}>
              <Select options={pointRegCountOptions} />
            </Form.Item>
          </Col>
          {isRegisterBoolPoint ? (
            <Col xs={24} sm={12} lg={8}>
              <Form.Item
                label="位索引"
                name="bit_index"
                rules={[{ required: true, message: '请输入位索引' }]}
              >
                <InputNumber min={0} max={pointBitMax} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          ) : null}
        </Row>
        {pointDataType !== MODBUS_DATA_TYPE.BOOL ? (
          <div className="modbus-form-section">
            <Text className="modbus-form-section-title">工程量换算</Text>
            <Row gutter={16}>
              <Col xs={24} sm={12} lg={8}>
                <Form.Item label="缩放系数" name="scale">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} lg={8}>
                <Form.Item label="偏移量" name="offset">
                  <InputNumber step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              {pointFunction !== MODBUS_FUNCTION.WRITE_SINGLE_REGISTER
                && pointFunction !== MODBUS_FUNCTION.WRITE_MULTIPLE_REGISTERS ? (
                  <Col xs={24} sm={12} lg={8}>
                    <Form.Item label="死区" name="deadband">
                      <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                ) : null}
              {(pointDataType === MODBUS_DATA_TYPE.UINT32 || pointDataType === MODBUS_DATA_TYPE.INT32) ? (
                <Col xs={24} sm={12} lg={8}>
                  <Form.Item label="字序" name="word_order">
                    <Select options={WORD_ORDER_OPTIONS} />
                  </Form.Item>
                </Col>
              ) : null}
              <Col xs={24} sm={12} lg={8}>
                <Form.Item label="字节序" name="byte_order">
                  <Select options={BYTE_ORDER_OPTIONS} />
                </Form.Item>
              </Col>
            </Row>
          </div>
        ) : null}
      </Form>
    </Modal>
  );

  return (
    <div className="protocol-page modbus-page">
      {contextHolder}

      {refreshError ? (
        <Alert
          className="modbus-page-alert"
          type="warning"
          showIcon
          message="连接列表刷新失败"
          description={`${refreshError}${lastRefreshAt ? `；上次成功刷新于 ${new Date(lastRefreshAt).toLocaleTimeString()}` : ''}`}
          action={(
            <Button size="small" onClick={() => void refreshLinks()}>
              重试
            </Button>
          )}
        />
      ) : null}
      {realtimeError ? (
        <Alert
          className="modbus-page-alert"
          type="warning"
          showIcon
          message="实时数据暂不可用"
          description={`点表配置仍可继续；实时数据流错误：${realtimeError}`}
        />
      ) : null}

      {currentView === 'config' ? (
        <ResizableSplit
          className="protocol-config-view"
          orientation="vertical"
          defaultSize={360}
          minSize={240}
          maxSize={620}
          storageKey="mskdsp.layout.modbus-rtu.config"
        >
          <ResizableSplit
            className="protocol-top-row"
            defaultSize={240}
            minSize={200}
            maxSize={420}
            storageKey="mskdsp.layout.modbus-rtu.connection"
          >
            <ProtocolConnectionList
              title={'\u8fde\u63a5\u5217\u8868'}
              addButtonText={'\u65b0\u589e\u8fde\u63a5'}
              width="100%"
              links={links}
              selectedConn={selectedConn}
              loading={loading}
              actionsDisabled={actionsDisabled}
              getItemActionsDisabled={(item) => item.state === 3}
              onSelect={selectConnection}
              onCreate={openCreateLink}
              onCopy={(connName) => void handleCopyLink(connName)}
              onDelete={(connName) => void handleDeleteLink(connName)}
              onRefresh={() => void refreshLinks()}
              getStateColor={(item) => LIST_STATE_COLOR_MAP[item.state] ?? '#8c8c8c'}
              getDescription={(item) => {
                const config = item.config;
                if (!config) {
                  return LINK_STATE_LABELS[item.state] ?? '状态未知';
                }
                const transport = config.transport_type === 2 ? 'MQTT 透传' : '本地串口';
                return `${LINK_STATE_LABELS[item.state] ?? '状态未知'} · ${transport} · 从站 ${config.device_id}`;
              }}
              getDeleteTitle={(connName) => `\u786e\u8ba4\u5220\u9664 ${connName}\uff1f`}
            />

            <div className="modbus-connection-shell">
              <ConnectionConfig
                link={selectedLink}
                pointCount={points.length}
                busy={actionsDisabled}
                runtimeAction={runtimeAction}
                globalAction={<MqttConfigPanel />}
                onEdit={openEditLink}
                onStart={() => void handleStartLink()}
                onStop={() => void handleStopLink()}
              />
            </div>
          </ResizableSplit>

          <PointTable
            key={selectedConn ?? 'no-connection'}
            points={points}
            selectedConn={selectedConn}
            realtimeByTag={realtimeByTag}
            realtimeRevisionByTag={realtimeRevisionByTag}
            realtimeLoading={realtimeLoading}
            pointsLoading={pointsLoading}
            actionsDisabled={actionsDisabled}
            readPlan={selectedLink?.config?.read_plan ?? { mode: 1, blocks: [] }}
            addressBase={selectedLink?.config?.address_base ?? MODBUS_ADDRESS_BASE.ZERO}
            readPlanSaving={readPlanSaving}
            runtimeRunning={selectedLink?.state === 2}
            onReadPlanSave={handleReadPlanSave}
            onReadPlanDirtyChange={handleReadPlanDirtyChange}
            onAdd={openCreatePoint}
            onEdit={(index) => openEditPoint(index)}
            onCopy={(index) => openCopyPoint(index)}
            onDelete={(index) => void handleDeletePoint(index)}
            onDeleteAll={() => void handleDeleteAllPoints()}
          />
        </ResizableSplit>
      ) : (
        <Card title="报文日志" size="small" bordered className="protocol-log-card">
          <div className="protocol-log-scroll">
            <div className="protocol-log-console">
              <div>
                <span style={{ color: '#007acc' }}>[TX]</span>
                {' '}
                --:--:--.--- - 报文日志 — 接入实时数据后渲染
              </div>
              <div className="protocol-log-line--hint">等待链路启动后显示报文收发记录...</div>
            </div>
          </div>
        </Card>
      )}

      {renderLinkModal()}
      {renderPointModal()}
    </div>
  );
};

export default ModbusRTU;
