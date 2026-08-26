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

export interface AppUpdateInfo {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
}

export type AppUpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export type AppUpdateStatusKind =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready-to-install'
  | 'installing'
  | 'ready-to-restart'
  | 'error';

export interface AppUpdateStatus {
  kind: AppUpdateStatusKind;
  message: string;
}

export type AppSettingsMap = Record<string, unknown>;

export interface RuntimePaths {
  executable_dir: string;
  data_dir: string;
  cache_dir: string;
  log_dir: string;
  using_fallback: boolean;
}

export type RuntimeDirectoryKind = 'data' | 'cache' | 'logs';

export interface CacheClearResult {
  removed_files: number;
  reclaimed_bytes: number;
}

export type LowerUpdateChannel = 'stable' | 'beta' | 'nightly' | 'ci';

export interface LowerUpdateSource {
  repository: string;
  ref: string;
  sha: string;
}

export interface LowerUpdateAsset {
  name: string;
  url: string;
  sha256: string;
  size: number;
}

export interface LowerUpdateChecksum {
  name: string;
  url: string;
}

export interface LowerUpdateManifest {
  schema_version: number;
  product: string;
  channel: LowerUpdateChannel;
  platform: string;
  version: string;
  package_version: string;
  image_id?: string | null;
  published_at: string;
  source: LowerUpdateSource;
  asset: LowerUpdateAsset;
  checksum: LowerUpdateChecksum;
}

export type LowerUpdateDownloadStage = 'started' | 'downloading' | 'verifying' | 'finished';

export interface LowerUpdateDownloadProgress {
  package_name: string;
  downloaded_bytes: number;
  total_bytes: number;
  percent: number;
  stage: LowerUpdateDownloadStage;
}

export interface LowerUpdateDownloadResult {
  package_name: string;
  package_path: string;
  downloaded_bytes: number;
  sha256: string;
}

export interface LowerUpdateCachedPackage {
  downloaded_at: number;
  manifest: LowerUpdateManifest;
  package_path: string;
  package_size: number;
  sha256: string;
}

export type LowerUpdateUploadStage = 'started' | 'uploading' | 'finished';

export type LowerUpdateSshAuth =
  | { method: 'password'; password: string }
  | { method: 'certificate' };

export interface LowerUpdateUploadRequest {
  package_name: string;
  package_path: string;
  package_size: number;
  package_sha256: string;
  upload_account: string;
  install_dir: string;
  auth: LowerUpdateSshAuth;
  sudo_password: string;
}

export interface LowerUpdateUploadProgress {
  package_name: string;
  remote_path: string;
  uploaded_bytes: number;
  total_bytes: number;
  percent: number;
  stage: LowerUpdateUploadStage;
}

export interface LowerUpdateUploadResult {
  package_name: string;
  remote_path: string;
  uploaded_bytes: number;
}

export interface LowerUpdateInstallRequest {
  package_name: string;
  expected_image_id: string;
  upload_account: string;
  install_dir: string;
  auth: LowerUpdateSshAuth;
  sudo_password: string;
}

export interface LowerUpdateInstallResult {
  package_name: string;
  remote_path: string;
  command: string;
  already_current: boolean;
  success: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

export interface LowerUpdateRuntimeInfoRequest {
  upload_account: string;
  auth: LowerUpdateSshAuth;
  sudo_password: string;
}

export interface LowerUpdateRuntimeInfo {
  container_name: string;
  exists: boolean;
  running: boolean;
  image_id: string | null;
}

export interface VerticalSecurityDeployRequest {
  script_content: string;
  upload_account: string;
  install_dir: string;
  auth: LowerUpdateSshAuth;
  sudo_password: string;
}

export interface VerticalSecurityDeployResult {
  remote_path: string;
  service_name: string;
  exit_code: number | null;
  success: boolean;
  stdout: string;
  stderr: string;
}

export type VerticalSecurityStepState = 'running' | 'waiting' | 'success' | 'failed';

export interface VerticalSecurityStepResult {
  step_id: string;
  name: string;
  state: VerticalSecurityStepState;
  message: string;
  updated_at: number;
}

export interface VerticalSecurityStatusRequest {
  upload_account: string;
  auth: LowerUpdateSshAuth;
  sudo_password: string;
}

export interface VerticalSecurityStatusResult {
  service_name: string;
  active_state: string;
  sub_state: string;
  result: string;
  exit_code: number | null;
  restart_count: number;
  steps: VerticalSecurityStepResult[];
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
  business_type: number;
  scale: number;
  offset: number;
  deadband: number;
}

export interface Iec104PointTable {
  conn_name: string;
  points: Iec104Point[];
}

export interface Iec61850ModelSummary {
  model_name: string;
  source_name: string;
  document_kind: number;
  source_checksum: string;
  ied_count: number;
  logical_node_count: number;
  data_attribute_count: number;
  data_set_count: number;
  report_control_count: number;
  gse_control_count: number;
  sampled_value_control_count: number;
  external_reference_count: number;
}

export interface Iec61850ValidationIssue {
  severity: number;
  code: string;
  path: string;
  message: string;
}

export interface Iec61850ImportResult {
  summary: Iec61850ModelSummary | null;
  issues: Iec61850ValidationIssue[];
}

export interface Iec61850NetworkChannelConfig {
  channel: number;
  enabled: boolean;
  interface_name: string;
  subnetwork_name: string;
  local_ip: string;
  remote_ip: string;
  remote_port: number;
}

export interface Iec61850ProtectionRule {
  rule_id: string;
  conditions: Array<Record<string, unknown>>;
  interlock_signal_ids: number[];
  output_subscription_id: number;
  assert_values: Array<Record<string, unknown>>;
  release_values: Array<Record<string, unknown>>;
  assert_delay_ms: number;
  release_delay_ms: number;
  output_control_ref: string;
  interlock_signals: Array<Record<string, unknown>>;
}

export interface Iec61850IedConfig {
  conn_name: string;
  model_name: string;
  ied_name: string;
  access_point: string;
  channels: Iec61850NetworkChannelConfig[];
  enable_mms: boolean;
  enable_goose: boolean;
  enable_sv: boolean;
  auto_start: boolean;
  mms_event_queue_capacity: number;
  publish_batch_size: number;
  publish_batch_window_ms: number;
  protection_rules: Iec61850ProtectionRule[];
  nominal_frequency_hz: number;
  realtime_cpu_indices: number[];
  realtime_scheduling: number;
  realtime_priority: number;
  realtime_failure_mode: number;
}

export interface Iec61850ChannelInfo {
  config: Iec61850NetworkChannelConfig | null;
  state: number;
  last_error: string;
}

export interface Iec61850IedInfo {
  config: Iec61850IedConfig | null;
  conn_id: number;
  state: number;
  active_channel: number;
  channels: Iec61850ChannelInfo[];
  last_error: string;
  data_center_available: boolean;
}

export interface Iec61850PointMapping {
  tag: string;
  data_ref: string;
  fc: number;
  source: number;
  value_type: number;
  scale: number;
  offset: number;
  deadband: number;
}

export interface Iec61850PointMappings {
  conn_name: string;
  points: Iec61850PointMapping[];
}

export interface Iec61850RuntimeStatistics {
  conn_name: string;
  mms_reports_received: number;
  mms_events_dropped: number;
  mms_queue_high_watermark: number;
  data_center_batches_published: number;
  data_center_publish_failures: number;
  goose_frames_received: number;
  goose_frames_sent: number;
  goose_frames_invalid: number;
  goose_timeouts: number;
  sv_frames_received: number;
  sv_frames_invalid: number;
  sv_samples_dropped: number;
  reconnect_count: number;
  last_event_ts_ms: number;
  mms_values_unmapped: number;
  mms_values_type_mismatch: number;
  mms_values_invalid: number;
  mms_values_deadband_filtered: number;
  mms_values_oversized: number;
  mms_reports_oversized: number;
  mms_queue_bytes_high_watermark: number;
}

export interface Iec104SimulationPoint {
  tag: string;
  point_type: number;
  bool_value?: boolean | null;
  double_value?: number | null;
  quality: number;
  ts_ms: number;
}

export interface Iec104SimulationSnapshot {
  conn_name: string;
  points: Iec104SimulationPoint[];
}

export type Iec104SimulationMode = 'random' | 'increment';

export type Iec104SimulationBoolMode = 'random' | 'all_false' | 'all_true' | 'invert_current';

export interface Iec104SimulationGenerateOptions {
  mode: Iec104SimulationMode;
  boolMode: Iec104SimulationBoolMode;
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
  bit_index: number | null;
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
  byte_index: number | null;
  bit_index: number | null;
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
  byte_index: number | null;
  bit_index: number | null;
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
  module_name: string;
  conn_name: string;
  tag: string;
  conn_id?: number;
}

export interface DcRoute {
  src: DcEndpoint;
  dst: DcEndpoint;
}

export interface ControlOrchestratorCommandStep {
  step_name: string;
  source: DcEndpoint;
  value: DcPointValue | null;
  use_trigger_value: boolean;
  timeout_ms: number;
  delay_after_ms: number;
}

export interface ControlOrchestratorWorkflowConfig {
  sequence_name: string;
  steps: ControlOrchestratorCommandStep[];
}

export interface ControlOrchestratorExecuteRequest {
  sequence_name: string;
  trigger?: DcEndpoint | null;
  trigger_value?: DcPointValue | null;
  request_id?: string;
  timeout_ms?: number;
}

export interface ControlOrchestratorExecuteResponse {
  accepted: boolean;
  executed_steps: number;
  failed_step_index: number;
  failed_step_name: string;
  reason: string;
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

export interface DcSourcePointUpdate {
  conn_id: number;
  tag: string;
  value: DcPointValue | null;
  ts_ms: number;
  quality: number;
  sequence: number;
}

export type DataBusThroughputSource = 'backend' | 'browser-demo' | 'unavailable';

export interface DataBusThroughputSample {
  timestamp_ms: number;
  routed_points_per_second: number;
}

export interface DataBusThroughputSnapshot {
  source: DataBusThroughputSource;
  process_start_time_ms: number | null;
  samples: DataBusThroughputSample[];
  current_points_per_second: number;
  peak_points_per_second: number;
  updated_at_ms: number | null;
}

export interface CalcTypedConstant {
  bool_value?: boolean;
  int_value?: number;
  double_value?: number;
}

export interface CalcOperandSpec {
  source_kind: number;
  constant?: CalcTypedConstant | null;
}

export interface CalcItemConfig {
  item_name: string;
  operator_kind: number;
  left_operand: CalcOperandSpec | null;
  right_operand: CalcOperandSpec | null;
  operands: CalcOperandSpec[];
  decimal_places?: number;
}

export interface CalcOperandStatus {
  index: number;
  input_tag: string;
  ready: boolean;
  reason: string;
  quality: number;
  ts_ms: number;
}

export interface CalcItemInfo {
  config: CalcItemConfig | null;
  left_input_tag: string;
  right_input_tag: string;
  result_tag: string;
  input_tags: string[];
  operand_status: CalcOperandStatus[];
  last_error: string;
}

export interface CalcGroupConfig {
  group_name: string;
  items: CalcItemConfig[];
}

export interface CalcGroupInfo {
  config: CalcGroupConfig | null;
  conn_id: number;
  state: number;
  last_error: string;
  items: CalcItemInfo[];
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

export interface AgcDefaultPointInfo {
  kind: number;
  tag: string;
  name: string;
  description: string;
}

export interface AgcGroupInfo {
  config: AgcGroupConfig | null;
  conn_id: number;
  state: number;
  last_error: string;
  default_points: AgcDefaultPointInfo[];
  function_enabled: boolean;
  remote_enabled: boolean;
}

export interface AgcMemberControlProfile {
  member_name: string;
  up_p_gain: number;
  up_i_gain: number;
  down_p_gain: number;
  down_i_gain: number;
  up_bias_kw: number;
  down_bias_kw: number;
  integral_limit_kw: number;
  max_step_kw: number;
  max_ramp_kw_per_s: number;
  version: number;
  confirmed_at_ms: number;
}

export interface AgcControlProfile {
  group_name: string;
  members: AgcMemberControlProfile[];
  version: number;
  confirmed_at_ms: number;
}

export interface AgcTuningConfig {
  target_lower_kw: number;
  target_upper_kw: number;
  total_time_minutes: number;
  attempt_max_time_minutes: number;
  target_entry_time_seconds: number;
  stable_hold_time_seconds: number;
  min_up_tests: number;
  min_down_tests: number;
  total_tolerance_kw: number;
}

export interface AgcTuningStatus {
  group_name: string;
  state: number;
  direction: number;
  completed_up_tests: number;
  completed_down_tests: number;
  started_at_ms: number;
  elapsed_ms: number;
  current_target_kw: number;
  current_total_meas_kw: number;
  target_entry_elapsed_seconds: number;
  stable_elapsed_seconds: number;
  last_error: string;
  candidate_profile: AgcControlProfile | null;
}

export interface AvcSignalSpec {
  tag: string;
  unit: string;
  scale: number;
  offset: number;
}

export interface AvcValueSpec {
  signal: AvcSignalSpec | null;
  mode: number;
  delta_base: number;
  base_tag: string;
}

export interface AvcVoltageControlConfig {
  kp: number;
  deadband: number;
}

export interface AvcStrategyConfig {
  strategy_type: string;
}

export interface AvcMemberConfig {
  member_name: string;
  controllable: boolean;
  weight: number;
  q_min_kvar: number;
  q_max_kvar: number;
  q_meas: AvcSignalSpec | null;
  q_set: AvcValueSpec | null;
}

export interface AvcGroupConfig {
  group_name: string;
  voltage_meas: AvcSignalSpec | null;
  voltage_cmd: AvcSignalSpec | null;
  q_total_cmd: AvcValueSpec | null;
  voltage_control: AvcVoltageControlConfig | null;
  strategy: AvcStrategyConfig | null;
  members: AvcMemberConfig[];
}

export interface AvcDefaultPointInfo {
  kind: number;
  tag: string;
  name: string;
  description: string;
}

export interface AvcGroupInfo {
  config: AvcGroupConfig | null;
  conn_id: number;
  state: number;
  last_error: string;
  default_points: AvcDefaultPointInfo[];
  function_enabled: boolean;
  remote_enabled: boolean;
}

export interface Iec104ExportTask {
  link: {
    config: Iec104LinkConfig;
  };
  point_table: {
    conn_name: string;
    points: Iec104Point[];
    replace: true;
  };
}

export interface ModbusRtuExportTask {
  link: {
    config: ModbusLinkConfig;
  };
  point_table: {
    conn_name: string;
    points: ModbusPoint[];
    replace: true;
  };
}

export interface Dlt645ExportTask {
  link: {
    config: Dlt645LinkConfig;
  };
  point_table: {
    conn_name: string;
    points: Dlt645Point[];
    blocks: Dlt645Block[];
    replace: true;
  };
}

export interface AgcExportTask {
  upsert: {
    config: AgcGroupConfig;
  };
}

export interface AvcExportTask {
  upsert: {
    config: AvcGroupConfig;
  };
}

export interface StableDataBusEndpoint {
  module_name: string;
  conn_name: string;
  tag: string;
  conn_id?: number;
}

export interface StableDataBusRoute {
  src: StableDataBusEndpoint;
  dst: StableDataBusEndpoint;
}

export type ConfigExportSectionId = 'iec104' | 'modbus_rtu' | 'dlt645' | 'agc' | 'avc' | 'data_bus';

export interface ConfigExportMetadata {
  scope: 'full' | 'partial';
  included_sections: ConfigExportSectionId[];
}

export interface FullConfigExportSnapshot {
  schema_version: 1;
  exported_at: string;
  source: {
    app_version?: string;
    manager_addr: string;
  };
  module_startup: {
    source: 'get_running_module_info';
    modules: string[];
  };
  config: {
    iec104: {
      links: Iec104ExportTask[];
    };
    modbus_rtu: {
      mqtt: ModbusMqttConfig | null;
      links: ModbusRtuExportTask[];
    };
    dlt645: {
      mqtt: Dlt645MqttConfig | null;
      links: Dlt645ExportTask[];
    };
    agc: {
      groups: AgcExportTask[];
    };
    avc: {
      groups: AvcExportTask[];
    };
    data_bus: {
      routes: {
        replace: true;
        items: StableDataBusRoute[];
      };
    };
  };
  metadata: ConfigExportMetadata;
}
