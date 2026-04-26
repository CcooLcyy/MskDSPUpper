import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
  DisconnectOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../adapters';
import ProtocolConnectionList from '../../components/protocol/ProtocolConnectionList';
import { normalizeProtocolView, PROTOCOL_VIEW_QUERY_KEY } from '../../components/protocol/protocol-view';
import {
  renderProtocolRealtimeQualityCell,
  renderProtocolRealtimeTimestampCell,
  renderProtocolRealtimeValueCell,
  useProtocolShadowRealtime,
} from '../../components/protocol/protocol-realtime';
import {
  buildDuplicateConnectionName,
  findNextAvailablePort,
  isNotFoundError,
} from '../../utils/connection-copy';
import { isValidIpv4Address } from '../../utils/network';
import type {
  DcConnectionInfo,
  Iec104LinkConfig,
  Iec104LinkInfo,
  Iec104Point,
} from '../../adapters';

const { Text } = Typography;

// ── Constants ──

const ROLE_LABELS: Record<number, string> = {
  0: 'UNSPECIFIED',
  1: 'SERVER',
  2: 'CLIENT',
};

const ROLE_SERVER = 1;
const ROLE_CLIENT = 2;
const DEFAULT_SERVER_LOCAL_IP = '0.0.0.0';
const DEFAULT_IEC104_PORT = 2404;
const IP_ADDRESS_ERROR_MESSAGE = '请输入合法的 IPv4 地址';

const STATION_ROLE_LABELS: Record<number, string> = {
  0: 'UNSPECIFIED (按 role 默认)',
  1: 'MASTER (控制站)',
  2: 'SLAVE (被控站)',
};

const STATE_MAP: Record<number, { label: string; color: string }> = {
  0: { label: 'IDLE', color: 'default' },
  1: { label: 'CONNECTING', color: 'orange' },
  2: { label: 'CONNECTED', color: 'green' },
  3: { label: 'CLOSED', color: 'red' },
};

const LIST_STATE_COLOR_MAP: Record<number, string> = {
  0: '#8c8c8c',
  1: '#ff9800',
  2: '#4caf50',
  3: '#f44336',
};

const POINT_TYPE_LABELS: Record<number, string> = {
  1: 'FLOAT (短浮点测量)',
  2: 'SINGLE (单点遥信)',
};

const MAX_IOA = 16777215;

const DEFAULT_POINT_FORM_VALUES = {
  scale: 1,
  offset: 0,
  deadband: 0,
};

const normalizeIpInput = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim() : value;

const validateOptionalIpv4 = (_rule: unknown, value: unknown): Promise<void> => {
  if (typeof value !== 'string' || value.trim() === '') {
    return Promise.resolve();
  }

  if (isValidIpv4Address(value)) {
    return Promise.resolve();
  }

  return Promise.reject(new Error(IP_ADDRESS_ERROR_MESSAGE));
};

type IoaCategoryKey = 'custom' | 'teleindication' | 'telemetry' | 'remoteAdjust';

type IoaCategoryOption = {
  value: IoaCategoryKey;
  label: string;
  start?: number;
};

type DataBusConnectionOption = {
  value: string;
  label: string;
  connId: number;
  connName: string;
};

type DataBusEndpointOption = {
  value: string;
  label: string;
  connId: number;
  moduleName: string;
  connName: string;
  tag: string;
};

type ImportedPointDraft = Iec104Point & {
  key: string;
  sourceValue: string;
  sourceLabel: string;
  ioa_category: IoaCategoryKey;
};

const IOA_CATEGORY_OPTIONS: IoaCategoryOption[] = [
  { value: 'custom', label: '自定义' },
  { value: 'teleindication', label: '遥信 (0001H 起)', start: 0x0001 },
  { value: 'telemetry', label: '遥测 (4001H 起)', start: 0x4001 },
  { value: 'remoteAdjust', label: '遥调 (6201H 起)', start: 0x6201 },
];

const KNOWN_IOA_CATEGORY_OPTIONS = IOA_CATEGORY_OPTIONS.filter(
  (option): option is IoaCategoryOption & { start: number } => typeof option.start === 'number',
);

const buildDataBusConnectionOptions = (connections: DcConnectionInfo[]): DataBusConnectionOption[] =>
  connections
    .map((connection) => ({
      value: String(connection.conn_id),
      label: `${connection.module_name}/${connection.conn_name}`,
      connId: connection.conn_id,
      connName: connection.conn_name,
    }))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));

const normalizeImportedTagPart = (value: string) =>
  value
    .trim()
    .replace(/[\\/:]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

const buildImportedPointBaseTag = (sourcePoint: DataBusEndpointOption) => {
  const parts = [sourcePoint.moduleName, sourcePoint.connName, sourcePoint.tag]
    .map(normalizeImportedTagPart)
    .filter(Boolean);

  return parts.join('_') || sourcePoint.tag.trim();
};

const buildUniqueImportedPointTag = (sourcePoint: DataBusEndpointOption, usedTags: Set<string>) => {
  const baseTag = buildImportedPointBaseTag(sourcePoint) || `imported_${sourcePoint.connId}`;
  let candidate = baseTag;
  let suffix = 2;

  while (usedTags.has(candidate)) {
    candidate = `${baseTag}_${suffix}`;
    suffix += 1;
  }

  usedTags.add(candidate);
  return candidate;
};

const getNextAvailableIoa = (usedIoas: Set<number>) => {
  const maxUsed = usedIoas.size > 0 ? Math.max(...usedIoas) : -1;
  if (maxUsed < MAX_IOA) {
    return maxUsed + 1;
  }

  for (let candidate = 0; candidate <= MAX_IOA; candidate += 1) {
    if (!usedIoas.has(candidate)) {
      return candidate;
    }
  }

  return MAX_IOA;
};

const getDefaultImportedPointType = (points: Iec104Point[]) => points[points.length - 1]?.point_type ?? 1;

const getIoaCategoryRange = (category: IoaCategoryKey) => {
  const categoryIndex = KNOWN_IOA_CATEGORY_OPTIONS.findIndex((option) => option.value === category);
  if (categoryIndex < 0) {
    return null;
  }

  const start = KNOWN_IOA_CATEGORY_OPTIONS[categoryIndex].start;
  const nextStart = KNOWN_IOA_CATEGORY_OPTIONS[categoryIndex + 1]?.start;

  return {
    start,
    end: typeof nextStart === 'number' ? nextStart - 1 : MAX_IOA,
  };
};

const getIoaCategoryByIoa = (ioa?: number | null): IoaCategoryKey => {
  if (typeof ioa !== 'number' || Number.isNaN(ioa)) {
    return 'custom';
  }

  for (const option of KNOWN_IOA_CATEGORY_OPTIONS) {
    const range = getIoaCategoryRange(option.value);
    if (range && ioa >= range.start && ioa <= range.end) {
      return option.value;
    }
  }

  return 'custom';
};

const getNextAvailableIoaInRange = (usedIoas: Set<number>, start: number, end: number) => {
  const usedIoasInRange = Array.from(usedIoas).filter((candidate) => candidate >= start && candidate <= end);
  const maxUsed = usedIoasInRange.length > 0 ? Math.max(...usedIoasInRange) : start - 1;
  const sequentialCandidate = maxUsed + 1;

  if (sequentialCandidate <= end && !usedIoas.has(sequentialCandidate)) {
    return sequentialCandidate;
  }

  for (let candidate = start; candidate <= end; candidate += 1) {
    if (!usedIoas.has(candidate)) {
      return candidate;
    }
  }

  return end;
};

const getSuggestedIoaByCategory = (
  usedIoas: Set<number>,
  category: IoaCategoryKey,
  fallbackIoa?: number,
) => {
  const range = getIoaCategoryRange(category);
  if (!range) {
    if (typeof fallbackIoa === 'number') {
      return Math.min(fallbackIoa, MAX_IOA);
    }
    return getNextAvailableIoa(usedIoas);
  }

  return getNextAvailableIoaInRange(usedIoas, range.start, range.end);
};

const resolveIoaCategoryChange = ({
  usedIoas,
  currentIoa,
  currentCategory,
  nextCategory,
}: {
  usedIoas: Set<number>;
  currentIoa?: number;
  currentCategory?: IoaCategoryKey;
  nextCategory: IoaCategoryKey;
}) => {
  const hasAvailableCurrentIoa = typeof currentIoa === 'number' && !usedIoas.has(currentIoa);
  const fallbackIoa = hasAvailableCurrentIoa ? currentIoa : getNextAvailableIoa(usedIoas);
  const keepCurrentIoa = currentCategory === nextCategory && hasAvailableCurrentIoa;

  return {
    ioa_category: nextCategory,
    ioa: keepCurrentIoa ? currentIoa : getSuggestedIoaByCategory(usedIoas, nextCategory, fallbackIoa),
  };
};

const getCreatePointInitialValues = (points: Iec104Point[]) => {
  const lastPoint = points[points.length - 1];

  if (!lastPoint) {
    return {
      ...DEFAULT_POINT_FORM_VALUES,
      ioa_category: 'custom' as IoaCategoryKey,
    };
  }

  return {
    ...DEFAULT_POINT_FORM_VALUES,
    ioa_category: 'custom' as IoaCategoryKey,
    ioa: Math.min(lastPoint.ioa + 1, MAX_IOA),
    point_type: lastPoint.point_type,
  };
};

const formatEndpoint = (ep: { ip: string; port: number } | null): string =>
  ep ? `${ep.ip}:${ep.port}` : '-';

const formatApci = (apci: { k: number; w: number; t0: number; t1: number; t2: number; t3: number } | null): string =>
  apci ? `k:${apci.k}, w:${apci.w}, t0:${apci.t0}, t1:${apci.t1}, t2:${apci.t2}, t3:${apci.t3}` : '-';

// ── Component ──

const IEC104: React.FC = () => {
  const [links, setLinks] = useState<Iec104LinkInfo[]>([]);
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [points, setPoints] = useState<Iec104Point[]>([]);
  const [loading, setLoading] = useState(false);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<Iec104LinkConfig | null>(null);
  const [pointModalOpen, setPointModalOpen] = useState(false);
  const [editingPointIndex, setEditingPointIndex] = useState<number | null>(null);
  const [importPointModalOpen, setImportPointModalOpen] = useState(false);
  const [dataBusConnectionOptions, setDataBusConnectionOptions] = useState<DataBusConnectionOption[]>([]);
  const [dataBusEndpointOptions, setDataBusEndpointOptions] = useState<DataBusEndpointOption[]>([]);
  const [dataBusEndpointLoading, setDataBusEndpointLoading] = useState(false);
  const [importSourceConnId, setImportSourceConnId] = useState<string>();
  const [selectedImportEndpointValues, setSelectedImportEndpointValues] = useState<string[]>([]);
  const [importPointDrafts, setImportPointDrafts] = useState<ImportedPointDraft[]>([]);
  const [messageApi, contextHolder] = message.useMessage();
  const [searchParams] = useSearchParams();

  const [linkForm] = Form.useForm();
  const [pointForm] = Form.useForm();
  const linkRole = Form.useWatch('role', linkForm);
  const pointIoaCategory = Form.useWatch('ioa_category', pointForm) as IoaCategoryKey | undefined;

  // ── Derived ──

  const selectedLink = links.find(
    (l) => l.config?.conn_name === selectedConn,
  ) ?? null;
  const currentView = normalizeProtocolView(searchParams.get(PROTOCOL_VIEW_QUERY_KEY));
  const showLocalEndpointFields = linkRole !== ROLE_CLIENT;
  const showRemoteEndpointFields = linkRole !== ROLE_SERVER;
  const singleEndpointMode = linkRole === ROLE_SERVER || linkRole === ROLE_CLIENT;
  const endpointIpSpan = singleEndpointMode ? 18 : 9;
  const endpointPortSpan = singleEndpointMode ? 6 : 3;
  const realtimeTags = useMemo(
    () => points.map((point) => point.tag),
    [points],
  );
  const { realtimeByTag, realtimeRevisionByTag, loading: realtimeLoading } = useProtocolShadowRealtime(
    selectedLink?.conn_id ?? null,
    realtimeTags,
  );
  const importReservedTagSet = useMemo(() => {
    const reservedTags = new Set<string>();

    for (const point of points) {
      const tag = point.tag.trim();
      if (tag) {
        reservedTags.add(tag);
      }
    }

    for (const endpoint of dataBusEndpointOptions) {
      if (endpoint.connId === selectedLink?.conn_id) {
        continue;
      }

      const tag = endpoint.tag.trim();
      if (tag) {
        reservedTags.add(tag);
      }
    }

    return reservedTags;
  }, [dataBusEndpointOptions, points, selectedLink?.conn_id]);
  const importSourceEndpointOptions = useMemo(
    () =>
      dataBusEndpointOptions
        .filter((item) => String(item.connId) === importSourceConnId)
        .map((item) => ({
          value: item.value,
          label: item.label,
          selectedLabel: item.tag,
        })),
    [dataBusEndpointOptions, importSourceConnId],
  );

  // ── Data Loading ──

  const refreshLinks = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.iec104ListLinks();
      setLinks(list);
    } catch (e) {
      messageApi.error(`刷新链路列表失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  const loadPoints = useCallback(
    async (connName: string) => {
      try {
        const pt = await api.iec104GetPointTable(connName);
        setPoints(pt.points);
      } catch {
        setPoints([]);
      }
    },
    [],
  );

  const refreshDataBusEndpointOptions = useCallback(async () => {
    setDataBusEndpointLoading(true);
    try {
      const connections = await api.dcListConnections();
      setDataBusConnectionOptions(buildDataBusConnectionOptions(connections));

      const endpointGroups = await Promise.all(
        connections.map(async (connection) => {
          try {
            const connTags = await api.dcGetConnTags(connection.conn_id);
            return connTags.tags.map((tag) => ({
              value: `${connection.conn_id}:${tag}`,
              label: `${connection.module_name}/${connection.conn_name} : ${tag}`,
              connId: connection.conn_id,
              moduleName: connection.module_name,
              connName: connection.conn_name,
              tag,
            }));
          } catch {
            return [];
          }
        }),
      );

      setDataBusEndpointOptions(
        endpointGroups
          .flat()
          .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN')),
      );
    } catch (e) {
      setDataBusConnectionOptions([]);
      setDataBusEndpointOptions([]);
      messageApi.error(`加载现有点位失败: ${e}`);
    } finally {
      setDataBusEndpointLoading(false);
    }
  }, [messageApi]);

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

  // ── Link Handlers ──

  const openCreateLink = useCallback(() => {
    setEditingLink(null);
    linkForm.resetFields();
    linkForm.setFieldsValue({
      role: ROLE_SERVER,
      station_role: 2,
      ca: 1,
      oa: 0,
      local_ip: DEFAULT_SERVER_LOCAL_IP,
      local_port: DEFAULT_IEC104_PORT,
      k: 12,
      w: 8,
      t0: 30,
      t1: 15,
      t2: 10,
      t3: 20,
      point_batch_window_ms: 0,
      point_max_asdu_bytes: 249,
      point_use_standard_limit: true,
      point_dedupe: null,
      point_with_time: false,
      time_sync_tag: 'sys_time',
    });
    setLinkModalOpen(true);
  }, [linkForm]);

  const openEditLink = useCallback(() => {
    if (!selectedLink?.config) return;
    const c = selectedLink.config;
    setEditingLink(c);
    linkForm.setFieldsValue({
      conn_name: c.conn_name,
      role: c.role,
      station_role: c.station_role,
      ca: c.ca,
      oa: c.oa,
      local_ip: c.local?.ip ?? '',
      local_port: c.local?.port,
      remote_ip: c.remote?.ip ?? '',
      remote_port: c.remote?.port ?? 2404,
      k: c.apci?.k ?? 12,
      w: c.apci?.w ?? 8,
      t0: c.apci?.t0 ?? 30,
      t1: c.apci?.t1 ?? 15,
      t2: c.apci?.t2 ?? 10,
      t3: c.apci?.t3 ?? 20,
      point_batch_window_ms: c.point_batch_window_ms,
      point_max_asdu_bytes: c.point_max_asdu_bytes,
      point_use_standard_limit: c.point_use_standard_limit,
      point_dedupe: c.point_dedupe,
      point_with_time: c.point_with_time,
      time_sync_tag: c.time_sync_tag,
    });
    setLinkModalOpen(true);
  }, [selectedLink, linkForm]);

  const handleLinkFormValuesChange = useCallback(
    (
      changedValues: Record<string, unknown>,
      allValues: Record<string, unknown>,
    ) => {
      const role = typeof changedValues.role === 'number' ? changedValues.role : undefined;
      const localIp = typeof allValues.local_ip === 'string' ? allValues.local_ip : undefined;
      const localPort = typeof allValues.local_port === 'number' ? allValues.local_port : undefined;
      const remoteIp = typeof allValues.remote_ip === 'string' ? allValues.remote_ip : undefined;
      const remotePort = typeof allValues.remote_port === 'number' ? allValues.remote_port : undefined;

      if (role === ROLE_SERVER) {
        const nextValues: {
          local_ip?: string;
          local_port?: number;
          remote_ip?: string;
          remote_port?: number;
        } = {};

        if (!localIp) {
          nextValues.local_ip = DEFAULT_SERVER_LOCAL_IP;
        }
        if (localPort == null) {
          nextValues.local_port = DEFAULT_IEC104_PORT;
        }
        if (remoteIp) {
          nextValues.remote_ip = '';
        }
        if (remotePort != null) {
          nextValues.remote_port = undefined;
        }

        if (Object.keys(nextValues).length > 0) {
          linkForm.setFieldsValue(nextValues);
        }
        return;
      }

      if (role === ROLE_CLIENT) {
        const nextValues: {
          local_ip?: string;
          local_port?: number;
          remote_port?: number;
        } = {
          local_ip: '',
          local_port: undefined,
        };

        if (remotePort == null) {
          nextValues.remote_port = DEFAULT_IEC104_PORT;
        }

        linkForm.setFieldsValue(nextValues);
      }
    },
    [linkForm],
  );

  const handleLinkSubmit = useCallback(async () => {
    let renameCompleted = false;
    try {
      const values = await linkForm.validateFields();
      const isServerRole = values.role === ROLE_SERVER;
      const isClientRole = values.role === ROLE_CLIENT;
      const localIp = typeof values.local_ip === 'string' ? values.local_ip.trim() : '';
      const remoteIp = typeof values.remote_ip === 'string' ? values.remote_ip.trim() : '';
      const config: Iec104LinkConfig = {
        conn_name: values.conn_name,
        role: values.role,
        station_role: values.station_role,
        ca: values.ca,
        oa: values.oa,
        local: isClientRole
          ? null
          : localIp
            ? { ip: localIp, port: values.local_port ?? DEFAULT_IEC104_PORT }
            : null,
        remote: isServerRole
          ? null
          : remoteIp
            ? { ip: remoteIp, port: values.remote_port ?? DEFAULT_IEC104_PORT }
            : null,
        apci: {
          k: values.k ?? 12,
          w: values.w ?? 8,
          t0: values.t0 ?? 30,
          t1: values.t1 ?? 15,
          t2: values.t2 ?? 10,
          t3: values.t3 ?? 20,
        },
        point_batch_window_ms: values.point_batch_window_ms ?? 0,
        point_max_asdu_bytes: values.point_max_asdu_bytes ?? 249,
        point_use_standard_limit: values.point_use_standard_limit ?? true,
        point_dedupe: values.point_dedupe ?? null,
        point_with_time: values.point_with_time ?? false,
        time_sync_tag: values.time_sync_tag ?? 'sys_time',
      };
      const createOnly = !editingLink;
      const oldConnName = editingLink?.conn_name ?? null;
      const renamed = !createOnly && oldConnName !== config.conn_name;

      if (renamed && oldConnName) {
        await api.iec104RenameLink(oldConnName, config.conn_name);
        renameCompleted = true;
      }

      await api.iec104UpsertLink(config, createOnly);
      messageApi.success(
        createOnly ? '链路创建成功' : renamed ? '链路已改名并更新成功' : '链路更新成功',
      );
      setLinkModalOpen(false);
      await refreshLinks();
      setSelectedConn(config.conn_name);
    } catch (e) {
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
        messageApi.error(`连接已改名，但保存其他配置失败: ${e}`);
        return;
      }
      messageApi.error(`操作失败: ${e}`);
    }
  }, [linkForm, editingLink, messageApi, refreshLinks]);

  const handleDeleteLink = useCallback(
    async (connName: string) => {
      try {
        await api.iec104DeleteLink(connName);
        messageApi.success(`链路 ${connName} 已删除`);
        if (selectedConn === connName) {
          setSelectedConn(null);
        }
        await refreshLinks();
      } catch (e) {
        messageApi.error(`删除失败: ${e}`);
      }
    },
    [messageApi, selectedConn, refreshLinks],
  );

  const handleCopyLink = useCallback(
    async (sourceConnName: string) => {
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
      const copiedConfig: Iec104LinkConfig = {
        ...sourceConfig,
        conn_name: nextConnName,
        local: sourceConfig.local ? { ...sourceConfig.local } : null,
        remote: sourceConfig.remote ? { ...sourceConfig.remote } : null,
        apci: sourceConfig.apci ? { ...sourceConfig.apci } : null,
      };

      if (copiedConfig.local) {
        const nextLocalPort = findNextAvailablePort(
          copiedConfig.local.port,
          links
            .map((link) => link.config?.local?.port)
            .filter((port): port is number => typeof port === 'number'),
        );

        if (nextLocalPort == null) {
          messageApi.error('复制连接失败: 未找到可用的 IEC104 监听端口');
          return;
        }

        copiedConfig.local.port = nextLocalPort;
      }

      try {
        await api.iec104UpsertLink(copiedConfig, true);

        let pointCopyError: unknown = null;
        try {
          const pointTable = await api.iec104GetPointTable(sourceConnName);
          if (pointTable.points.length > 0) {
            await api.iec104UpsertPointTable(
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

        messageApi.success(
          copiedConfig.local
            ? `已复制连接为 ${nextConnName}，监听端口已调整为 ${copiedConfig.local.port}`
            : `已复制连接为 ${nextConnName}`,
        );
      } catch (error) {
        messageApi.error(`复制连接失败: ${error}`);
      }
    },
    [links, messageApi, refreshLinks],
  );

  // ── Operation Handlers ──

  const handleStartLink = useCallback(async () => {
    if (!selectedConn) return;
    try {
      await api.iec104StartLink(selectedConn);
      messageApi.success('连接请求已发送');
      setTimeout(() => void refreshLinks(), 1000);
    } catch (e) {
      messageApi.error(`连接失败: ${e}`);
    }
  }, [selectedConn, messageApi, refreshLinks]);

  const handleStopLink = useCallback(async () => {
    if (!selectedConn) return;
    try {
      await api.iec104StopLink(selectedConn);
      messageApi.success('断开请求已发送');
      setTimeout(() => void refreshLinks(), 1000);
    } catch (e) {
      messageApi.error(`断开失败: ${e}`);
    }
  }, [selectedConn, messageApi, refreshLinks]);

  const handleTimeSync = useCallback(async () => {
    if (!selectedConn) return;
    try {
      await api.iec104SendTimeSync(selectedConn, Date.now());
      messageApi.success('对时命令已发送');
    } catch (e) {
      messageApi.error(`对时失败: ${e}`);
    }
  }, [selectedConn, messageApi]);

  // ── Point Handlers ──

  const openCreatePoint = useCallback(() => {
    setEditingPointIndex(null);
    pointForm.resetFields();
    pointForm.setFieldsValue(getCreatePointInitialValues(points));
    setPointModalOpen(true);
  }, [pointForm, points]);

  const openImportPointModal = useCallback(() => {
    setImportSourceConnId(undefined);
    setSelectedImportEndpointValues([]);
    setImportPointDrafts([]);
    setImportPointModalOpen(true);
    void refreshDataBusEndpointOptions();
  }, [refreshDataBusEndpointOptions]);

  const openEditPoint = useCallback(
    (index: number) => {
      const p = points[index];
      setEditingPointIndex(index);
      pointForm.setFieldsValue({
        tag: p.tag,
        ioa: p.ioa,
        ioa_category: getIoaCategoryByIoa(p.ioa),
        point_type: p.point_type,
        scale: p.scale,
        offset: p.offset,
        deadband: p.deadband,
      });
      setPointModalOpen(true);
    },
    [points, pointForm],
  );

  const handlePointIoaCategoryChange = useCallback(
    (nextCategory: IoaCategoryKey) => {
      const usedIoas = new Set(
        points
          .filter((_point, index) => index !== editingPointIndex)
          .map((point) => point.ioa),
      );
      const currentIoa = pointForm.getFieldValue('ioa');

      pointForm.setFieldsValue(
        resolveIoaCategoryChange({
          usedIoas,
          currentIoa: typeof currentIoa === 'number' ? currentIoa : undefined,
          currentCategory: pointIoaCategory,
          nextCategory,
        }),
      );
    },
    [editingPointIndex, pointForm, pointIoaCategory, points],
  );

  const handlePointIoaChange = useCallback(
    (nextValue: number | null) => {
      pointForm.setFieldsValue({
        ioa: typeof nextValue === 'number' ? nextValue : undefined,
        ioa_category: getIoaCategoryByIoa(nextValue),
      });
    },
    [pointForm],
  );

  const handlePointSubmit = useCallback(async () => {
    if (!selectedConn) return;
    try {
      const values = await pointForm.validateFields();
      const newPoint: Iec104Point = {
        tag: values.tag,
        ioa: values.ioa,
        point_type: values.point_type,
        scale: values.scale ?? 1,
        offset: values.offset ?? 0,
        deadband: values.deadband ?? 0,
      };
      let newPoints: Iec104Point[];
      if (editingPointIndex !== null) {
        newPoints = points.map((p, i) => (i === editingPointIndex ? newPoint : p));
      } else {
        newPoints = [...points, newPoint];
      }
      await api.iec104UpsertPointTable(selectedConn, newPoints, true);
      messageApi.success(editingPointIndex !== null ? '点位已更新' : '点位已添加');
      setPointModalOpen(false);
      setPoints(newPoints);
    } catch (e) {
      messageApi.error(`操作失败: ${e}`);
    }
  }, [selectedConn, pointForm, editingPointIndex, points, messageApi]);

  const handleDeletePoint = useCallback(
    async (index: number) => {
      if (!selectedConn) return;
      try {
        const newPoints = points.filter((_p, i) => i !== index);
        await api.iec104UpsertPointTable(selectedConn, newPoints, true);
        messageApi.success('点位已删除');
        setPoints(newPoints);
      } catch (e) {
        messageApi.error(`删除失败: ${e}`);
      }
    },
    [selectedConn, points, messageApi],
  );

  const handleDeleteAllPoints = useCallback(async () => {
    if (!selectedConn) return;
    try {
      await api.iec104UpsertPointTable(selectedConn, [], true);
      setPoints([]);
      messageApi.success('全部点位已删除');
    } catch (e) {
      messageApi.error(`删除全部点位失败: ${e}`);
    }
  }, [messageApi, selectedConn]);

  const handleImportSourceConnChange = useCallback((value: string | undefined) => {
    setImportSourceConnId(value);
    setSelectedImportEndpointValues([]);
    setImportPointDrafts([]);
  }, []);

  const handleSelectImportEndpoints = useCallback(
    (values: string[]) => {
      setSelectedImportEndpointValues(values);
      setImportPointDrafts((prev) => {
        const prevMap = new Map(prev.map((item) => [item.sourceValue, item]));
        const usedIoas = new Set(points.map((point) => point.ioa));
        const usedTags = new Set(importReservedTagSet);
        const nextDrafts: ImportedPointDraft[] = [];

        for (const value of values) {
          const existingDraft = prevMap.get(value);
          if (existingDraft) {
            nextDrafts.push(existingDraft);
            usedIoas.add(existingDraft.ioa);
            if (existingDraft.tag.trim()) {
              usedTags.add(existingDraft.tag.trim());
            }
            continue;
          }

          const sourcePoint = dataBusEndpointOptions.find((item) => item.value === value);
          if (!sourcePoint) {
            continue;
          }

          const nextIoa = getNextAvailableIoa(usedIoas);
          usedIoas.add(nextIoa);
          nextDrafts.push({
            key: value,
            sourceValue: value,
            sourceLabel: sourcePoint.label,
            tag: buildUniqueImportedPointTag(sourcePoint, usedTags),
            ioa: nextIoa,
            ioa_category: 'custom',
            point_type: getDefaultImportedPointType(points),
            scale: DEFAULT_POINT_FORM_VALUES.scale,
            offset: DEFAULT_POINT_FORM_VALUES.offset,
            deadband: DEFAULT_POINT_FORM_VALUES.deadband,
          });
        }

        return nextDrafts;
      });
    },
    [dataBusEndpointOptions, importReservedTagSet, points],
  );

  const updateImportPointDraft = useCallback((key: string, patch: Partial<ImportedPointDraft>) => {
    setImportPointDrafts((prev) =>
      prev.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }, []);

  const handleImportPointIoaCategoryChange = useCallback(
    (key: string, nextCategory: IoaCategoryKey) => {
      setImportPointDrafts((prev) => {
        const usedIoas = new Set(points.map((point) => point.ioa));
        const currentDraft = prev.find((item) => item.key === key);

        prev.forEach((item) => {
          if (item.key !== key) {
            usedIoas.add(item.ioa);
          }
        });

        const nextDraftFields = resolveIoaCategoryChange({
          usedIoas,
          currentIoa: currentDraft?.ioa,
          currentCategory: currentDraft?.ioa_category,
          nextCategory,
        });

        return prev.map((item) =>
          item.key === key
            ? {
                ...item,
                ...nextDraftFields,
              }
            : item,
        );
      });
    },
    [points],
  );

  const handleImportPointIoaChange = useCallback(
    (key: string, nextValue: number | null) => {
      updateImportPointDraft(key, {
        ioa: typeof nextValue === 'number' ? nextValue : 0,
        ioa_category: getIoaCategoryByIoa(nextValue),
      });
    },
    [updateImportPointDraft],
  );

  const handleRemoveImportPointDraft = useCallback((key: string) => {
    setSelectedImportEndpointValues((prev) => prev.filter((value) => value !== key));
    setImportPointDrafts((prev) => prev.filter((item) => item.key !== key));
  }, []);

  const handleImportPointsSubmit = useCallback(async () => {
    if (!selectedConn) return;
    if (importPointDrafts.length === 0) {
      messageApi.error('请选择需要导入的现有点位');
      return;
    }

    const existingTags = new Set(points.map((point) => point.tag.trim()));
    const existingIoas = new Set(points.map((point) => point.ioa));
    const importReservedTags = new Set(importReservedTagSet);
    const draftTags = new Set<string>();
    const draftIoas = new Set<number>();
    const normalizedPoints: Iec104Point[] = [];

    for (const draft of importPointDrafts) {
      const tag = draft.tag.trim();
      if (!tag) {
        messageApi.error(`请完善来源点位 ${draft.sourceLabel} 的标签`);
        return;
      }
      if (!Number.isInteger(draft.ioa) || draft.ioa < 0 || draft.ioa > MAX_IOA) {
        messageApi.error(`点位 ${tag} 的 IOA 必须为 0 ~ ${MAX_IOA} 的整数`);
        return;
      }
      if (!draft.point_type) {
        messageApi.error(`请选择点位 ${tag} 的类型`);
        return;
      }
      if (existingTags.has(tag) || draftTags.has(tag)) {
        messageApi.error(`目标连接内标签 ${tag} 重复，请调整后再导入`);
        return;
      }
      if (importReservedTags.has(tag)) {
        messageApi.error(`标签 ${tag} 已被其他连接占用，请调整后再导入`);
        return;
      }
      if (existingIoas.has(draft.ioa) || draftIoas.has(draft.ioa)) {
        messageApi.error(`目标连接内 IOA ${draft.ioa} 重复，请调整后再导入`);
        return;
      }

      normalizedPoints.push({
        tag,
        ioa: draft.ioa,
        point_type: draft.point_type,
        scale: draft.scale ?? DEFAULT_POINT_FORM_VALUES.scale,
        offset: draft.offset ?? DEFAULT_POINT_FORM_VALUES.offset,
        deadband: draft.deadband ?? DEFAULT_POINT_FORM_VALUES.deadband,
      });
      draftTags.add(tag);
      draftIoas.add(draft.ioa);
    }

    try {
      const newPoints = [...points, ...normalizedPoints];
      await api.iec104UpsertPointTable(selectedConn, newPoints, true);
      setPoints(newPoints);
      setImportPointModalOpen(false);
      messageApi.success(`已导入 ${normalizedPoints.length} 个点位`);
    } catch (e) {
      messageApi.error(`导入点位失败: ${e}`);
    }
  }, [importPointDrafts, importReservedTagSet, messageApi, points, selectedConn]);

  // ── Point Table Columns ──

  const pointColumns: ColumnsType<Iec104Point> = [
    {
      title: 'Tag (标签)',
      dataIndex: 'tag',
      key: 'tag',
      width: 160,
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: 'IOA (信息体地址)',
      dataIndex: 'ioa',
      key: 'ioa',
      width: 140,
    },
    {
      title: '类型 (Type)',
      dataIndex: 'point_type',
      key: 'point_type',
      width: 220,
      render: (v: number) => POINT_TYPE_LABELS[v] ?? `TypeID: ${v}`,
    },
    {
      title: '实时值',
      key: 'realtime_value',
      width: 160,
      render: (_: unknown, record: Iec104Point) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeValueCell(update, realtimeRevisionByTag[record.tag]?.value);
      },
    },
    {
      title: '时间',
      key: 'realtime_ts',
      width: 130,
      render: (_: unknown, record: Iec104Point) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeTimestampCell(update, realtimeRevisionByTag[record.tag]?.timestamp);
      },
    },
    {
      title: '质量',
      key: 'realtime_quality',
      width: 100,
      render: (_: unknown, record: Iec104Point) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeQualityCell(update, realtimeRevisionByTag[record.tag]?.quality);
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: unknown, _record: Iec104Point, index: number) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEditPoint(index)}
          />
          <Popconfirm
            title="确认删除该点位？"
            onConfirm={() => void handleDeletePoint(index)}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const importPointColumns: ColumnsType<ImportedPointDraft> = [
    {
      title: '来源点位',
      dataIndex: 'sourceLabel',
      key: 'sourceLabel',
      width: 280,
      ellipsis: true,
      render: (value: string) => <Text>{value}</Text>,
    },
    {
      title: 'Tag',
      dataIndex: 'tag',
      key: 'tag',
      width: 180,
      render: (value: string, record) => (
        <Input
          size="small"
          value={value}
          onChange={(event) => updateImportPointDraft(record.key, { tag: event.target.value })}
        />
      ),
    },
    {
      title: 'IOA 类型',
      dataIndex: 'ioa_category',
      key: 'ioa_category',
      width: 180,
      render: (value: IoaCategoryKey, record) => (
        <Select
          size="small"
          style={{ width: '100%' }}
          value={value}
          options={IOA_CATEGORY_OPTIONS}
          onChange={(nextValue) => handleImportPointIoaCategoryChange(record.key, nextValue as IoaCategoryKey)}
        />
      ),
    },
    {
      title: 'IOA',
      dataIndex: 'ioa',
      key: 'ioa',
      width: 120,
      render: (value: number, record) => (
        <InputNumber
          size="small"
          min={0}
          max={MAX_IOA}
          style={{ width: '100%' }}
          value={value}
          onChange={(nextValue) => handleImportPointIoaChange(record.key, nextValue)}
        />
      ),
    },
    {
      title: '类型',
      dataIndex: 'point_type',
      key: 'point_type',
      width: 220,
      render: (value: number, record) => (
        <Select
          size="small"
          style={{ width: '100%' }}
          value={value}
          options={Object.entries(POINT_TYPE_LABELS).map(([pointType, label]) => ({
            value: Number(pointType),
            label,
          }))}
          onChange={(nextValue) => updateImportPointDraft(record.key, { point_type: nextValue })}
        />
      ),
    },
    {
      title: 'Scale',
      dataIndex: 'scale',
      key: 'scale',
      width: 110,
      render: (value: number, record) => (
        <InputNumber
          size="small"
          step={0.01}
          style={{ width: '100%' }}
          value={value}
          onChange={(nextValue) =>
            updateImportPointDraft(record.key, {
              scale: typeof nextValue === 'number' ? nextValue : DEFAULT_POINT_FORM_VALUES.scale,
            })
          }
        />
      ),
    },
    {
      title: 'Offset',
      dataIndex: 'offset',
      key: 'offset',
      width: 110,
      render: (value: number, record) => (
        <InputNumber
          size="small"
          step={0.01}
          style={{ width: '100%' }}
          value={value}
          onChange={(nextValue) =>
            updateImportPointDraft(record.key, {
              offset: typeof nextValue === 'number' ? nextValue : DEFAULT_POINT_FORM_VALUES.offset,
            })
          }
        />
      ),
    },
    {
      title: 'Deadband',
      dataIndex: 'deadband',
      key: 'deadband',
      width: 120,
      render: (value: number, record) => (
        <InputNumber
          size="small"
          step={0.01}
          min={0}
          style={{ width: '100%' }}
          value={value}
          onChange={(nextValue) =>
            updateImportPointDraft(record.key, {
              deadband: typeof nextValue === 'number' ? nextValue : DEFAULT_POINT_FORM_VALUES.deadband,
            })
          }
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      fixed: 'right',
      render: (_: unknown, record) => (
        <Button
          type="link"
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={() => handleRemoveImportPointDraft(record.key)}
        />
      ),
    },
  ];

  // ── Render ──

  const stateInfo = STATE_MAP[selectedLink?.state ?? 0] ?? STATE_MAP[0];

  return (
    <div className="protocol-page">
      {contextHolder}

      {currentView === 'config' ? (
        <div className="protocol-config-view">
          <div className="protocol-top-row">
            <ProtocolConnectionList
              title={'\u8fde\u63a5\u5217\u8868'}
              addButtonText={'\u65b0\u589e\u8fde\u63a5'}
              loading={loading}
              links={links}
              selectedConn={selectedConn}
              onSelect={setSelectedConn}
              onCreate={openCreateLink}
              onCopy={(connName) => void handleCopyLink(connName)}
              onDelete={(connName) => void handleDeleteLink(connName)}
              onRefresh={() => void refreshLinks()}
              getStateColor={(item) => LIST_STATE_COLOR_MAP[item.state] ?? '#8c8c8c'}
              getDeleteTitle={(connName) => `\u786e\u8ba4\u5220\u9664 ${connName}\uff1f`}
            />

            <Card
              title="连接配置"
              size="small"
              bordered
              style={{ flex: 1, height: '100%' }}
              extra={
                selectedLink && (
                  <Button type="link" size="small" icon={<EditOutlined />} onClick={openEditLink}>
                    编辑
                  </Button>
                )
              }
            >
              {selectedLink?.config ? (
                <Descriptions size="small" column={2}>
                  <Descriptions.Item label="传输角色 (role)">
                    {ROLE_LABELS[selectedLink.config.role] ?? selectedLink.config.role}
                  </Descriptions.Item>
                  <Descriptions.Item label="站点角色 (station_role)">
                    {STATION_ROLE_LABELS[selectedLink.config.station_role] ?? selectedLink.config.station_role}
                  </Descriptions.Item>
                  <Descriptions.Item label="公共地址 (ca)">
                    {selectedLink.config.ca}
                  </Descriptions.Item>
                  {selectedLink.config.role !== ROLE_CLIENT && (
                    <Descriptions.Item label="本地端点 (local)">
                      {formatEndpoint(selectedLink.config.local)}
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label="源地址 (oa)">
                    {selectedLink.config.oa}
                  </Descriptions.Item>
                  {selectedLink.config.role !== ROLE_SERVER && (
                    <Descriptions.Item label="远程端点 (remote)">
                      {formatEndpoint(selectedLink.config.remote)}
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label="APCI 参数">
                    {formatApci(selectedLink.config.apci)}
                  </Descriptions.Item>
                  <Descriptions.Item label="对时标签">
                    {selectedLink.config.time_sync_tag || '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="带时标 (point_with_time)">
                    {selectedLink.config.point_with_time ? 'true' : 'false'}
                  </Descriptions.Item>
                </Descriptions>
              ) : (
                <Text type="secondary">请选择连接</Text>
              )}
            </Card>

            <div className="protocol-side-column">
              <Card title="运行状态" size="small" bordered>
                <Space direction="vertical" style={{ width: '100%' }}>
                  <div>
                    <Text type="secondary" style={{ marginRight: 12 }}>当前状态</Text>
                    <Tag color={stateInfo.color}>{stateInfo.label}</Tag>
                  </div>
                  <div>
                    <Text type="secondary" style={{ marginRight: 12 }}>最近错误</Text>
                    <Text>{selectedLink?.last_error || 'None'}</Text>
                  </div>
                </Space>
              </Card>

              <Card title="运行操作" size="small" bordered>
                <Space wrap>
                  <Button
                    type="primary"
                    icon={<LinkOutlined />}
                    style={{ background: '#4caf50', borderColor: '#4caf50' }}
                    disabled={!selectedConn}
                    onClick={() => void handleStartLink()}
                  >
                    连接
                  </Button>
                  <Popconfirm
                    title="确认断开连接？"
                    onConfirm={() => void handleStopLink()}
                    disabled={!selectedConn}
                  >
                    <Button
                      danger
                      icon={<DisconnectOutlined />}
                      disabled={!selectedConn}
                    >
                      断开
                    </Button>
                  </Popconfirm>
                  <Button
                    icon={<ClockCircleOutlined />}
                    disabled={!selectedConn}
                    onClick={() => void handleTimeSync()}
                  >
                    手工对时
                  </Button>
                  <Tooltip title="暂不支持">
                    <Button icon={<ThunderboltOutlined />} disabled>
                      总召唤
                    </Button>
                  </Tooltip>
                </Space>
              </Card>
            </div>
          </div>

          <Card
            title="点表配置 (Tag ↔ IOA)"
            size="small"
            bordered
            className="protocol-point-card"
            extra={
              <Space>
                <Popconfirm
                  title="确认删除全部点位？"
                  description={`当前连接的 ${points.length} 个点位将被清空`}
                  onConfirm={() => void handleDeleteAllPoints()}
                  disabled={!selectedConn || points.length === 0}
                >
                  <Button
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    disabled={!selectedConn || points.length === 0}
                  >
                    删除全部点位
                  </Button>
                </Popconfirm>
                <Button size="small" disabled={!selectedConn} onClick={openImportPointModal}>
                  从现有点位添加
                </Button>
                <Button
                  type="primary"
                  size="small"
                  icon={<PlusOutlined />}
                  disabled={!selectedConn}
                  onClick={openCreatePoint}
                >
                  添加点位
                </Button>
              </Space>
            }
          >
            <div className="protocol-table-scroll">
              <Table
                rowKey={(_, index) => String(index)}
                columns={pointColumns}
                dataSource={points}
                loading={realtimeLoading}
                pagination={false}
                size="small"
                scroll={{ x: 1040 }}
                locale={{ emptyText: selectedConn ? '暂无点位数据' : '请先选择连接' }}
              />
            </div>
          </Card>
        </div>
      ) : (
        <Card title="报文日志" size="small" bordered className="protocol-log-card">
          <div className="protocol-log-scroll">
            <div className="protocol-log-console">
              <div>
                <span style={{ color: '#007acc' }}>[TX]</span>
                {' '}
                --:--:--.--- - 报文日志 — 接入实时数据后渲染
              </div>
              <div className="protocol-log-line--hint">
                等待链路启动后显示 APDU 报文收发记录...
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Link Modal */}
      <Modal
        title={editingLink ? '编辑连接' : '新增连接'}
        open={linkModalOpen}
        onOk={() => void handleLinkSubmit()}
        onCancel={() => setLinkModalOpen(false)}
        width={680}
        destroyOnClose
      >
        <Form
          form={linkForm}
          layout="vertical"
          size="small"
          autoComplete="off"
          onValuesChange={handleLinkFormValuesChange}
        >
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="conn_name"
                label="连接名称"
                rules={[{ required: true, message: '请输入连接名称' }]}
              >
                <Input placeholder="conn_104_master" autoComplete="off" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="role" label="传输角色 (role)">
                <Select
                  options={[
                    { value: 0, label: 'UNSPECIFIED' },
                    { value: 1, label: 'SERVER' },
                    { value: 2, label: 'CLIENT' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="station_role" label="站点角色 (station_role)">
                <Select
                  options={[
                    { value: 0, label: 'UNSPECIFIED (按 role 默认)' },
                    { value: 1, label: 'MASTER (控制站)' },
                    { value: 2, label: 'SLAVE (被控站)' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="ca" label="公共地址 (ca)">
                <InputNumber min={0} max={65534} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="oa" label="源地址 (oa)">
                <InputNumber min={0} max={255} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="time_sync_tag" label="对时标签">
                <Input placeholder="sys_time" />
              </Form.Item>
            </Col>
          </Row>

          <Text type="secondary" style={{ display: 'block', margin: '8px 0 4px' }}>端点配置</Text>
          <Row gutter={16}>
            <Col span={endpointIpSpan} style={{ display: showLocalEndpointFields ? undefined : 'none' }}>
              <Form.Item
                name="local_ip"
                label="本地 IP"
                normalize={normalizeIpInput}
                rules={[{ validator: validateOptionalIpv4 }]}
              >
                <Input placeholder="0.0.0.0" />
              </Form.Item>
            </Col>
            <Col span={endpointPortSpan} style={{ display: showLocalEndpointFields ? undefined : 'none' }}>
              <Form.Item name="local_port" label="端口">
                <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="2404" />
              </Form.Item>
            </Col>
            <Col span={endpointIpSpan} style={{ display: showRemoteEndpointFields ? undefined : 'none' }}>
              <Form.Item
                name="remote_ip"
                label="远程 IP"
                normalize={normalizeIpInput}
                rules={[{ validator: validateOptionalIpv4 }]}
              >
                <Input placeholder="192.168.1.100" />
              </Form.Item>
            </Col>
            <Col span={endpointPortSpan} style={{ display: showRemoteEndpointFields ? undefined : 'none' }}>
              <Form.Item name="remote_port" label="端口">
                <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="2404" />
              </Form.Item>
            </Col>
          </Row>

          <Text type="secondary" style={{ display: 'block', margin: '8px 0 4px' }}>APCI 参数</Text>
          <Row gutter={16}>
            <Col span={4}>
              <Form.Item name="k" label="k">
                <InputNumber min={1} max={32767} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="w" label="w">
                <InputNumber min={1} max={32767} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="t0" label="t0 (s)">
                <InputNumber min={1} max={255} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="t1" label="t1 (s)">
                <InputNumber min={1} max={255} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="t2" label="t2 (s)">
                <InputNumber min={1} max={255} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="t3" label="t3 (s)">
                <InputNumber min={1} max={255} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Text type="secondary" style={{ display: 'block', margin: '8px 0 4px' }}>点位设置</Text>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="point_batch_window_ms" label="批量窗口 (ms)">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="point_max_asdu_bytes" label="最大 ASDU 字节">
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="point_use_standard_limit" label="标准限值" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="point_with_time" label="带时标" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="point_dedupe" label="去重">
                <Select
                  allowClear
                  placeholder="默认"
                  options={[
                    { value: true, label: '是' },
                    { value: false, label: '否' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* Point Modal */}
      <Modal
        title={editingPointIndex !== null ? '编辑点位' : '添加点位'}
        open={pointModalOpen}
        onOk={() => void handlePointSubmit()}
        onCancel={() => setPointModalOpen(false)}
        width={680}
        destroyOnClose
      >
        <Form form={pointForm} layout="vertical" size="small">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="tag"
                label="Tag (标签)"
                rules={[{ required: true, message: '请输入标签名' }]}
              >
                <Input placeholder="p_meas_1" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="ioa_category"
                label="IOA 类型"
              >
                <Select
                  options={IOA_CATEGORY_OPTIONS}
                  placeholder="选择 IOA 类型"
                  onChange={(nextValue) => handlePointIoaCategoryChange(nextValue as IoaCategoryKey)}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="ioa"
                label="IOA (信息体地址)"
                rules={[{ required: true, message: '请输入 IOA' }]}
              >
                <InputNumber
                  min={0}
                  max={MAX_IOA}
                  style={{ width: '100%' }}
                  onChange={handlePointIoaChange}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="point_type"
                label="类型 (Type)"
                rules={[{ required: true, message: '请选择类型' }]}
              >
                <Select
                  options={Object.entries(POINT_TYPE_LABELS).map(([k, v]) => ({
                    value: Number(k),
                    label: v,
                  }))}
                  placeholder="选择类型"
                />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="scale" label="Scale">
                <InputNumber step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="offset" label="Offset">
                <InputNumber step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="deadband" label="Deadband">
                <InputNumber step={0.01} min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title="从现有点位添加"
        open={importPointModalOpen}
        onOk={() => void handleImportPointsSubmit()}
        onCancel={() => setImportPointModalOpen(false)}
        width={1100}
        destroyOnClose
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Text type="secondary">
            从数据总线已注册的连接标签中选择点位导入到当前 IEC104 点表。
            导入时会默认按“模块_连接_tag”生成新标签，避免直接复用来源点位的 tag；
            你仍然可以在下方表格里继续修改。
          </Text>

          <Row gutter={16}>
            <Col span={8}>
              <div>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                  来源连接
                </Text>
                <Select
                  allowClear
                  showSearch
                  style={{ width: '100%' }}
                  placeholder="先选择来源连接"
                  options={dataBusConnectionOptions}
                  value={importSourceConnId}
                  loading={dataBusEndpointLoading}
                  notFoundContent="暂无可选连接"
                  onChange={handleImportSourceConnChange}
                  filterOption={(input, option) =>
                    String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
              </div>
            </Col>
            <Col span={16}>
              <div>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                  来源点位
                </Text>
                <Select
                  mode="multiple"
                  allowClear
                  showSearch
                  style={{ width: '100%' }}
                  placeholder={importSourceConnId ? '选择一个或多个来源点位' : '请先选择来源连接'}
                  options={importSourceEndpointOptions}
                  optionLabelProp="selectedLabel"
                  maxTagCount={1}
                  maxTagPlaceholder={(omittedValues) => `+ ${omittedValues.length} 个点位`}
                  value={selectedImportEndpointValues}
                  loading={dataBusEndpointLoading}
                  disabled={!importSourceConnId}
                  notFoundContent={importSourceConnId ? '该连接暂无可导入点位' : '请先选择来源连接'}
                  onChange={handleSelectImportEndpoints}
                  filterOption={(input, option) =>
                    String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
                <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                  已选 {importPointDrafts.length} 个点位，可在下方表格继续修改或删除。
                </Text>
              </div>
            </Col>
          </Row>

          <div className="protocol-table-scroll">
            <Table
              rowKey="key"
              columns={importPointColumns}
              dataSource={importPointDrafts}
              pagination={false}
              size="small"
              scroll={{ x: 1460, y: 360 }}
              locale={{
                emptyText: importSourceConnId ? '请选择需要导入的来源点位' : '请先选择来源连接',
              }}
            />
          </div>
        </Space>
      </Modal>
    </div>
  );
};

export default IEC104;
