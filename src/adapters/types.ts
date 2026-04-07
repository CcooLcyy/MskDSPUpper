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
