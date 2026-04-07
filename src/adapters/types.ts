export interface ModuleVersion {
  major: string;
  minor: string;
  patch: string;
  version: string;
}

export interface ModuleDependency {
  module_name: string;
  version_range: string;
}

export interface ModuleInfo {
  module_name: string;
  version: ModuleVersion | null;
  lib_name: string;
  dependencies: ModuleDependency[];
  manifest_error: string;
}

export interface ModuleRunningInfo {
  module_name: string;
  version: ModuleVersion | null;
  lib_name: string;
  inner_grpc_server: string;
  outer_grpc_server: string;
}

export interface Iec104Endpoint {
  ip: string;
  port: number;
}

export interface Iec104ApciParameters {
  k: number;
  w: number;
  t0: number;
  t1: number;
  t2: number;
  t3: number;
}

export interface Iec104LinkConfig {
  conn_name: string;
  role: number;
  local: Iec104Endpoint | null;
  remote: Iec104Endpoint | null;
  ca: number;
  oa: number;
  apci: Iec104ApciParameters | null;
  point_batch_window_ms: number;
  point_max_asdu_bytes: number;
  point_use_standard_limit: boolean;
  point_dedupe: boolean | null;
  time_sync_tag: string;
  station_role: number;
  point_with_time: boolean;
}

export interface Iec104LinkInfo {
  config: Iec104LinkConfig | null;
  conn_id: number;
  state: number;
  last_error: string;
}

export interface Iec104Point {
  tag: string;
  ioa: number;
  point_type: number;
  scale: number;
  offset: number;
  deadband: number;
}

export interface Iec104PointTable {
  conn_name: string;
  points: Iec104Point[];
}

export interface ModbusSerialConfig {
  device: string;
  baud_rate: number;
  data_bits: number;
  parity: number;
  stop_bits: number;
  read_timeout_ms: number;
}

export interface ModbusMqttConfig {
  host: string;
  port: number;
  client_id: string;
  username: string;
  password: string;
  keepalive_sec: number;
  clean_session: boolean;
  connect_timeout_ms: number;
}

export interface ModbusReadBlock {
  function: number;
  start: number;
  quantity: number;
}

export interface ModbusReadPlan {
  mode: number;
  blocks: ModbusReadBlock[];
}

export interface ModbusLinkConfig {
  conn_name: string;
  serial: ModbusSerialConfig | null;
  device_id: number;
  poll_interval_ms: number;
  address_base: number;
  read_plan: ModbusReadPlan | null;
  transport_type: number;
  serial_port: string;
  request_timeout_ms: number;
  serial_byte_timeout_ms: number;
  serial_frame_timeout_ms: number;
  serial_est_size: number;
}

export interface ModbusLinkInfo {
  config: ModbusLinkConfig | null;
  conn_id: number;
  state: number;
  last_error: string;
}

export interface ModbusPoint {
  tag: string;
  function: number;
  address: number;
  data_type: number;
  scale: number;
  offset: number;
  deadband: number;
  reg_count: number;
  word_order: number;
  byte_order: number;
}

export interface ModbusPointTable {
  conn_name: string;
  points: ModbusPoint[];
}

export interface ModbusUpdateConfigResponse {
  ok: boolean;
  message: string;
}

export interface Dlt645MqttConfig {
  host: string;
  port: number;
  client_id: string;
  username: string;
  password: string;
  keepalive_sec: number;
  clean_session: boolean;
  connect_timeout_ms: number;
}

export interface Dlt645LinkConfig {
  conn_name: string;
  protocol_variant: number;
  meter_addr: string;
  device_no: string;
  transport_type: number;
  comm_mode: number;
  poll_interval_ms: number;
  poll_item_interval_ms: number;
  request_timeout_ms: number;
  serial_port: string;
  serial_baud_rate: number;
  serial_data_bits: number;
  serial_parity: number;
  serial_stop_bits: number;
  serial_byte_timeout_ms: number;
  serial_frame_timeout_ms: number;
  serial_est_size: number;
}

export interface Dlt645LinkInfo {
  config: Dlt645LinkConfig | null;
  conn_id: number;
  state: number;
  last_error: string;
}

export interface Dlt645Point {
  tag: string;
  di: string;
  data_len: number;
  data_type: number;
  access: number;
  scale: number;
  offset: number;
  deadband: number;
}

export interface Dlt645BlockItem {
  tag: string;
  data_len: number;
  data_type: number;
  access: number;
  scale: number;
  offset: number;
  deadband: number;
  trim_right_space: boolean | null;
}

export interface Dlt645Block {
  block_di: string;
  block_data_len: number;
  items: Dlt645BlockItem[];
}

export interface Dlt645PointTable {
  conn_name: string;
  points: Dlt645Point[];
  blocks: Dlt645Block[];
}

export interface Dlt645UpdateConfigResponse {
  ok: boolean;
  message: string;
}

export interface DcConnectionInfo {
  conn_id: number;
  module_name: string;
  conn_name: string;
}

export interface DcConnTags {
  conn_id: number;
  tags: string[];
}

export interface DcEndpoint {
  conn_id: number;
  tag: string;
}

export interface DcRoute {
  src: DcEndpoint;
  dst: DcEndpoint;
}

export type DcPointValue =
  | { type: 'Bool'; value: boolean }
  | { type: 'Int'; value: number }
  | { type: 'Double'; value: number }
  | { type: 'String'; value: string }
  | { type: 'Bytes'; value: number[] };

export interface DcPointUpdate {
  src_conn_id: number;
  src_tag: string;
  dst_conn_id: number;
  dst_tag: string;
  value: DcPointValue | null;
  ts_ms: number;
  quality: number;
}

export interface AgcSignalSpec {
  tag: string;
  unit: string;
  scale: number;
  offset: number;
}

export interface AgcValueSpec {
  signal: AgcSignalSpec | null;
  mode: number;
  delta_base: number;
  base_tag: string;
}

export interface AgcStrategyConfig {
  strategy_type: string;
}

export interface AgcMemberConfig {
  member_name: string;
  controllable: boolean;
  capacity_kw: number;
  weight: number;
  min_kw: number;
  max_kw: number;
  p_meas: AgcSignalSpec | null;
  p_set: AgcValueSpec | null;
}

export interface AgcDerivedOutputs {
  p_total_meas: AgcSignalSpec | null;
  p_total_target: AgcSignalSpec | null;
  p_total_error: AgcSignalSpec | null;
}

export interface AgcGroupConfig {
  group_name: string;
  p_cmd: AgcValueSpec | null;
  strategy: AgcStrategyConfig | null;
  members: AgcMemberConfig[];
  outputs: AgcDerivedOutputs | null;
}

export interface AgcGroupInfo {
  config: AgcGroupConfig | null;
  conn_id: number;
  state: number;
  last_error: string;
}
