import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Form, Input, InputNumber, message, Modal, Row, Select, Typography } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../adapters';
import type { ModbusPoint, ModbusTcpLinkConfig, ModbusTcpLinkInfo } from '../../adapters';
import ResizableSplit from '../../components/layout/ResizableSplit';
import ProtocolConnectionList from '../../components/protocol/ProtocolConnectionList';
import { normalizeProtocolView, PROTOCOL_VIEW_QUERY_KEY } from '../../components/protocol/protocol-view';
import { useProtocolRealtime } from '../../components/protocol/protocol-realtime';
import { buildDuplicateConnectionName, isNotFoundError } from '../../utils/connection-copy';
import {
  getDecimalTextError,
  toDecimalInputText,
} from '../../utils/decimal-input';
import {
  formatErrorText,
  runWithRuntimeRestart,
  type RuntimeOperationResult,
} from '../../utils/runtime-restart';
import PointTable from '../ModbusRTU/components/PointTable';
import {
  MODBUS_ADDRESS_BASE,
  MODBUS_DATA_TYPE,
  MODBUS_FUNCTION,
  createDefaultModbusPoint,
  getAllowedDataTypes,
  getAllowedRegCountsForFunction,
  getDefaultRegCount,
  getMinimumAddress,
  getNextDuplicatePointAddress,
} from '../ModbusRTU/modbus-form-rules';
import type { ModbusPointFormValues } from '../ModbusRTU/modbus-form-rules';
import {
  createModbusEngineeringFields,
  normalizeModbusPointEngineeringFields,
  resolveModbusPointDecimalText,
} from '../ModbusRTU/modbus-decimal';
import ConnectionConfig from './components/ConnectionConfig';

const { Text } = Typography;

const PROTOCOL_META = { moduleName: 'ModbusTCP', label: 'Modbus TCP' } as const;
const ADDRESS_BASE_OPTIONS = [
  { value: 1, label: '0 基（协议偏移）' },
  { value: 2, label: '1 基（人类编号）' },
];
const ALL_FUNCTION_CODE_OPTIONS = [
  { value: 1, label: '0x01 读线圈' },
  { value: 2, label: '0x03 读保持寄存器' },
  { value: 3, label: '0x04 读输入寄存器' },
  { value: 4, label: '0x06 写单寄存器' },
  { value: 5, label: '0x10 写多寄存器' },
  { value: 6, label: '0x05 写单线圈' },
];
const LIST_STATE_COLOR_MAP: Record<number, string> = {
  0: '#8c8c8c',
  1: '#f44336',
  2: '#4caf50',
  3: '#ff9800',
};
const LINK_STATE_LABELS: Record<number, string> = {
  0: '状态未知',
  1: '已停止',
  2: '运行中',
  3: '待删除',
};

const validateEngineeringDecimal = (
  label: string,
) => async (_rule: unknown, value: unknown): Promise<void> => {
  const text = toDecimalInputText(value);
  const error = getDecimalTextError(text, label);
  if (error) throw new Error(error);
};
const MODBUS_DATA_TYPE_LABELS: Record<number, string> = {
  1: 'BOOL',
  2: 'UINT16',
  3: 'UINT32',
  4: 'INT16',
  5: 'INT32',
};
const WORD_ORDER_OPTIONS = [
  { value: 0, label: '默认（HL）' },
  { value: 1, label: 'HL' },
  { value: 2, label: 'LH' },
];
const BYTE_ORDER_OPTIONS = [
  { value: 0, label: '默认（AB）' },
  { value: 1, label: 'AB' },
  { value: 2, label: 'BA' },
];

interface LinkFormValues {
  conn_name: string;
  host: string;
  port: number;
  unit_id: number;
  connect_timeout_ms: number;
  request_timeout_ms: number;
  poll_interval_ms: number;
  address_base: number;
}

const ModbusTCP: React.FC = () => {
  const [links, setLinks] = useState<ModbusTcpLinkInfo[]>([]);
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [points, setPoints] = useState<ModbusPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [pointsLoading, setPointsLoading] = useState(false);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<ModbusTcpLinkConfig | null>(null);
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [pointModalOpen, setPointModalOpen] = useState(false);
  const [editingPointIndex, setEditingPointIndex] = useState<number | null>(null);
  const [pointSubmitting, setPointSubmitting] = useState(false);
  const [runtimeAction, setRuntimeAction] = useState<'start' | 'stop' | null>(null);
  const [linkMutation, setLinkMutation] = useState<'copy' | 'delete' | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const [linkForm] = Form.useForm<LinkFormValues>();
  const [pointForm] = Form.useForm<ModbusPointFormValues & { address_base: number }>();
  const [searchParams] = useSearchParams();
  const pointLoadRequestRef = useRef(0);

  const selectedLink = links.find((link) => link.config?.conn_name === selectedConn) ?? null;
  const currentView = normalizeProtocolView(searchParams.get(PROTOCOL_VIEW_QUERY_KEY));
  const realtimeTags = useMemo(() => points.map((point) => point.tag), [points]);
  const {
    realtimeByTag,
    realtimeRevisionByTag,
    loading: realtimeLoading,
    error: realtimeError,
  } = useProtocolRealtime(selectedLink?.conn_id ?? null, realtimeTags);

  const pointFunction = Form.useWatch('function', pointForm);
  const pointTag = Form.useWatch('tag', pointForm);
  const pointDataType = Form.useWatch('data_type', pointForm);
  const pointRegCount = Form.useWatch('reg_count', pointForm);
  const pointAddressBase = Form.useWatch('address_base', pointForm);
  const isRegisterBoolPoint = pointDataType === MODBUS_DATA_TYPE.BOOL
    && (pointFunction === MODBUS_FUNCTION.READ_HOLDING_REGISTERS
      || pointFunction === MODBUS_FUNCTION.READ_INPUT_REGISTERS);
  const pointDataTypeOptions = getAllowedDataTypes(
    pointFunction ?? MODBUS_FUNCTION.READ_HOLDING_REGISTERS,
  ).map((value) => ({ value, label: MODBUS_DATA_TYPE_LABELS[value] }));
  const pointRegCountOptions = getAllowedRegCountsForFunction(
    pointFunction ?? MODBUS_FUNCTION.READ_HOLDING_REGISTERS,
    pointDataType ?? MODBUS_DATA_TYPE.UINT16,
  ).map((value) => ({ value, label: `${value} 个寄存器` }));
  const pointBitMax = (pointRegCount ?? 1) * 16 - 1;
  const pointTagTrimmed = typeof pointTag === 'string' ? pointTag.trim() : '';
  const pointTagDuplicate = pointTagTrimmed.length > 0 && points.some(
    (point, index) => index !== editingPointIndex && point.tag.trim() === pointTagTrimmed,
  );
  const actionsDisabled = pointsLoading
    || pointSubmitting
    || linkSubmitting
    || runtimeAction !== null
    || linkMutation !== null
    || linkModalOpen
    || pointModalOpen;

  const refreshLinks = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const list = (await api.modbusTcpListLinks()).sort((left, right) => {
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
      const table = await api.modbusTcpGetPointTable(connName);
      if (requestId === pointLoadRequestRef.current) {
        setPoints(table.points.map(normalizeModbusPointEngineeringFields));
      }
    } catch (error) {
      if (requestId === pointLoadRequestRef.current) {
        setPoints([]);
        messageApi.error(`加载 ModbusTCP 点表失败: ${error}`);
      }
    } finally {
      if (requestId === pointLoadRequestRef.current) {
        setPointsLoading(false);
      }
    }
  }, [messageApi]);

  const getLinkState = useCallback(async (connName: string): Promise<number | null> => {
    const link = await api.modbusTcpGetLink(connName);
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
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
    }
    return false;
  }, [getLinkState]);

  const runSelectedLinkStopped = useCallback(async (
    operation: () => Promise<void>,
    options?: { originalConnName?: string; restartConnName?: string; restartAfterRun?: boolean },
  ): Promise<RuntimeOperationResult> => {
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
    return runWithRuntimeRestart({
      initialState: selectedLink?.state ?? null,
      loadState: () => getLinkState(originalConnName),
      stop: () => api.modbusTcpStopLink(originalConnName),
      run: operation,
      start: () => api.modbusTcpStartLink(restartConnName),
      restoreStart: () => api.modbusTcpStartLink(originalConnName),
      restartAfterRun: options?.restartAfterRun,
      failOnRestartError: false,
    });
  }, [getLinkState, selectedConn, selectedLink?.state]);

  const savePointTablePreservingRuntime = useCallback(async (
    nextPoints: ModbusPoint[],
    restartAfterRun = true,
  ): Promise<RuntimeOperationResult> => {
    if (!selectedConn) {
      return {
        stoppedBeforeRun: false,
        restartedAfterRun: false,
        retriedAfterRunningPrecondition: false,
        restartError: null,
      };
    }
    const originallyRunning = selectedLink?.state === 2;
    const result = await runSelectedLinkStopped(
      () => api.modbusTcpUpsertPointTable(selectedConn, nextPoints, true),
      { restartAfterRun: originallyRunning && restartAfterRun && nextPoints.length > 0 },
    );

    if (!originallyRunning) {
      try {
        if (await getLinkState(selectedConn) === 2) {
          await api.modbusTcpStopLink(selectedConn);
        }
      } catch (error) {
        messageApi.warning(`点表已保存，但恢复停止状态失败: ${formatErrorText(error)}`);
      }
    }
    return result;
  }, [getLinkState, messageApi, runSelectedLinkStopped, selectedConn, selectedLink?.state]);

  const openCreateLink = useCallback(() => {
    setEditingLink(null);
    linkForm.resetFields();
    linkForm.setFieldsValue({
      conn_name: '',
      host: '',
      port: 502,
      unit_id: 1,
      connect_timeout_ms: 3000,
      request_timeout_ms: 3000,
      poll_interval_ms: 1000,
      address_base: MODBUS_ADDRESS_BASE.ZERO,
    });
    setLinkModalOpen(true);
  }, [linkForm]);

  const openEditLink = useCallback(() => {
    if (!selectedLink?.config) {
      return;
    }
    const config = selectedLink.config;
    setEditingLink(config);
    linkForm.setFieldsValue({
      conn_name: config.conn_name,
      host: config.tcp?.host ?? '',
      port: config.tcp?.port ?? 502,
      unit_id: config.tcp?.unit_id ?? 1,
      connect_timeout_ms: config.tcp?.connect_timeout_ms ?? 3000,
      request_timeout_ms: config.tcp?.request_timeout_ms ?? 3000,
      poll_interval_ms: config.poll_interval_ms || 1000,
      address_base: config.address_base || MODBUS_ADDRESS_BASE.ZERO,
    });
    setLinkModalOpen(true);
  }, [linkForm, selectedLink]);

  const handleLinkSubmit = useCallback(async () => {
    let values: LinkFormValues;
    try {
      values = await linkForm.validateFields();
    } catch {
      return;
    }

    const config: ModbusTcpLinkConfig = {
      conn_name: values.conn_name.trim(),
      tcp: {
        host: values.host.trim(),
        port: values.port,
        unit_id: values.unit_id,
        connect_timeout_ms: values.connect_timeout_ms,
        request_timeout_ms: values.request_timeout_ms,
      },
      poll_interval_ms: values.poll_interval_ms,
      address_base: values.address_base,
      read_plan: editingLink?.read_plan
        ? {
          mode: editingLink.read_plan.mode,
          blocks: editingLink.read_plan.blocks.map((block) => ({ ...block })),
        }
        : { mode: 1, blocks: [] },
    };
    const createOnly = editingLink === null;
    const oldConnName = editingLink?.conn_name ?? config.conn_name;
    const renamed = !createOnly && oldConnName !== config.conn_name;
    let renameCompleted = false;

    setLinkSubmitting(true);
    try {
      const save = async () => {
        if (renamed) {
          await api.modbusTcpRenameLink(oldConnName, config.conn_name);
          renameCompleted = true;
        }
        await api.modbusTcpUpsertLink(config, createOnly);
      };
      const result = createOnly
        ? await runWithRuntimeRestart({
          initialState: null,
          stop: () => api.modbusTcpStopLink(config.conn_name),
          run: save,
          start: () => api.modbusTcpStartLink(config.conn_name),
          failOnRestartError: false,
        })
        : await runSelectedLinkStopped(save, {
          originalConnName: oldConnName,
          restartConnName: config.conn_name,
        });
      setLinkModalOpen(false);
      await refreshLinks();
      setSelectedConn(config.conn_name);
      if (result.restartError) {
        messageApi.warning(`连接配置已保存，但重新启动失败: ${formatErrorText(result.restartError)}`);
      } else {
        messageApi.success(createOnly ? '连接创建成功' : renamed ? '连接已改名并更新成功' : '连接更新成功');
      }
    } catch (error) {
      if (renameCompleted) {
        setSelectedConn(config.conn_name);
        await refreshLinks({ silent: true });
        messageApi.error(`连接已改名，但保存其他配置失败: ${error}`);
      } else {
        messageApi.error(`保存连接失败: ${error}`);
      }
    } finally {
      setLinkSubmitting(false);
    }
  }, [editingLink, linkForm, messageApi, refreshLinks, runSelectedLinkStopped]);

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
      await api.modbusTcpDeleteLink(connName);
      if (selectedConn === connName) {
        setSelectedConn(null);
      }
      await refreshLinks();
      messageApi.success(`连接 ${connName} 已删除`);
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
      sourceConnName,
      links.map((link) => link.config?.conn_name).filter((name): name is string => Boolean(name)),
    );
    const copiedConfig: ModbusTcpLinkConfig = {
      ...sourceConfig,
      conn_name: nextConnName,
      tcp: sourceConfig.tcp ? { ...sourceConfig.tcp } : null,
      read_plan: sourceConfig.read_plan
        ? {
          mode: sourceConfig.read_plan.mode,
          blocks: sourceConfig.read_plan.blocks.map((block) => ({ ...block })),
        }
        : { mode: 1, blocks: [] },
    };

    setLinkMutation('copy');
    try {
      await api.modbusTcpUpsertLink(copiedConfig, true);
      let pointCopyError: unknown = null;
      try {
        const table = await api.modbusTcpGetPointTable(sourceConnName);
        if (table.points.length > 0) {
          await api.modbusTcpUpsertPointTable(
            nextConnName,
            table.points.map(normalizeModbusPointEngineeringFields),
            true,
          );
          await api.modbusTcpStopLink(nextConnName);
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
      } else {
        messageApi.success(`已复制连接为 ${nextConnName}`);
      }
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
    setRuntimeAction('start');
    try {
      await api.modbusTcpStartLink(selectedConn);
      const confirmed = await waitForLinkState(selectedConn, 2);
      await refreshLinks({ silent: true });
      if (confirmed) {
        messageApi.success('TCP 连接已进入运行中');
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
    setRuntimeAction('stop');
    try {
      await api.modbusTcpStopLink(selectedConn);
      const confirmed = await waitForLinkState(selectedConn, 1);
      await refreshLinks({ silent: true });
      if (confirmed) {
        messageApi.success('TCP 连接已停止');
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
      ...point,
      function: point.function as ModbusPointFormValues['function'],
      data_type: point.data_type as ModbusPointFormValues['data_type'],
      scale: resolveModbusPointDecimalText(point, 'scale'),
      offset: resolveModbusPointDecimalText(point, 'offset'),
      deadband: resolveModbusPointDecimalText(point, 'deadband'),
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
      ...point,
      function: point.function as ModbusPointFormValues['function'],
      data_type: point.data_type as ModbusPointFormValues['data_type'],
      address: getNextDuplicatePointAddress(point, points),
      scale: resolveModbusPointDecimalText(point, 'scale'),
      offset: resolveModbusPointDecimalText(point, 'offset'),
      deadband: resolveModbusPointDecimalText(point, 'deadband'),
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
    if (!getAllowedDataTypes(values.function).includes(values.data_type)
      || !getAllowedRegCountsForFunction(values.function, values.data_type).includes(values.reg_count)) {
      messageApi.error('功能码、数据类型和寄存器数不匹配');
      return;
    }
    if (values.address < getMinimumAddress(values.address_base)
      || values.address > 65535
      || (values.reg_count > 1 && values.address >= 65535)) {
      messageApi.error('点位地址超出当前地址基准的可用范围');
      return;
    }

    const nextPoint: ModbusPoint = {
      tag: values.tag.trim(),
      function: values.function,
      address: values.address,
      data_type: values.data_type,
      ...createModbusEngineeringFields({
        scale: toDecimalInputText(values.scale) || '1',
        offset: toDecimalInputText(values.offset) || '0',
        deadband: toDecimalInputText(values.deadband) || '0',
      }),
      reg_count: values.reg_count ?? getDefaultRegCount(values.data_type) ?? 1,
      word_order: values.word_order ?? 0,
      byte_order: values.byte_order ?? 0,
      bit_index: values.data_type === MODBUS_DATA_TYPE.BOOL
        && (values.function === MODBUS_FUNCTION.READ_HOLDING_REGISTERS
          || values.function === MODBUS_FUNCTION.READ_INPUT_REGISTERS)
        ? (values.bit_index ?? null)
        : null,
    };
    const nextPoints = editingPointIndex === null
      ? [...points, nextPoint]
      : points.map((point, index) => (index === editingPointIndex ? nextPoint : point));

    setPointSubmitting(true);
    try {
      const result = await savePointTablePreservingRuntime(nextPoints);
      setPoints(nextPoints);
      setPointModalOpen(false);
      messageApi.success(editingPointIndex === null ? '点位已添加' : '点位已更新');
      if (result.restartError) {
        messageApi.warning(`点表已保存，但重新启动失败: ${formatErrorText(result.restartError)}`);
      }
      await refreshLinks({ silent: true });
    } catch (error) {
      messageApi.error(`保存点位失败: ${error}`);
    } finally {
      setPointSubmitting(false);
    }
  }, [editingPointIndex, messageApi, pointForm, points, refreshLinks, savePointTablePreservingRuntime, selectedConn]);

  const handleDeletePoint = useCallback(async (index: number) => {
    if (!selectedConn || pointSubmitting) {
      return;
    }
    setPointSubmitting(true);
    try {
      const nextPoints = points.filter((_point, pointIndex) => pointIndex !== index);
      await savePointTablePreservingRuntime(nextPoints, nextPoints.length > 0);
      setPoints(nextPoints);
      await refreshLinks({ silent: true });
      messageApi.success('点位已删除');
    } catch (error) {
      messageApi.error(`删除点位失败: ${error}`);
    } finally {
      setPointSubmitting(false);
    }
  }, [messageApi, pointSubmitting, points, refreshLinks, savePointTablePreservingRuntime, selectedConn]);

  const handleDeleteAllPoints = useCallback(async () => {
    if (!selectedConn || pointSubmitting) {
      return;
    }
    setPointSubmitting(true);
    try {
      await savePointTablePreservingRuntime([], false);
      setPoints([]);
      await refreshLinks({ silent: true });
      messageApi.success('全部点位已删除，连接保持停止');
    } catch (error) {
      messageApi.error(`删除全部点位失败: ${error}`);
    } finally {
      setPointSubmitting(false);
    }
  }, [messageApi, pointSubmitting, refreshLinks, savePointTablePreservingRuntime, selectedConn]);

  useEffect(() => {
    void refreshLinks();
    const timer = window.setInterval(() => void refreshLinks({ silent: true }), 5000);
    return () => window.clearInterval(timer);
  }, [refreshLinks]);

  useEffect(() => {
    if (selectedConn) {
      void loadPoints(selectedConn);
    } else {
      pointLoadRequestRef.current += 1;
      setPoints([]);
      setPointsLoading(false);
    }
  }, [loadPoints, selectedConn]);

  const renderLinkModal = () => (
    <Modal
      title={editingLink ? '编辑 Modbus TCP 连接' : '新增 Modbus TCP 连接'}
      open={linkModalOpen}
      onCancel={() => setLinkModalOpen(false)}
      onOk={() => void handleLinkSubmit()}
      okText={editingLink ? '保存修改' : '创建连接'}
      cancelText="取消"
      confirmLoading={linkSubmitting}
      maskClosable={!linkSubmitting}
      closable={!linkSubmitting}
      width={760}
      className="modbus-config-modal"
      destroyOnClose
    >
      <Form form={linkForm} layout="vertical" autoComplete="off">
        <div className="modbus-form-section">
          <Text className="modbus-form-section-title">连接标识</Text>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                label="连接名称"
                name="conn_name"
                rules={[
                  { required: true, message: '请输入连接名称' },
                  { max: 64, message: '连接名称不能超过 64 个字符' },
                  {
                    validator: async (_, value: string) => {
                      const name = value?.trim();
                      if (!name) throw new Error('连接名称不能只包含空格');
                      if (links.some((item) => item.config?.conn_name === name && name !== editingLink?.conn_name)) {
                        throw new Error('连接名称已存在');
                      }
                    },
                  },
                ]}
              >
                <Input placeholder="例如：PCS-TCP-1" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                label="Unit ID"
                name="unit_id"
                rules={[
                  { required: true, message: '请输入 1 到 247 的 Unit ID' },
                  { type: 'number', min: 1, max: 247, message: 'Unit ID 必须是 1 到 247 的整数' },
                ]}
              >
                <InputNumber min={1} max={247} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </div>

        <div className="modbus-form-section">
          <Text className="modbus-form-section-title">TCP 目标端</Text>
          <Row gutter={16}>
            <Col xs={24} sm={16}>
              <Form.Item
                label="主机地址"
                name="host"
                rules={[
                  { required: true, message: '请输入 IP 地址或域名' },
                  { whitespace: true, message: '主机地址不能只包含空格' },
                ]}
              >
                <Input placeholder="例如：192.168.1.20" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item
                label="端口"
                name="port"
                rules={[
                  { required: true, message: '请输入端口' },
                  { type: 'number', min: 1, max: 65535, message: '端口必须是 1 到 65535 的整数' },
                ]}
              >
                <InputNumber min={1} max={65535} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </div>

        <div className="modbus-form-section">
          <Text className="modbus-form-section-title">超时与采集</Text>
          <Row gutter={16}>
            <Col xs={24} sm={12} lg={6}>
              <Form.Item
                label="连接超时"
                name="connect_timeout_ms"
                rules={[
                  { required: true, message: '请输入连接超时' },
                  { type: 'number', min: 1, message: '连接超时必须是正整数' },
                ]}
              >
                <InputNumber min={1} precision={0} addonAfter="ms" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Form.Item
                label="请求超时"
                name="request_timeout_ms"
                rules={[
                  { required: true, message: '请输入请求超时' },
                  { type: 'number', min: 1, message: '请求超时必须是正整数' },
                ]}
              >
                <InputNumber min={1} precision={0} addonAfter="ms" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Form.Item
                label="轮询周期"
                name="poll_interval_ms"
                rules={[
                  { required: true, message: '请输入轮询周期' },
                  { type: 'number', min: 1, message: '轮询周期必须是正整数' },
                ]}
              >
                <InputNumber min={1} precision={0} addonAfter="ms" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Form.Item
                label="地址基准"
                name="address_base"
                extra={editingLink && points.length > 0 ? '已有点位时不能直接切换地址基准。' : undefined}
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

  const renderPointModal = () => (
    <Modal
      title={editingPointIndex === null ? '新增点位' : '编辑点位'}
      open={pointModalOpen}
      onCancel={() => setPointModalOpen(false)}
      onOk={() => void handlePointSubmit()}
      okText={editingPointIndex === null ? '添加点位' : '保存修改'}
      cancelText="取消"
      confirmLoading={pointSubmitting}
      maskClosable={!pointSubmitting}
      closable={!pointSubmitting}
      width={720}
      className="modbus-config-modal"
      destroyOnClose
    >
      <Form form={pointForm} layout="vertical">
        <Form.Item name="address_base" hidden><InputNumber /></Form.Item>
        <Form.Item
          name="deadband"
          hidden
          rules={[{ validator: validateEngineeringDecimal('死区') }]}
        >
          <Input />
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
                    if (!tag) throw new Error('Tag 不能只包含空格');
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
                    && (value === MODBUS_FUNCTION.READ_HOLDING_REGISTERS
                      || value === MODBUS_FUNCTION.READ_INPUT_REGISTERS);
                  pointForm.setFieldsValue({
                    data_type: nextType,
                    reg_count: getAllowedRegCountsForFunction(value, nextType)[0]
                      ?? getDefaultRegCount(nextType)
                      ?? 1,
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
              <InputNumber min={getMinimumAddress(pointAddressBase)} max={65535} precision={0} style={{ width: '100%' }} />
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
                    && (pointFunction === MODBUS_FUNCTION.READ_HOLDING_REGISTERS
                      || pointFunction === MODBUS_FUNCTION.READ_INPUT_REGISTERS);
                  pointForm.setFieldsValue({
                    reg_count: getAllowedRegCountsForFunction(pointFunction, value)[0]
                      ?? getDefaultRegCount(value)
                      ?? 1,
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
              <Form.Item label="位索引" name="bit_index" rules={[{ required: true, message: '请输入位索引' }]}>
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
                <Form.Item
                  label="缩放系数"
                  name="scale"
                  rules={[{ validator: validateEngineeringDecimal('缩放系数') }]}
                >
                  <InputNumber<string> stringMode step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} lg={8}>
                <Form.Item
                  label="偏移量"
                  name="offset"
                  rules={[{ validator: validateEngineeringDecimal('偏移量') }]}
                >
                  <InputNumber<string> stringMode step={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              {(pointDataType === MODBUS_DATA_TYPE.UINT32 || pointDataType === MODBUS_DATA_TYPE.INT32) ? (
                <Col xs={24} sm={12} lg={8}>
                  <Form.Item label="字序" name="word_order"><Select options={WORD_ORDER_OPTIONS} /></Form.Item>
                </Col>
              ) : null}
              <Col xs={24} sm={12} lg={8}>
                <Form.Item label="字节序" name="byte_order"><Select options={BYTE_ORDER_OPTIONS} /></Form.Item>
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
          message={`${PROTOCOL_META.moduleName} 连接列表刷新失败`}
          description={`${refreshError}${lastRefreshAt ? `；上次成功刷新于 ${new Date(lastRefreshAt).toLocaleTimeString()}` : ''}`}
          action={<Button size="small" onClick={() => void refreshLinks()}>重试</Button>}
        />
      ) : null}
      {realtimeError ? (
        <Alert
          className="modbus-page-alert"
          type="warning"
          showIcon
          message="实时数据暂不可用"
          description={`点表配置仍可继续；实时数据错误：${realtimeError}`}
        />
      ) : null}

      {currentView === 'config' ? (
        <ResizableSplit
          className="protocol-config-view"
          orientation="vertical"
          defaultSize={360}
          minSize={240}
          maxSize={620}
          storageKey="mskdsp.layout.modbus-tcp.config"
        >
          <ResizableSplit
            className="protocol-top-row"
            defaultSize={240}
            minSize={200}
            maxSize={420}
            storageKey="mskdsp.layout.modbus-tcp.connection"
          >
            <ProtocolConnectionList
              title="连接列表"
              addButtonText="新增连接"
              width="100%"
              links={links}
              selectedConn={selectedConn}
              loading={loading}
              actionsDisabled={actionsDisabled}
              getItemActionsDisabled={(item) => item.state === 3}
              onSelect={setSelectedConn}
              onCreate={openCreateLink}
              onCopy={(connName) => void handleCopyLink(connName)}
              onDelete={(connName) => void handleDeleteLink(connName)}
              onRefresh={() => void refreshLinks()}
              getStateColor={(item) => LIST_STATE_COLOR_MAP[item.state] ?? '#8c8c8c'}
              getDescription={(item) => {
                const tcp = item.config?.tcp;
                return `${LINK_STATE_LABELS[item.state] ?? '状态未知'} · ${tcp ? `${tcp.host}:${tcp.port}` : '目标未配置'} · Unit ${tcp?.unit_id ?? '-'}`;
              }}
              getDeleteTitle={(connName) => `确认删除 ${connName}？`}
            />
            <div className="modbus-connection-shell">
              <ConnectionConfig
                link={selectedLink}
                pointCount={points.length}
                busy={actionsDisabled}
                runtimeAction={runtimeAction}
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
            readPlan={{ mode: 1, blocks: [] }}
            addressBase={selectedLink?.config?.address_base ?? MODBUS_ADDRESS_BASE.ZERO}
            readPlanSaving={false}
            runtimeRunning={selectedLink?.state === 2}
            showReadPlan={false}
            onReadPlanSave={async () => false}
            onAdd={openCreatePoint}
            onEdit={openEditPoint}
            onCopy={openCopyPoint}
            onDelete={(index) => void handleDeletePoint(index)}
            onDeleteAll={() => void handleDeleteAllPoints()}
          />
        </ResizableSplit>
      ) : (
        <Card title="报文日志" size="small" bordered className="protocol-log-card">
          <div className="protocol-log-scroll">
            <div className="protocol-log-console">
              <div><span style={{ color: '#007acc' }}>[TCP]</span> --:--:--.--- - 暂无报文</div>
              <div className="protocol-log-line--hint">等待 {PROTOCOL_META.label} 链路报文...</div>
            </div>
          </div>
        </Card>
      )}

      {renderLinkModal()}
      {renderPointModal()}
    </div>
  );
};

export default ModbusTCP;
