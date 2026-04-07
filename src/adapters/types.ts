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
