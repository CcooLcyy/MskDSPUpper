import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Segmented,
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
  CopyOutlined,
  ClearOutlined,
  UploadOutlined,
  ThunderboltOutlined,
  FilterOutlined,
  SearchOutlined,
  HolderOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../adapters';
import ProtocolConnectionList from '../../components/protocol/ProtocolConnectionList';
import ResizableSplit from '../../components/layout/ResizableSplit';
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
import {
  RuntimeRestartError,
  formatErrorText,
  runWithRuntimeRestart,
} from '../../utils/runtime-restart';
import type {
  DcConnectionInfo,
  DcEndpoint,
  Iec104LinkConfig,
  Iec104LinkInfo,
  Iec104Point,
} from '../../adapters';
import {
  ImportedPointRoutesError,
  buildImportedPointRoutes,
  saveImportedPointsWithOptionalRoutes,
} from './import-routing';

const { Text } = Typography;

// ── Constants ──

const ROLE_LABELS: Record<number, string> = {
  0: 'UNSPECIFIED',
  1: 'SERVER',
  2: 'CLIENT',
};

const ROLE_SERVER = 1;
const ROLE_CLIENT = 2;
const STATION_ROLE_MASTER = 1;
const IEC104_MODULE_NAME = 'IEC104';
const DEFAULT_SERVER_LOCAL_IP = '0.0.0.0';
const DEFAULT_IEC104_PORT = 2404;
const IP_ADDRESS_ERROR_MESSAGE = '请输入合法的 IPv4 地址';

const STATION_ROLE_LABELS: Record<number, string> = {
  0: 'UNSPECIFIED (按 role 默认)',
  1: 'MASTER (控制站)',
  2: 'SLAVE (被控站)',
};

const STATE_MAP: Record<number, { label: string; color: string }> = {
  0: { label: '未知', color: 'default' },
  1: { label: '已停止', color: 'default' },
  2: { label: '运行中', color: 'success' },
  3: { label: '待删除', color: 'warning' },
};

const LIST_STATE_COLOR_MAP: Record<number, string> = {
  0: '#8c8c8c',
  1: '#8c8c8c',
  2: '#4caf50',
  3: '#ff9800',
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
  sourceEndpoint: DcEndpoint;
  ioa_category: IoaCategoryKey;
};

type IoaAdjustmentStrategy = 'offset' | 'sequence' | 'manual';

const POINT_DRAFT_DRAG_PREFIX = 'mskdsp-iec104-point:';

const setPointDraftDragData = (event: React.DragEvent<HTMLElement>, key: string): void => {
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', `${POINT_DRAFT_DRAG_PREFIX}${key}`);
};

const getPointDraftDragKey = (event: React.DragEvent<HTMLElement>, fallback: string | null): string | null => {
  const value = event.dataTransfer.getData('text/plain');
  return value.startsWith(POINT_DRAFT_DRAG_PREFIX)
    ? value.slice(POINT_DRAFT_DRAG_PREFIX.length)
    : fallback;
};

type IoaAdjustmentDraft = {
  key: string;
  tag: string;
  pointType: number;
  originalIoa: number;
  ioa: number;
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
  const maxUsed = usedIoas.size > 0 ? Math.max(...usedIoas) : 0;
  if (maxUsed < MAX_IOA) {
    return maxUsed + 1;
  }

  for (let candidate = 1; candidate <= MAX_IOA; candidate += 1) {
    if (!usedIoas.has(candidate)) {
      return candidate;
    }
  }

  return MAX_IOA;
};

const allocateSequentialIoas = ({
  count,
  occupiedIoas,
  start,
  step,
  skipOccupied,
}: {
  count: number;
  occupiedIoas: Set<number>;
  start: number;
  step: number;
  skipOccupied: boolean;
}) => {
  const result: number[] = [];
  const reserved = new Set(occupiedIoas);
  const normalizedStart = Math.max(1, Math.min(MAX_IOA, Math.trunc(start)));
  const normalizedStep = Math.max(1, Math.trunc(step));
  let candidate = normalizedStart;

  for (let index = 0; index < count; index += 1) {
    if (skipOccupied) {
      while (candidate <= MAX_IOA && reserved.has(candidate)) {
        candidate += normalizedStep;
      }
    }

    result.push(candidate);
    reserved.add(candidate);
    candidate += normalizedStep;
  }

  return result;
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
  return {
    ...DEFAULT_POINT_FORM_VALUES,
    ioa_category: 'custom' as IoaCategoryKey,
    ioa: getNextAvailableIoa(new Set(points.map((point) => point.ioa))),
    point_type: points[points.length - 1]?.point_type ?? 1,
  };
};

const formatIoaHex = (ioa: number): string =>
  `0x${ioa.toString(16).toUpperCase().padStart(6, '0')}`;

const formatIoaDual = (ioa: number): string => `${ioa} (${formatIoaHex(ioa)})`;

const formatIoaInputValue = (value: number | string | null | undefined, inputHex: boolean): string => {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return '';
  }
  const integer = Math.trunc(numericValue);
  if (!inputHex) {
    return String(integer);
  }
  const sign = integer < 0 ? '-' : '';
  return `${sign}0x${Math.abs(integer).toString(16).toUpperCase()}`;
};

const parseIoaInputValue = (value: string | undefined, inputHex: boolean): number | null => {
  const text = value?.trim() ?? '';
  if (!text) {
    return null;
  }

  const explicitHex = /^[-+]?0x[0-9a-f]+$/i.test(text) || /^[-+]?[0-9a-f]+h$/i.test(text);
  const explicitDecimal = /^[-+]?0d\d+$/i.test(text);
  const normalized = explicitHex
    ? text.replace(/^([+-]?)0x/i, '$1').replace(/h$/i, '')
    : explicitDecimal
      ? text.replace(/^([+-]?)0d/i, '$1')
      : text;
  const radix = explicitHex || (!explicitDecimal && inputHex) ? 16 : 10;
  const pattern = radix === 16 ? /^[+-]?[0-9a-f]+$/i : /^[+-]?\d+$/;
  if (!pattern.test(normalized)) {
    return null;
  }

  const parsed = Number.parseInt(normalized, radix);
  return Number.isFinite(parsed) ? parsed : null;
};

type IoaInputProps = {
  value?: number | null;
  inputHex: boolean;
  onChange?: (value: number | null) => void;
  disabled?: boolean;
  status?: 'error' | 'warning';
  size?: 'small' | 'middle' | 'large';
  style?: React.CSSProperties;
  min?: number;
  max?: number;
  precision?: number;
};

const IoaInput: React.FC<IoaInputProps> = ({
  value,
  inputHex,
  onChange,
  disabled,
  status,
  size,
  style,
  min,
  max,
  precision,
}) => {
  return (
    <InputNumber
      value={value}
      size={size}
      status={status}
      disabled={disabled}
      style={style}
      min={min}
      max={max}
      precision={precision}
      formatter={(nextValue, info) => info.userTyping
        ? info.input
        : formatIoaInputValue(nextValue as number | string | undefined, inputHex)}
      parser={(text) => parseIoaInputValue(text, inputHex) ?? Number.NaN}
      onChange={onChange}
    />
  );
};

const formatEndpoint = (ep: { ip: string; port: number } | null): string =>
  ep ? `${ep.ip}:${ep.port}` : '-';

const formatApci = (apci: { k: number; w: number; t0: number; t1: number; t2: number; t3: number } | null): string =>
  apci ? `k:${apci.k}, w:${apci.w}, t0:${apci.t0}, t1:${apci.t1}, t2:${apci.t2}, t3:${apci.t3}` : '-';

const isMasterStationConfig = (config: Iec104LinkConfig | null | undefined): boolean =>
  Boolean(
    config && (
      config.station_role === STATION_ROLE_MASTER
      || (config.station_role === 0 && config.role === ROLE_CLIENT)
    ),
  );

// ── Component ──

const IEC104: React.FC = () => {
  const [links, setLinks] = useState<Iec104LinkInfo[]>([]);
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [points, setPoints] = useState<Iec104Point[]>([]);
  const [pointTypeFilter, setPointTypeFilter] = useState<number>();
  const [pointSearch, setPointSearch] = useState('');
  const [pointTableView, setPointTableView] = useState<'config' | 'runtime'>('config');
  const [ioaInputHex, setIoaInputHex] = useState(false);
  const [selectedPointTags, setSelectedPointTags] = useState<string[]>([]);
  const [ioaAdjustModalOpen, setIoaAdjustModalOpen] = useState(false);
  const [ioaAdjustDrafts, setIoaAdjustDrafts] = useState<IoaAdjustmentDraft[]>([]);
  const [ioaAdjustStrategy, setIoaAdjustStrategy] = useState<IoaAdjustmentStrategy>('offset');
  const [ioaAdjustStart, setIoaAdjustStart] = useState(1);
  const [ioaAdjustStep, setIoaAdjustStep] = useState(1);
  const [ioaAdjustOffset, setIoaAdjustOffset] = useState(0);
  const [ioaAdjustSkipOccupied, setIoaAdjustSkipOccupied] = useState(true);
  const [ioaAdjustDragKey, setIoaAdjustDragKey] = useState<string | null>(null);
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pointsLoading, setPointsLoading] = useState(false);
  const [pointSubmitting, setPointSubmitting] = useState(false);
  const [importSubmitting, setImportSubmitting] = useState(false);
  const [runtimeAction, setRuntimeAction] = useState<'start' | 'stop' | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
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
  const [importBatchType, setImportBatchType] = useState<number>();
  const [importBatchCategory, setImportBatchCategory] = useState<IoaCategoryKey>();
  const [importAllocationStart, setImportAllocationStart] = useState(1);
  const [importAllocationStep, setImportAllocationStep] = useState(1);
  const [importAllocationSkipOccupied, setImportAllocationSkipOccupied] = useState(true);
  const [importDragKey, setImportDragKey] = useState<string | null>(null);
  const [createImportRoutes, setCreateImportRoutes] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [searchParams] = useSearchParams();
  const pointLoadRequestRef = useRef(0);

  const [linkForm] = Form.useForm();
  const [pointForm] = Form.useForm();
  const linkRole = Form.useWatch('role', linkForm);
  const pointIoaCategory = Form.useWatch('ioa_category', pointForm) as IoaCategoryKey | undefined;
  const pointType = Form.useWatch('point_type', pointForm);
  const pointTag = Form.useWatch('tag', pointForm);
  const pointIoa = Form.useWatch('ioa', pointForm);

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
  const {
    realtimeByTag,
    realtimeRevisionByTag,
    loading: realtimeLoading,
    error: realtimeError,
  } = useProtocolShadowRealtime(
    selectedLink?.conn_id ?? null,
    realtimeTags,
  );
  const visiblePoints = useMemo(
    () => {
      const normalizedSearch = pointSearch.trim().toLocaleLowerCase();
      return points.filter((point) => (
        (pointTypeFilter === undefined || point.point_type === pointTypeFilter)
        && (
          normalizedSearch.length === 0
          || point.tag.toLocaleLowerCase().includes(normalizedSearch)
          || String(point.ioa).includes(normalizedSearch)
          || formatIoaHex(point.ioa).toLocaleLowerCase().includes(normalizedSearch)
        )
      ));
    },
    [pointSearch, pointTypeFilter, points],
  );
  const hasPointFilters = Boolean(pointSearch.trim() || pointTypeFilter !== undefined);
  const pointFilterCount = Number(Boolean(pointSearch.trim())) + Number(pointTypeFilter !== undefined);
  const clearPointFilters = useCallback(() => {
    setPointSearch('');
    setPointTypeFilter(undefined);
  }, []);
  const actionsDisabled = pointsLoading
    || pointSubmitting
    || importSubmitting
    || runtimeAction !== null
    || linkModalOpen
    || pointModalOpen
    || importPointModalOpen
    || ioaAdjustModalOpen;
  const isSinglePoint = pointType === 2;
  const pointIoaRange = getIoaCategoryRange(pointIoaCategory ?? 'custom');
  const pointTagTrimmed = typeof pointTag === 'string' ? pointTag.trim() : '';
  const pointTagDuplicate = pointTagTrimmed.length > 0 && points.some(
    (point, index) => index !== editingPointIndex && point.tag.trim() === pointTagTrimmed,
  );
  const pointIoaDuplicate = typeof pointIoa === 'number' && points.some(
    (point, index) => index !== editingPointIndex && point.ioa === pointIoa,
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
  const importRoutesTriggerCommands = createImportRoutes && isMasterStationConfig(selectedLink?.config);
  const importValidation = useMemo(() => {
    const cellIssues = new Map<string, string[]>();
    const rowIssues = new Map<string, string[]>();
    const existingTags = new Set(points.map((point) => point.tag.trim()));
    const reservedTags = new Set(importReservedTagSet);
    const draftTags = new Map<string, string[]>();
    const draftIoas = new Map<number, string[]>();

    const addIssue = (key: string, field: string, issue: string): void => {
      const cellKey = `${key}:${field}`;
      cellIssues.set(cellKey, [...(cellIssues.get(cellKey) ?? []), issue]);
      rowIssues.set(key, [...(rowIssues.get(key) ?? []), issue]);
    };

    importPointDrafts.forEach((draft) => {
      const tag = draft.tag.trim();
      if (!tag) addIssue(draft.key, 'tag', '标签不能为空');
      if (tag.length > 128) addIssue(draft.key, 'tag', '标签不能超过 128 个字符');
      if (existingTags.has(tag)) addIssue(draft.key, 'tag', '标签已存在于当前连接');
      if (reservedTags.has(tag) && !existingTags.has(tag)) addIssue(draft.key, 'tag', '标签已被其他连接占用');
      if (tag) draftTags.set(tag, [...(draftTags.get(tag) ?? []), draft.key]);

      if (!Number.isInteger(draft.ioa) || draft.ioa < 1 || draft.ioa > MAX_IOA) {
        addIssue(draft.key, 'ioa', `IOA 必须为 1 - ${MAX_IOA} 的整数`);
      }
      if (Number.isInteger(draft.ioa)) {
        draftIoas.set(draft.ioa, [...(draftIoas.get(draft.ioa) ?? []), draft.key]);
      }
      if (!POINT_TYPE_LABELS[draft.point_type]) addIssue(draft.key, 'point_type', '请选择有效的点位类型');
      if (!Number.isFinite(draft.scale)) addIssue(draft.key, 'scale', 'Scale 必须是有效数字');
      if (!Number.isFinite(draft.offset)) addIssue(draft.key, 'offset', 'Offset 必须是有效数字');
      if (!Number.isFinite(draft.deadband) || draft.deadband < 0) addIssue(draft.key, 'deadband', 'Deadband 必须大于等于 0');
    });

    draftTags.forEach((keys) => {
      if (keys.length > 1) keys.forEach((key) => addIssue(key, 'tag', '导入草稿中存在重复标签'));
    });
    draftIoas.forEach((keys, ioa) => {
      if (keys.length > 1 || points.some((point) => point.ioa === ioa)) {
        keys.forEach((key) => addIssue(key, 'ioa', '导入草稿中存在重复 IOA'));
      }
    });

    return {
      cellIssues,
      rowIssues,
      errorCount: Array.from(rowIssues.values()).reduce((count, issues) => count + issues.length, 0),
    };
  }, [importPointDrafts, importReservedTagSet, points]);

  // ── Data Loading ──

  const refreshLinks = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const list = (await api.iec104ListLinks()).sort((left, right) => {
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

  const loadPoints = useCallback(
    async (connName: string) => {
      const requestId = pointLoadRequestRef.current + 1;
      pointLoadRequestRef.current = requestId;
      setPoints([]);
      setPointsLoading(true);
      try {
        const pt = await api.iec104GetPointTable(connName);
        if (requestId !== pointLoadRequestRef.current) {
          return;
        }
        setPoints(pt.points);
      } catch (error) {
        if (requestId !== pointLoadRequestRef.current) {
          return;
        }
        setPoints([]);
        messageApi.error(`加载 IEC104 点表失败: ${error}`);
      } finally {
        if (requestId === pointLoadRequestRef.current) {
          setPointsLoading(false);
        }
      }
    },
    [messageApi],
  );

  const getLinkState = useCallback(
    async (connName: string): Promise<number | null> => {
      const link = await api.iec104GetLink(connName);
      return link.state;
    },
    [],
  );

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
        failOnRestartError?: boolean;
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
        stop: () => api.iec104StopLink(originalConnName),
        run: operation,
        start: () => api.iec104StartLink(restartConnName),
        restoreStart: () => api.iec104StartLink(originalConnName),
        failOnRestartError: options?.failOnRestartError ?? false,
      });
    },
    [getLinkState, selectedConn, selectedLink?.state],
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
      pointLoadRequestRef.current += 1;
      setPoints([]);
      setPointsLoading(false);
    }
  }, [selectedConn, loadPoints]);

  useEffect(() => {
    setSelectedPointTags((current) => current.filter((tag) => points.some((point) => point.tag === tag)));
  }, [points]);

  useEffect(() => {
    if (pointType === 2) {
      pointForm.setFieldsValue(DEFAULT_POINT_FORM_VALUES);
    }
  }, [pointForm, pointType]);

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

      const saveLink = async () => {
        if (renamed && oldConnName) {
          await api.iec104RenameLink(oldConnName, config.conn_name);
          renameCompleted = true;
        }

        await api.iec104UpsertLink(config, createOnly);
      };
      const restartResult = createOnly
        ? await runWithRuntimeRestart({
          initialState: null,
          stop: () => api.iec104StopLink(config.conn_name),
          run: saveLink,
          start: () => api.iec104StartLink(config.conn_name),
          failOnRestartError: false,
        })
        : await runSelectedLinkStopped(saveLink, {
          originalConnName: oldConnName ?? config.conn_name,
          restartConnName: config.conn_name,
        });
      if (restartResult.restartError) {
        messageApi.warning(`链路配置已保存，但重新启动失败: ${formatErrorText(restartResult.restartError)}`);
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success(renamed ? '链路已改名、更新并重新启动成功' : '链路已更新并重新启动成功');
      } else {
        messageApi.success(createOnly ? '链路创建成功' : renamed ? '链路已改名并更新成功' : '链路更新成功');
      }
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
  }, [linkForm, editingLink, messageApi, refreshLinks, runSelectedLinkStopped]);

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
    if (!selectedConn || selectedLink?.state !== 1 || runtimeAction !== null) return;
    setRuntimeAction('start');
    try {
      await api.iec104StartLink(selectedConn);
      const reached = await waitForLinkState(selectedConn, 2);
      await refreshLinks({ silent: true });
      messageApi[reached ? 'success' : 'warning'](reached ? '连接已建立' : '连接请求已发送，状态仍在确认中');
    } catch (e) {
      messageApi.error(`连接失败: ${e}`);
    } finally {
      setRuntimeAction(null);
    }
  }, [messageApi, refreshLinks, runtimeAction, selectedConn, selectedLink?.state, waitForLinkState]);

  const handleStopLink = useCallback(async () => {
    if (!selectedConn || selectedLink?.state !== 2 || runtimeAction !== null) return;
    setRuntimeAction('stop');
    try {
      await api.iec104StopLink(selectedConn);
      const reached = await waitForLinkState(selectedConn, 1);
      await refreshLinks({ silent: true });
      messageApi[reached ? 'success' : 'warning'](reached ? '连接已断开' : '断开请求已发送，状态仍在确认中');
    } catch (e) {
      messageApi.error(`断开失败: ${e}`);
    } finally {
      setRuntimeAction(null);
    }
  }, [messageApi, refreshLinks, runtimeAction, selectedConn, selectedLink?.state, waitForLinkState]);

  const handleTimeSync = useCallback(async () => {
    if (!selectedConn || actionsDisabled) return;
    try {
      await api.iec104SendTimeSync(selectedConn, Date.now());
      messageApi.success('对时命令已发送');
    } catch (e) {
      messageApi.error(`对时失败: ${e}`);
    }
  }, [actionsDisabled, selectedConn, messageApi]);

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
    setImportBatchType(undefined);
    setImportBatchCategory(undefined);
    setImportAllocationStart(getNextAvailableIoa(new Set(points.map((point) => point.ioa))));
    setImportAllocationStep(1);
    setImportAllocationSkipOccupied(true);
    setImportDragKey(null);
    setCreateImportRoutes(false);
    setImportPointModalOpen(true);
    void refreshDataBusEndpointOptions();
  }, [points, refreshDataBusEndpointOptions]);

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

  const reorderImportDrafts = useCallback((fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setImportPointDrafts((current) => {
      const fromIndex = current.findIndex((item) => item.key === fromKey);
      const toIndex = current.findIndex((item) => item.key === toKey);
      if (fromIndex < 0 || toIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const applyImportIoaAllocation = useCallback(() => {
    if (importPointDrafts.length === 0) return;
    const categoryRange = importBatchCategory ? getIoaCategoryRange(importBatchCategory) : null;
    const start = categoryRange
      ? Math.max(importAllocationStart, categoryRange.start)
      : importAllocationStart;
    const ioas = allocateSequentialIoas({
      count: importPointDrafts.length,
      occupiedIoas: new Set(points.map((point) => point.ioa)),
      start,
      step: importAllocationStep,
      skipOccupied: importAllocationSkipOccupied,
    });

    setImportPointDrafts((current) => current.map((item, index) => ({
      ...item,
      ioa: ioas[index] ?? item.ioa,
      ioa_category: importBatchCategory ?? getIoaCategoryByIoa(ioas[index] ?? item.ioa),
    })));
  }, [importAllocationSkipOccupied, importAllocationStart, importAllocationStep, importBatchCategory, importPointDrafts.length, points]);

  const openIoaAdjustModal = useCallback(() => {
    if (selectedPointTags.length === 0) {
      messageApi.info('请先在点表中勾选需要调整 IOA 的点位');
      return;
    }
    const selected = selectedPointTags
      .map((tag) => points.find((point) => point.tag === tag))
      .filter((point): point is Iec104Point => Boolean(point));
    if (selected.length === 0) return;
    const selectedKeys = new Set(selected.map((point) => point.tag));
    const occupiedIoas = new Set(
      points.filter((point) => !selectedKeys.has(point.tag)).map((point) => point.ioa),
    );
    const allocatedIoas = allocateSequentialIoas({
      count: selected.length,
      occupiedIoas,
      start: selected[0].ioa,
      step: 1,
      skipOccupied: true,
    });
    setIoaAdjustDrafts(selected.map((point, index) => ({
      key: point.tag,
      tag: point.tag,
      pointType: point.point_type,
      originalIoa: point.ioa,
      ioa: allocatedIoas[index] ?? point.ioa,
    })));
    setIoaAdjustStrategy('sequence');
    setIoaAdjustStart(selected[0].ioa);
    setIoaAdjustStep(1);
    setIoaAdjustOffset(0);
    setIoaAdjustSkipOccupied(true);
    setIoaAdjustDragKey(null);
    setIoaAdjustModalOpen(true);
  }, [messageApi, points, selectedPointTags]);

  const reorderIoaAdjustDrafts = useCallback((fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setIoaAdjustDrafts((current) => {
      const fromIndex = current.findIndex((item) => item.key === fromKey);
      const toIndex = current.findIndex((item) => item.key === toKey);
      if (fromIndex < 0 || toIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const recalculateIoaAdjustDrafts = useCallback((
    strategy: IoaAdjustmentStrategy = ioaAdjustStrategy,
    options?: { start?: number; step?: number; offset?: number; skipOccupied?: boolean },
  ) => {
    setIoaAdjustDrafts((current) => {
      if (strategy === 'manual') return current;

      if (strategy === 'offset') {
        const offset = options?.offset ?? ioaAdjustOffset;
        return current.map((item) => ({
          ...item,
          ioa: item.originalIoa + offset,
        }));
      }

      const selectedKeys = new Set(current.map((item) => item.key));
      const occupiedIoas = new Set(
        points.filter((point) => !selectedKeys.has(point.tag)).map((point) => point.ioa),
      );
      const ioas = allocateSequentialIoas({
        count: current.length,
        occupiedIoas,
        start: options?.start ?? ioaAdjustStart,
        step: options?.step ?? ioaAdjustStep,
        skipOccupied: options?.skipOccupied ?? ioaAdjustSkipOccupied,
      });
      return current.map((item, index) => ({ ...item, ioa: ioas[index] ?? item.ioa }));
    });
  }, [ioaAdjustOffset, ioaAdjustSkipOccupied, ioaAdjustStart, ioaAdjustStep, ioaAdjustStrategy, points]);

  const ioaAdjustValidation = useMemo(() => {
    const selectedKeys = new Set(ioaAdjustDrafts.map((item) => item.key));
    const occupiedIoas = new Set(
      points.filter((point) => !selectedKeys.has(point.tag)).map((point) => point.ioa),
    );
    const issues = new Map<string, string>();
    const seen = new Set<number>();
    ioaAdjustDrafts.forEach((item) => {
      if (!Number.isInteger(item.ioa) || item.ioa < 1 || item.ioa > MAX_IOA) {
        issues.set(item.key, `IOA 必须为 1 - ${MAX_IOA} 的整数`);
      } else if (occupiedIoas.has(item.ioa) || seen.has(item.ioa)) {
        issues.set(item.key, 'IOA 与其他未选中或选中点位冲突');
      }
      seen.add(item.ioa);
    });
    const changedCount = ioaAdjustDrafts.filter((item) => item.ioa !== item.originalIoa).length;
    return { issues, changedCount };
  }, [ioaAdjustDrafts, points]);

  const handleIoaAdjustSubmit = useCallback(async () => {
    if (!selectedConn || pointSubmitting || ioaAdjustDrafts.length === 0) return;
    if (ioaAdjustValidation.issues.size > 0) {
      messageApi.error(`请先修正 ${ioaAdjustValidation.issues.size} 个 IOA 冲突`);
      return;
    }
    if (ioaAdjustValidation.changedCount === 0) {
      messageApi.info('没有需要保存的 IOA 变化');
      return;
    }

    const ioaByTag = new Map(ioaAdjustDrafts.map((item) => [item.key, item.ioa]));
    const newPoints = points.map((point) => ({
      ...point,
      ioa: ioaByTag.get(point.tag) ?? point.ioa,
    }));
    setPointSubmitting(true);
    try {
      const restartResult = await runSelectedLinkStopped(() => api.iec104UpsertPointTable(selectedConn, newPoints, true));
      setPoints(newPoints);
      setIoaAdjustModalOpen(false);
      setSelectedPointTags([]);
      messageApi.success(`已调整 ${ioaAdjustValidation.changedCount} 个点位的 IOA`);
      if (restartResult.restartError) {
        messageApi.warning(`点表已保存，但重新启动失败: ${formatErrorText(restartResult.restartError)}`);
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success('点表已保存并重新启动链路');
      }
    } catch (error) {
      messageApi.error(`调整 IOA 失败: ${formatErrorText(error)}`);
    } finally {
      setPointSubmitting(false);
    }
  }, [ioaAdjustDrafts, ioaAdjustValidation, messageApi, pointSubmitting, points, runSelectedLinkStopped, selectedConn]);

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
      const normalizedValue = typeof nextValue === 'number' && Number.isFinite(nextValue) ? nextValue : undefined;
      pointForm.setFieldsValue({
        ioa: normalizedValue,
        ioa_category: getIoaCategoryByIoa(normalizedValue),
      });
    },
    [pointForm],
  );

  const handlePointSubmit = useCallback(async () => {
    if (!selectedConn || pointSubmitting) return;
    setPointSubmitting(true);
    try {
      const values = await pointForm.validateFields();
      const newPoint: Iec104Point = {
        tag: values.tag.trim(),
        ioa: values.ioa,
        point_type: values.point_type,
        scale: values.point_type === 2 ? DEFAULT_POINT_FORM_VALUES.scale : values.scale ?? 1,
        offset: values.point_type === 2 ? DEFAULT_POINT_FORM_VALUES.offset : values.offset ?? 0,
        deadband: values.point_type === 2 ? DEFAULT_POINT_FORM_VALUES.deadband : values.deadband ?? 0,
      };
      const duplicateTag = points.some((point, index) => index !== editingPointIndex && point.tag.trim() === newPoint.tag);
      const duplicateIoa = points.some((point, index) => index !== editingPointIndex && point.ioa === newPoint.ioa);
      if (duplicateTag) {
        messageApi.error(`标签 ${newPoint.tag} 已存在`);
        return;
      }
      if (duplicateIoa) {
        messageApi.error(`IOA ${newPoint.ioa} 已存在`);
        return;
      }
      let newPoints: Iec104Point[];
      if (editingPointIndex !== null) {
        newPoints = points.map((p, i) => (i === editingPointIndex ? newPoint : p));
      } else {
        newPoints = [...points, newPoint];
      }
      const restartResult = await runSelectedLinkStopped(() => api.iec104UpsertPointTable(selectedConn, newPoints, true));
      messageApi.success(editingPointIndex !== null ? '点位已更新' : '点位已添加');
      if (restartResult.restartError) {
        messageApi.warning(`点表已保存，但重新启动失败: ${formatErrorText(restartResult.restartError)}`);
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success('点表已保存并重新启动链路');
      }
      setPointModalOpen(false);
      setPoints(newPoints);
    } catch (e) {
      if (e && typeof e === 'object' && 'errorFields' in e) {
        return;
      }
      messageApi.error(`操作失败: ${e}`);
    } finally {
      setPointSubmitting(false);
    }
  }, [selectedConn, pointForm, editingPointIndex, points, messageApi, pointSubmitting, runSelectedLinkStopped]);

  const openCopyPoint = useCallback((index: number) => {
    if (!selectedConn || pointSubmitting) return;
    const source = points[index];
    if (!source) return;

    const usedIoas = new Set(points.map((point) => point.ioa));
    let ioa = source.ioa + 1;
    while (usedIoas.has(ioa) && ioa <= MAX_IOA) {
      ioa += 1;
    }
    if (ioa > MAX_IOA) {
      messageApi.error('没有可用的 IOA 地址');
      return;
    }

    setEditingPointIndex(null);
    pointForm.resetFields();
    pointForm.setFieldsValue({
      tag: source.tag,
      ioa,
      ioa_category: getIoaCategoryByIoa(ioa),
      point_type: source.point_type,
      scale: source.scale,
      offset: source.offset,
      deadband: source.deadband,
    });
    setPointModalOpen(true);
  }, [messageApi, pointForm, pointSubmitting, points, selectedConn]);

  useEffect(() => {
    if (!pointModalOpen || editingPointIndex !== null) {
      return;
    }
    const tag = pointForm.getFieldValue('tag');
    if (typeof tag === 'string' && tag.trim() && points.some((point) => point.tag.trim() === tag.trim())) {
      pointForm.setFields([{ name: 'tag', errors: ['该标签已存在'] }]);
    }
  }, [editingPointIndex, pointForm, pointModalOpen, points]);

  const handleDeletePoint = useCallback(
    async (index: number) => {
      if (!selectedConn || pointSubmitting) return;
      setPointSubmitting(true);
      try {
        const newPoints = points.filter((_p, i) => i !== index);
        const restartResult = await runSelectedLinkStopped(() => api.iec104UpsertPointTable(selectedConn, newPoints, true));
        messageApi.success('点位已删除');
        if (restartResult.restartError) {
          messageApi.warning(`点表已保存，但重新启动失败: ${formatErrorText(restartResult.restartError)}`);
        } else if (restartResult.stoppedBeforeRun) {
          messageApi.success('点表已保存并重新启动链路');
        }
        setPoints(newPoints);
      } catch (e) {
        messageApi.error(`删除失败: ${e}`);
      } finally {
        setPointSubmitting(false);
      }
    },
    [selectedConn, points, messageApi, pointSubmitting, runSelectedLinkStopped],
  );

  const handleDeleteAllPoints = useCallback(async () => {
    if (!selectedConn || pointSubmitting) return;
    setPointSubmitting(true);
    try {
      const restartResult = await runSelectedLinkStopped(() => api.iec104UpsertPointTable(selectedConn, [], true));
      setPoints([]);
      messageApi.success('全部点位已删除');
      if (restartResult.restartError) {
        messageApi.warning(`点表已保存，但重新启动失败: ${formatErrorText(restartResult.restartError)}`);
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success('点表已保存并重新启动链路');
      }
    } catch (e) {
      messageApi.error(`删除全部点位失败: ${e}`);
    } finally {
      setPointSubmitting(false);
    }
  }, [messageApi, pointSubmitting, selectedConn, runSelectedLinkStopped]);

  const handleImportSourceConnChange = useCallback((value: string | undefined) => {
    setImportSourceConnId(value);
    setSelectedImportEndpointValues([]);
    setImportPointDrafts([]);
    setImportBatchType(undefined);
    setImportBatchCategory(undefined);
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
            sourceEndpoint: {
              module_name: sourcePoint.moduleName,
              conn_name: sourcePoint.connName,
              tag: sourcePoint.tag,
              conn_id: sourcePoint.connId,
            },
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

  const applyImportBatchType = useCallback((nextType: number | undefined) => {
    setImportBatchType(nextType);
    if (nextType === undefined) {
      return;
    }
    setImportPointDrafts((prev) => prev.map((item) => ({
      ...item,
      point_type: nextType,
      ...(nextType === 2 ? DEFAULT_POINT_FORM_VALUES : {}),
    })));
  }, []);

  const applyImportBatchCategory = useCallback((nextCategory: IoaCategoryKey | undefined) => {
    setImportBatchCategory(nextCategory);
    if (!nextCategory) {
      return;
    }
    const range = getIoaCategoryRange(nextCategory);
    if (range) {
      setImportAllocationStart(range.start);
    }
    setImportPointDrafts((prev) => {
      const usedIoas = new Set(points.map((point) => point.ioa));
      return prev.map((item) => {
        const nextIoa = getSuggestedIoaByCategory(usedIoas, nextCategory, item.ioa);
        usedIoas.add(nextIoa);
        return {
          ...item,
          ioa_category: nextCategory,
          ioa: nextIoa,
        };
      });
    });
  }, [points]);

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
        ioa: typeof nextValue === 'number' && Number.isFinite(nextValue) ? nextValue : 0,
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
    if (!selectedConn || importSubmitting) return;
    if (importPointDrafts.length === 0) {
      messageApi.error('请选择需要导入的现有点位');
      return;
    }
    if (importValidation.errorCount > 0) {
      messageApi.error(`请先修正 ${importValidation.errorCount} 个导入错误`);
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
      if (
        createImportRoutes
        && draft.sourceEndpoint.module_name === IEC104_MODULE_NAME
        && draft.sourceEndpoint.conn_name === selectedConn
      ) {
        messageApi.error(`来源点位 ${draft.sourceLabel} 属于当前 IEC104 连接，不能创建自环路由`);
        return;
      }
      if (!tag) {
        messageApi.error(`请完善来源点位 ${draft.sourceLabel} 的标签`);
        return;
      }
      if (!Number.isInteger(draft.ioa) || draft.ioa < 1 || draft.ioa > MAX_IOA) {
        messageApi.error(`点位 ${tag} 的 IOA 必须为 1 ~ ${MAX_IOA} 的整数`);
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
        scale: draft.point_type === 2 ? DEFAULT_POINT_FORM_VALUES.scale : draft.scale ?? DEFAULT_POINT_FORM_VALUES.scale,
        offset: draft.point_type === 2 ? DEFAULT_POINT_FORM_VALUES.offset : draft.offset ?? DEFAULT_POINT_FORM_VALUES.offset,
        deadband: draft.point_type === 2 ? DEFAULT_POINT_FORM_VALUES.deadband : draft.deadband ?? DEFAULT_POINT_FORM_VALUES.deadband,
      });
      draftTags.add(tag);
      draftIoas.add(draft.ioa);
    }

    setImportSubmitting(true);
    let newPoints: Iec104Point[] = [];
    let routesCreated = 0;

    try {
      newPoints = [...points, ...normalizedPoints];
      const importRoutes = buildImportedPointRoutes(
        importPointDrafts.map((draft) => ({
          source: draft.sourceEndpoint,
          targetTag: draft.tag.trim(),
        })),
        {
          moduleName: IEC104_MODULE_NAME,
          connName: selectedConn,
        },
      );
      const restartResult = await runSelectedLinkStopped(async () => {
        const saveResult = await saveImportedPointsWithOptionalRoutes({
          createRoutes: createImportRoutes,
          routes: importRoutes,
          savePointTable: () => api.iec104UpsertPointTable(selectedConn, newPoints, true),
          saveRoutes: (routes) => api.dcUpsertRoutes(routes, false),
        });
        routesCreated = saveResult.routesCreated;
      });
      setPoints(newPoints);
      setImportPointModalOpen(false);
      console.info('IEC104 从现有点位添加完成', {
        connName: selectedConn,
        pointCount: normalizedPoints.length,
        routeCount: routesCreated,
      });
      messageApi.success(
        routesCreated > 0
          ? `已导入 ${normalizedPoints.length} 个点位，并提交 ${routesCreated} 条 DataCenter 路由`
          : `已导入 ${normalizedPoints.length} 个点位`,
      );
      if (restartResult.restartError) {
        messageApi.warning(`点表已保存，但重新启动失败: ${formatErrorText(restartResult.restartError)}`);
      } else if (restartResult.stoppedBeforeRun) {
        messageApi.success('点表已保存并重新启动链路');
      }
    } catch (e) {
      const routeSaveError =
        e instanceof ImportedPointRoutesError
          ? e
          : e instanceof RuntimeRestartError && e.operationError instanceof ImportedPointRoutesError
            ? e.operationError
            : null;
      if (routeSaveError) {
        setPoints(newPoints);
        console.error('IEC104 从现有点位添加时创建 DataCenter 路由失败，点表已保存', {
          connName: selectedConn,
          pointCount: normalizedPoints.length,
          error: routeSaveError.routeError,
        });
        messageApi.error(`点表已保存，路由创建失败: ${formatErrorText(routeSaveError.routeError)}`);
        if (e instanceof RuntimeRestartError) {
          messageApi.warning(`链路恢复启动失败: ${formatErrorText(e.restartError)}`);
        }
        return;
      }
      console.error('IEC104 从现有点位添加失败', {
        connName: selectedConn,
        error: e,
      });
      messageApi.error(`导入点位失败: ${e}`);
    } finally {
      setImportSubmitting(false);
    }
  }, [
    createImportRoutes,
    importPointDrafts,
    importSubmitting,
    importValidation.errorCount,
    importReservedTagSet,
    messageApi,
    points,
    runSelectedLinkStopped,
    selectedConn,
  ]);

  // ── Point Table Columns ──

  const pointColumns: ColumnsType<Iec104Point> = useMemo(() => {
    const tagColumn = {
      title: 'Tag (标签)',
      dataIndex: 'tag',
      key: 'tag',
      width: 180,
      fixed: 'left' as const,
      render: (value: string) => <Text strong>{value}</Text>,
    };
    const ioaColumn = {
      title: 'IOA (信息体地址)',
      dataIndex: 'ioa',
      key: 'ioa',
      width: 180,
      render: (ioa: number) => `${ioa} (${formatIoaHex(ioa)})`,
      sorter: (left: Iec104Point, right: Iec104Point) => left.ioa - right.ioa,
    };
    const typeColumn = {
      title: '类型 (Type)',
      dataIndex: 'point_type',
      key: 'point_type',
      width: 220,
      render: (value: number) => POINT_TYPE_LABELS[value] ?? `未知类型 (${value})`,
    };
    const realtimeValueColumn = {
      title: '实时值',
      key: 'realtime_value',
      width: 160,
      render: (_value: unknown, record: Iec104Point) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeValueCell(update, realtimeRevisionByTag[record.tag]?.value);
      },
    };
    const realtimeTimestampColumn = {
      title: '时间',
      key: 'realtime_ts',
      width: 130,
      render: (_value: unknown, record: Iec104Point) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeTimestampCell(update, realtimeRevisionByTag[record.tag]?.timestamp);
      },
    };
    const realtimeQualityColumn = {
      title: '质量',
      key: 'realtime_quality',
      width: 100,
      render: (_value: unknown, record: Iec104Point) => {
        const update = realtimeByTag[record.tag];
        return renderProtocolRealtimeQualityCell(update, realtimeRevisionByTag[record.tag]?.quality);
      },
    };
    const actionColumn = {
      title: '操作',
      key: 'action',
      width: 132,
      fixed: 'right' as const,
      render: (_value: unknown, record: Iec104Point) => {
        const originalIndex = points.indexOf(record);
        if (originalIndex < 0) {
          return null;
        }
        return (
          <Space size={2}>
            <Tooltip title="编辑点位">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                aria-label={`编辑点位 ${record.tag}`}
                disabled={actionsDisabled}
                onClick={() => openEditPoint(originalIndex)}
              />
            </Tooltip>
            <Tooltip title="复制点位">
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                aria-label={`复制点位 ${record.tag}`}
                disabled={actionsDisabled}
                onClick={() => openCopyPoint(originalIndex)}
              />
            </Tooltip>
            <Popconfirm title="确认删除该点位？" onConfirm={() => void handleDeletePoint(originalIndex)}>
              <Tooltip title="删除点位">
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={`删除点位 ${record.tag}`}
                  disabled={actionsDisabled}
                />
              </Tooltip>
            </Popconfirm>
          </Space>
        );
      },
    };

    if (pointTableView === 'runtime') {
      return [tagColumn, ioaColumn, typeColumn, realtimeValueColumn, realtimeTimestampColumn, realtimeQualityColumn];
    }

    return [
      tagColumn,
      ioaColumn,
      typeColumn,
      { title: 'Scale', dataIndex: 'scale', key: 'scale', width: 100 },
      { title: 'Offset', dataIndex: 'offset', key: 'offset', width: 100 },
      { title: 'Deadband', dataIndex: 'deadband', key: 'deadband', width: 110 },
      actionColumn,
    ];
  }, [actionsDisabled, handleDeletePoint, openCopyPoint, openEditPoint, pointTableView, points, realtimeByTag, realtimeRevisionByTag]);

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
          status={importValidation.cellIssues.has(`${record.key}:tag`) ? 'error' : undefined}
          disabled={importSubmitting}
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
          disabled={importSubmitting}
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
        <IoaInput
          size="small"
          min={1}
          max={MAX_IOA}
          precision={0}
          style={{ width: '100%' }}
          value={value}
          inputHex={ioaInputHex}
          status={importValidation.cellIssues.has(`${record.key}:ioa`) ? 'error' : undefined}
          disabled={importSubmitting}
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
          status={importValidation.cellIssues.has(`${record.key}:point_type`) ? 'error' : undefined}
          disabled={importSubmitting}
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
          status={importValidation.cellIssues.has(`${record.key}:scale`) ? 'error' : undefined}
          disabled={importSubmitting || record.point_type === 2}
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
          status={importValidation.cellIssues.has(`${record.key}:offset`) ? 'error' : undefined}
          disabled={importSubmitting || record.point_type === 2}
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
          status={importValidation.cellIssues.has(`${record.key}:deadband`) ? 'error' : undefined}
          disabled={importSubmitting || record.point_type === 2}
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
          aria-label={`移除导入点位 ${record.sourceLabel}`}
          disabled={importSubmitting}
          onClick={() => handleRemoveImportPointDraft(record.key)}
        />
      ),
    },
  ];

  // ── Render ──

  const stateInfo = STATE_MAP[selectedLink?.state ?? 0] ?? STATE_MAP[0];

  return (
    <div className="protocol-page iec104-page">
      {contextHolder}

      {refreshError ? (
        <Alert
          className="iec104-page-alert"
          type="warning"
          showIcon
          message="连接列表刷新失败"
          description={`${refreshError}${lastRefreshAt ? `；上次成功刷新于 ${new Date(lastRefreshAt).toLocaleTimeString()}` : ''}`}
          action={<Button size="small" onClick={() => void refreshLinks()}>重试</Button>}
        />
      ) : null}
      {realtimeError ? (
        <Alert
          className="iec104-page-alert"
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
          storageKey="mskdsp.layout.iec104.config"
        >
          <ResizableSplit
            className="protocol-top-row"
            defaultSize={240}
            minSize={200}
            maxSize={420}
            storageKey="mskdsp.layout.iec104.connection"
          >
            <ProtocolConnectionList
              title="连接列表"
              addButtonText="新增连接"
              width="100%"
              loading={loading}
              links={links}
              selectedConn={selectedConn}
              actionsDisabled={actionsDisabled}
              getItemActionsDisabled={(item) => item.state === 3}
              onSelect={setSelectedConn}
              onCreate={openCreateLink}
              onCopy={(connName) => void handleCopyLink(connName)}
              onDelete={(connName) => void handleDeleteLink(connName)}
              onRefresh={() => void refreshLinks()}
              getStateColor={(item) => LIST_STATE_COLOR_MAP[item.state] ?? '#8c8c8c'}
              getDescription={(item) => {
                const config = item.config;
                if (!config) return STATE_MAP[item.state]?.label ?? '未知状态';
                const endpoint = config.role === ROLE_SERVER ? config.local : config.remote;
                return `${STATE_MAP[item.state]?.label ?? '未知状态'} · ${ROLE_LABELS[config.role] ?? '未知角色'} · ${formatEndpoint(endpoint)}`;
              }}
              getDeleteTitle={(connName) => `确认删除 ${connName}？`}
            />

            <div className="iec104-connection-shell">
              <Card
                title={(
                  <Space size={8} wrap className="iec104-connection-title">
                    <span className="iec104-connection-name">{selectedLink?.config?.conn_name || '连接详情'}</span>
                    {selectedLink?.config ? <Tag color={stateInfo.color}>{stateInfo.label}</Tag> : null}
                    {selectedLink?.config ? <Text type="secondary">{ROLE_LABELS[selectedLink.config.role] ?? '未知角色'}</Text> : null}
                  </Space>
                )}
                size="small"
                bordered
                className="iec104-connection-card"
                extra={(
                  <Space wrap className="iec104-connection-actions">
                    {selectedLink?.config ? (
                      <>
                        <Button icon={<EditOutlined />} disabled={actionsDisabled || selectedLink.state === 3} onClick={openEditLink}>
                          编辑配置
                        </Button>
                        <Button
                          type="primary"
                          icon={<LinkOutlined />}
                          disabled={selectedLink.state !== 1 || actionsDisabled}
                          loading={runtimeAction === 'start'}
                          onClick={() => void handleStartLink()}
                        >
                          {runtimeAction === 'start' ? '连接中…' : '连接'}
                        </Button>
                        <Popconfirm title="确认断开连接？" description="断开后将停止 IEC104 链路。" onConfirm={() => void handleStopLink()} disabled={selectedLink.state !== 2 || actionsDisabled}>
                          <Button danger icon={<DisconnectOutlined />} disabled={selectedLink.state !== 2 || actionsDisabled} loading={runtimeAction === 'stop'}>
                            {runtimeAction === 'stop' ? '断开中…' : '断开'}
                          </Button>
                        </Popconfirm>
                        <Button icon={<ClockCircleOutlined />} disabled={selectedLink.state !== 2 || actionsDisabled} onClick={() => void handleTimeSync()}>
                          手工对时
                        </Button>
                        <Tooltip title="后端暂不支持总召唤">
                          <Button icon={<ThunderboltOutlined />} disabled>
                            总召唤
                          </Button>
                        </Tooltip>
                      </>
                    ) : null}
                  </Space>
                )}
              >
                {selectedLink?.config ? (
                  <>
                    <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} colon={false} className="iec104-connection-descriptions">
                      <Descriptions.Item label="站点角色">{STATION_ROLE_LABELS[selectedLink.config.station_role] ?? selectedLink.config.station_role}</Descriptions.Item>
                      <Descriptions.Item label="公共地址 (CA)">{selectedLink.config.ca}</Descriptions.Item>
                      <Descriptions.Item label="源地址 (OA)">{selectedLink.config.oa}</Descriptions.Item>
                      {selectedLink.config.role !== ROLE_CLIENT ? <Descriptions.Item label="本地端点">{formatEndpoint(selectedLink.config.local)}</Descriptions.Item> : null}
                      {selectedLink.config.role !== ROLE_SERVER ? <Descriptions.Item label="远程端点">{formatEndpoint(selectedLink.config.remote)}</Descriptions.Item> : null}
                      <Descriptions.Item label="APCI 参数">{formatApci(selectedLink.config.apci)}</Descriptions.Item>
                      <Descriptions.Item label="对时标签">{selectedLink.config.time_sync_tag || '-'}</Descriptions.Item>
                      <Descriptions.Item label="点位状态">{points.length > 0 ? <Tag color="success">已配置 {points.length} 个点位</Tag> : <Tag color="warning">未配置</Tag>}</Descriptions.Item>
                    </Descriptions>
                    {selectedLink.last_error ? <Alert className="iec104-last-error" type="error" showIcon message="最近错误" description={selectedLink.last_error} /> : null}
                  </>
                ) : (
                  <div className="iec104-connection-empty"><Text type="secondary">请从左侧选择连接，或新建一条连接。</Text></div>
                )}
              </Card>
            </div>
          </ResizableSplit>

          <Card
            title={(
              <Space size={8} wrap>
                <span>点表配置 (Tag ↔ IOA)</span>
                {selectedConn ? <Text type="secondary">显示 {visiblePoints.length}/{points.length} 个点位</Text> : null}
                {pointTableView === 'runtime' && realtimeLoading && selectedConn ? <Text type="secondary">实时数据连接中</Text> : null}
              </Space>
            )}
            size="small"
            bordered
            className="protocol-point-card"
            extra={(
              <Space wrap>
                <Segmented<'config' | 'runtime'>
                  size="small"
                  value={pointTableView}
                  options={[{ label: '配置视图', value: 'config' }, { label: '运行视图', value: 'runtime' }]}
                  onChange={setPointTableView}
                />
                <Button
                  size="small"
                  icon={<FilterOutlined />}
                  type={filterExpanded || hasPointFilters ? 'default' : 'text'}
                  aria-expanded={filterExpanded}
                  onClick={() => setFilterExpanded((expanded) => !expanded)}
                >
                  筛选{pointFilterCount > 0 ? ` (${pointFilterCount})` : ''}
                </Button>
                <Popconfirm
                  title="确认删除全部点位？"
                  description={`当前连接的 ${points.length} 个点位将被清空`}
                  onConfirm={() => void handleDeleteAllPoints()}
                  disabled={!selectedConn || points.length === 0 || actionsDisabled}
                >
                  <Button danger size="small" icon={<DeleteOutlined />} disabled={!selectedConn || points.length === 0 || actionsDisabled}>删除全部点位</Button>
                </Popconfirm>
                <Button
                  size="small"
                  icon={<ThunderboltOutlined />}
                  disabled={!selectedConn || pointTableView !== 'config' || selectedPointTags.length === 0 || actionsDisabled}
                  onClick={openIoaAdjustModal}
                >
                  IOA 调整{selectedPointTags.length > 0 ? ` (${selectedPointTags.length})` : ''}
                </Button>
                <Button size="small" icon={<UploadOutlined />} disabled={!selectedConn || actionsDisabled} onClick={openImportPointModal}>从数据总线导入</Button>
                <Button type="primary" size="small" icon={<PlusOutlined />} disabled={!selectedConn || actionsDisabled} onClick={openCreatePoint}>添加点位</Button>
              </Space>
            )}
          >
            {filterExpanded ? (
              <div className="protocol-point-filter-panel" id="iec104-point-filters">
                <Input
                  allowClear
                  size="small"
                  prefix={<SearchOutlined />}
                  placeholder="搜索 Tag 或 IOA"
                  value={pointSearch}
                  disabled={!selectedConn || points.length === 0}
                  onChange={(event) => setPointSearch(event.target.value)}
                  style={{ width: 190 }}
                />
                <Select<number>
                  allowClear
                  size="small"
                  placeholder="全部点类型"
                  value={pointTypeFilter}
                  options={Object.entries(POINT_TYPE_LABELS).map(([value, label]) => ({ value: Number(value), label }))}
                  onChange={setPointTypeFilter}
                  disabled={!selectedConn || points.length === 0}
                  style={{ width: 190 }}
                />
                <Button type="text" size="small" icon={<ClearOutlined />} disabled={!hasPointFilters} onClick={clearPointFilters}>清除筛选</Button>
              </div>
            ) : null}
            <div className="protocol-table-scroll">
              <Table
                rowKey={(record) => record.tag}
                columns={pointColumns}
                dataSource={visiblePoints}
                rowSelection={pointTableView === 'config' ? {
                  selectedRowKeys: selectedPointTags,
                  preserveSelectedRowKeys: true,
                  onChange: (keys) => setSelectedPointTags(keys.map((key) => String(key))),
                } : undefined}
                loading={pointsLoading || (pointTableView === 'runtime' && realtimeLoading)}
                pagination={false}
                size="small"
                scroll={{ x: pointTableView === 'runtime' ? 1100 : 1120 }}
                locale={{
                  emptyText: selectedConn
                    ? points.length > 0
                      ? <Space direction="vertical" size={4}><Text type="secondary">没有符合当前筛选条件的点位</Text>{hasPointFilters ? <Button type="link" size="small" onClick={clearPointFilters}>清除筛选</Button> : null}</Space>
                      : <Space direction="vertical" size={6}><Text type="secondary">暂无点位</Text><Button type="primary" size="small" icon={<PlusOutlined />} disabled={actionsDisabled} onClick={openCreatePoint}>添加第一点位</Button></Space>
                    : '请先选择连接',
                }}
              />
            </div>
          </Card>
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
        className="iec104-config-modal"
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
            <Col xs={24} sm={12} lg={8}>
              <Form.Item
                name="conn_name"
                label="连接名称"
                rules={[{ required: true, message: '请输入连接名称' }]}
              >
                <Input placeholder="conn_104_master" autoComplete="off" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={8}>
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
            <Col xs={24} sm={12} lg={8}>
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
        onCancel={() => {
          if (!pointSubmitting) {
            setPointModalOpen(false);
          }
        }}
        width={680}
        className="iec104-config-modal"
        okText={editingPointIndex !== null ? '保存修改' : '添加点位'}
        cancelText="取消"
        confirmLoading={pointSubmitting}
        maskClosable={!pointSubmitting}
        closable={!pointSubmitting}
        destroyOnClose
      >
        <Form form={pointForm} layout="vertical" size="small">
          <Row gutter={16}>
            <Col xs={24} sm={12} lg={8}>
              <Form.Item
                name="tag"
                label="Tag (标签)"
                normalize={(value) => (typeof value === 'string' ? value.trim() : value)}
                validateStatus={pointTagDuplicate ? 'error' : undefined}
                help={pointTagDuplicate ? '该标签已存在' : undefined}
                rules={[
                  { required: true, message: '请输入标签名' },
                  { max: 128, message: '标签长度不能超过 128 个字符' },
                  {
                    validator: async () => {
                      if (pointTagDuplicate) {
                        throw new Error('该标签已存在');
                      }
                    },
                  },
                ]}
              >
                <Input placeholder="p_meas_1" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} lg={8}>
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
            <Col xs={24} sm={12} lg={8}>
              <Form.Item
                name="ioa"
                label="IOA (信息体地址)"
                extra={(
                  <Space size={[8, 2]} wrap className="iec104-ioa-form-extra">
                    <span>{pointIoaRange ? `范围：${formatIoaDual(pointIoaRange.start)} - ${formatIoaDual(pointIoaRange.end)}` : `允许范围：${formatIoaDual(1)} - ${formatIoaDual(MAX_IOA)}`}</span>
                    {typeof pointIoa === 'number' && Number.isFinite(pointIoa) ? <span>当前值：{formatIoaDual(pointIoa)}</span> : null}
                    <Checkbox checked={ioaInputHex} onChange={(event) => setIoaInputHex(event.target.checked)}>十六进制输入</Checkbox>
                  </Space>
                )}
                rules={[
                  { required: true, message: '请输入 IOA' },
                  { type: 'number', min: 1, max: MAX_IOA, message: `IOA 必须为 1 - ${MAX_IOA}` },
                  {
                    validator: async () => {
                      if (pointIoaDuplicate) {
                        throw new Error('该 IOA 已存在');
                      }
                    },
                  },
                ]}
              >
                <IoaInput
                  min={1}
                  max={MAX_IOA}
                  precision={0}
                  inputHex={ioaInputHex}
                  style={{ width: '100%' }}
                  onChange={handlePointIoaChange}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12} lg={12}>
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
            <Col xs={8} sm={4} lg={4}>
              <Form.Item name="scale" label="Scale" extra={isSinglePoint ? '仅 FLOAT 生效' : undefined}>
                <InputNumber step={0.01} disabled={isSinglePoint} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={8} sm={4} lg={4}>
              <Form.Item name="offset" label="Offset" extra={isSinglePoint ? '仅 FLOAT 生效' : undefined}>
                <InputNumber step={0.01} disabled={isSinglePoint} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={8} sm={4} lg={4}>
              <Form.Item name="deadband" label="Deadband" extra={isSinglePoint ? '仅 FLOAT 生效' : undefined}>
                <InputNumber step={0.01} min={0} disabled={isSinglePoint} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          {pointType === 2 ? (
            <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
              单点遥信按 IEC104 SIQ bit0 解析，质量位按协议转换，无需配置 bit 索引。
            </Text>
          ) : null}
        </Form>
      </Modal>

      {/* IOA Batch Adjustment Modal */}
      <Modal
        title="批量调整 IOA"
        open={ioaAdjustModalOpen}
        onOk={() => void handleIoaAdjustSubmit()}
        onCancel={() => {
          if (!pointSubmitting) {
            setIoaAdjustModalOpen(false);
          }
        }}
        width={860}
        className="iec104-config-modal iec104-ioa-adjust-modal"
        okText={ioaAdjustValidation.changedCount > 0 ? `保存 ${ioaAdjustValidation.changedCount} 个 IOA` : '保存调整'}
        cancelText="取消"
        confirmLoading={pointSubmitting}
        maskClosable={!pointSubmitting}
        closable={!pointSubmitting}
        okButtonProps={{
          disabled: pointSubmitting || ioaAdjustDrafts.length === 0 || ioaAdjustValidation.issues.size > 0 || ioaAdjustValidation.changedCount === 0,
        }}
        destroyOnClose
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="只会修改当前勾选的点位"
            description={`当前选择 ${ioaAdjustDrafts.length} 个点位，未选中的点位和它们的 IOA 保持不变。IOA 是对端 IEC104 映射地址，保存前请核对下方变更预览。`}
          />

          <div className="iec104-ioa-adjust-toolbar">
            <Space size={8} wrap>
              <Text strong>调整方式</Text>
              <Checkbox checked={ioaInputHex} onChange={(event) => setIoaInputHex(event.target.checked)}>
                十六进制输入
              </Checkbox>
              <Segmented<IoaAdjustmentStrategy>
                size="small"
                value={ioaAdjustStrategy}
                options={[
                  { label: '按顺序分配', value: 'sequence' },
                  { label: '保持间距并偏移', value: 'offset' },
                  { label: '手工调整', value: 'manual' },
                ]}
                onChange={(value) => {
                  setIoaAdjustStrategy(value);
                  recalculateIoaAdjustDrafts(value);
                }}
              />
            </Space>
            {ioaAdjustStrategy === 'offset' ? (
              <Space size={8} wrap>
                <Text type="secondary">偏移量</Text>
                <IoaInput
                  size="small"
                  min={-MAX_IOA}
                  max={MAX_IOA}
                  precision={0}
                  value={ioaAdjustOffset}
                  inputHex={ioaInputHex}
                  disabled={pointSubmitting}
                  onChange={(value) => setIoaAdjustOffset(typeof value === 'number' && Number.isFinite(value) ? value : 0)}
                />
                <Button size="small" onClick={() => recalculateIoaAdjustDrafts('offset')} disabled={pointSubmitting}>应用偏移</Button>
              </Space>
            ) : null}
            {ioaAdjustStrategy === 'sequence' ? (
              <Space size={8} wrap>
                <Text type="secondary">起点</Text>
                <IoaInput
                  size="small"
                  min={1}
                  max={MAX_IOA}
                  precision={0}
                  value={ioaAdjustStart}
                  inputHex={ioaInputHex}
                  disabled={pointSubmitting}
                  onChange={(value) => setIoaAdjustStart(typeof value === 'number' && Number.isFinite(value) ? value : 1)}
                />
                <Text type="secondary">步长</Text>
                <IoaInput
                  size="small"
                  min={1}
                  max={MAX_IOA}
                  precision={0}
                  value={ioaAdjustStep}
                  inputHex={ioaInputHex}
                  disabled={pointSubmitting}
                  onChange={(value) => setIoaAdjustStep(typeof value === 'number' && Number.isFinite(value) ? value : 1)}
                />
                <Switch
                  size="small"
                  checked={ioaAdjustSkipOccupied}
                  disabled={pointSubmitting}
                  onChange={setIoaAdjustSkipOccupied}
                />
                <Text type="secondary">跳过未选中点位地址</Text>
                <Button size="small" onClick={() => recalculateIoaAdjustDrafts('sequence')} disabled={pointSubmitting}>重新生成</Button>
              </Space>
            ) : null}
          </div>

          <Text type="secondary">拖动点位可以改变“按顺序分配”的顺序；直接编辑右侧新 IOA 可以处理非连续地址。</Text>
          <div className="iec104-ioa-adjust-list">
            <div className="iec104-ioa-adjust-header">
              <span>顺序</span>
              <span>点位</span>
              <span>原 IOA</span>
              <span>新 IOA</span>
              <span>状态</span>
            </div>
            {ioaAdjustDrafts.map((draft, index) => {
              const issue = ioaAdjustValidation.issues.get(draft.key);
              const changed = draft.ioa !== draft.originalIoa;
              return (
                <div
                  className={`iec104-ioa-adjust-row${issue ? ' has-error' : ''}`}
                  key={draft.key}
                  draggable={!pointSubmitting}
                  onDragStart={(event) => {
                    setPointDraftDragData(event, draft.key);
                    setIoaAdjustDragKey(draft.key);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceKey = getPointDraftDragKey(event, ioaAdjustDragKey);
                    if (sourceKey) reorderIoaAdjustDrafts(sourceKey, draft.key);
                    setIoaAdjustDragKey(null);
                  }}
                  onDragEnd={() => setIoaAdjustDragKey(null)}
                >
                  <span className="iec104-ioa-adjust-order"><HolderOutlined /> {index + 1}</span>
                  <Text ellipsis={{ tooltip: draft.tag }}>{draft.tag}</Text>
                  <Text type="secondary">{draft.originalIoa} ({formatIoaHex(draft.originalIoa)})</Text>
                  <div className="iec104-ioa-input-cell">
                    <IoaInput
                    size="small"
                    min={1}
                    max={MAX_IOA}
                    precision={0}
                    value={draft.ioa}
                    inputHex={ioaInputHex}
                    status={issue ? 'error' : undefined}
                    disabled={pointSubmitting || ioaAdjustStrategy !== 'manual'}
                    onChange={(value) => setIoaAdjustDrafts((current) => current.map((item) => (
                      item.key === draft.key ? { ...item, ioa: typeof value === 'number' && Number.isFinite(value) ? value : 0 } : item
                    )))}
                    />
                    <Text type="secondary" className="iec104-ioa-input-dual">{formatIoaDual(draft.ioa)}</Text>
                  </div>
                  {issue ? <Text type="danger" className="iec104-ioa-adjust-status">{issue}</Text> : changed ? <Tag color="orange">将修改</Tag> : <Tag>保持</Tag>}
                </div>
              );
            })}
          </div>
          <Text type="secondary">
            变更 {ioaAdjustValidation.changedCount} 个，保持 {ioaAdjustDrafts.length - ioaAdjustValidation.changedCount} 个；冲突 {ioaAdjustValidation.issues.size} 个。
          </Text>
        </Space>
      </Modal>

      <Modal
        title="从数据总线导入点位"
        open={importPointModalOpen}
        onOk={() => void handleImportPointsSubmit()}
        onCancel={() => {
          if (!importSubmitting) {
            setImportPointModalOpen(false);
          }
        }}
        width={1100}
        className="iec104-config-modal iec104-import-modal"
        okText={importSubmitting ? '导入中…' : `导入 ${importPointDrafts.length} 个点位`}
        cancelText="取消"
        confirmLoading={importSubmitting}
        maskClosable={!importSubmitting}
        closable={!importSubmitting}
        okButtonProps={{
          disabled: dataBusEndpointLoading || importSubmitting || importPointDrafts.length === 0 || importValidation.errorCount > 0,
        }}
        destroyOnClose
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Text type="secondary">
            从数据总线已注册的连接标签中选择点位导入到当前 IEC104 点表。
            导入时会默认按“模块_连接_tag”生成新标签，避免直接复用来源点位的 tag；
            你仍然可以在下方表格里继续修改。数据总线当前只提供标签信息，点类型和 IOA 需要在导入前确认。
          </Text>

          <Row gutter={16}>
            <Col xs={24} sm={8}>
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
                  disabled={importSubmitting}
                  notFoundContent="暂无可选连接"
                  onChange={handleImportSourceConnChange}
                  filterOption={(input, option) =>
                    String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
              </div>
            </Col>
            <Col xs={24} sm={16}>
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
                  disabled={!importSourceConnId || importSubmitting}
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

          <div className="iec104-import-batch-toolbar">
            <Text strong>批量设置</Text>
            <Select<number>
              allowClear
              size="small"
              value={importBatchType}
              placeholder="统一点位类型"
              options={Object.entries(POINT_TYPE_LABELS).map(([value, label]) => ({ value: Number(value), label }))}
              disabled={importPointDrafts.length === 0 || importSubmitting}
              onChange={applyImportBatchType}
              style={{ width: 180 }}
            />
            <Select<IoaCategoryKey>
              allowClear
              size="small"
              value={importBatchCategory}
              placeholder="统一 IOA 地址段"
              options={IOA_CATEGORY_OPTIONS}
              disabled={importPointDrafts.length === 0 || importSubmitting}
              onChange={applyImportBatchCategory}
              style={{ width: 190 }}
            />
            <Checkbox checked={ioaInputHex} onChange={(event) => setIoaInputHex(event.target.checked)}>
              十六进制输入
            </Checkbox>
            <Text type="secondary">已选 {importPointDrafts.length} 个，可逐行调整 Tag、IOA 和类型。</Text>
          </div>

          {importPointDrafts.length > 0 ? (
            <div className="iec104-ioa-allocation-panel">
              <div className="iec104-ioa-allocation-toolbar">
                <Space size={8} wrap>
                  <Text strong>新增点位 IOA 编排</Text>
                  <Text type="secondary">拖动下方点位调整分配顺序，已有点位地址不会改变。</Text>
                </Space>
                <Space size={8} wrap>
                  <Text type="secondary">起点</Text>
                  <IoaInput
                    size="small"
                    min={1}
                    max={MAX_IOA}
                    precision={0}
                    value={importAllocationStart}
                    inputHex={ioaInputHex}
                    disabled={importSubmitting}
                    onChange={(value) => setImportAllocationStart(typeof value === 'number' && Number.isFinite(value) ? value : 1)}
                  />
                  <Text type="secondary">步长</Text>
                  <IoaInput
                    size="small"
                    min={1}
                    max={MAX_IOA}
                    precision={0}
                    value={importAllocationStep}
                    inputHex={ioaInputHex}
                    disabled={importSubmitting}
                    onChange={(value) => setImportAllocationStep(typeof value === 'number' && Number.isFinite(value) ? value : 1)}
                  />
                  <Switch
                    size="small"
                    checked={importAllocationSkipOccupied}
                    disabled={importSubmitting}
                    onChange={setImportAllocationSkipOccupied}
                  />
                  <Text type="secondary">跳过已有地址</Text>
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    icon={<ThunderboltOutlined />}
                    disabled={importSubmitting}
                    onClick={applyImportIoaAllocation}
                  >
                    按顺序分配
                  </Button>
                </Space>
              </div>
              <div className="iec104-ioa-allocation-list">
                {importPointDrafts.map((draft, index) => (
                  <div
                    className="iec104-ioa-allocation-item"
                    key={draft.key}
                    draggable={!importSubmitting}
                    onDragStart={(event) => {
                      setPointDraftDragData(event, draft.key);
                      setImportDragKey(draft.key);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const sourceKey = getPointDraftDragKey(event, importDragKey);
                      if (sourceKey) reorderImportDrafts(sourceKey, draft.key);
                      setImportDragKey(null);
                    }}
                    onDragEnd={() => setImportDragKey(null)}
                  >
                    <HolderOutlined className="iec104-ioa-drag-handle" />
                    <span className="iec104-ioa-order">{index + 1}</span>
                    <Text ellipsis={{ tooltip: draft.tag }} className="iec104-ioa-allocation-tag">{draft.tag}</Text>
                    <Text type="secondary" className="iec104-ioa-allocation-source">{draft.sourceLabel}</Text>
                    <Tag color="blue">{draft.ioa > 0 ? `${draft.ioa} (${formatIoaHex(draft.ioa)})` : '待分配'}</Tag>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <Checkbox
              checked={createImportRoutes}
              disabled={importSubmitting}
              onChange={(event) => setCreateImportRoutes(event.target.checked)}
            >
              导入并创建 DataCenter 路由（来源点位 → 当前 IEC104 点位）
            </Checkbox>
            <Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
              路由使用下方最终确认的 Tag，不会自动转换数据类型或工程量单位。
            </Text>
          </div>

          {importRoutesTriggerCommands ? (
            <Alert
              type="warning"
              showIcon
              message="当前 IEC104 连接为 MASTER"
              description="来源点位到当前 IEC104 点位的路由可能触发遥控或遥调命令，请确认路由方向和点类型。"
            />
          ) : null}

          {importValidation.errorCount > 0 ? (
            <Alert
              type="error"
              showIcon
              message={`有 ${importValidation.errorCount} 个导入错误`}
              description="请根据表格中的红色字段修正标签、IOA 或数值后再提交。"
            />
          ) : null}

          <div className="protocol-table-scroll">
            <Table
              rowKey="key"
              columns={importPointColumns}
              dataSource={importPointDrafts}
              pagination={false}
              size="small"
              scroll={{ x: 1460, y: 360 }}
              rowClassName={(record) => (importValidation.rowIssues.has(record.key) ? 'iec104-import-row-error' : '')}
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
