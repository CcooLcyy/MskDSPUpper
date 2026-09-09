import { POINT_BUSINESS_TYPE_REMOTE_CONTROL } from './ioa-category.ts';

export const REMOTE_CONTROL_TYPE_SINGLE = 1;
export const REMOTE_CONTROL_TYPE_DOUBLE = 2;

export const COMMAND_EXECUTION_MODE_DIRECT = 1;
export const COMMAND_EXECUTION_MODE_SELECT_EXECUTE = 2;

export const DEFAULT_REMOTE_CONTROL_FIELDS = {
  remote_control_type: REMOTE_CONTROL_TYPE_SINGLE,
  command_execution_mode: COMMAND_EXECUTION_MODE_SELECT_EXECUTE,
} as const;

export const REMOTE_CONTROL_TYPE_OPTIONS = [
  { value: REMOTE_CONTROL_TYPE_SINGLE, label: '单点遥控 (C_SC_NA_1)' },
  { value: REMOTE_CONTROL_TYPE_DOUBLE, label: '双点遥控 (C_DC_NA_1)' },
];

export const COMMAND_EXECUTION_MODE_OPTIONS = [
  { value: COMMAND_EXECUTION_MODE_DIRECT, label: '直接执行 (S/E=0)' },
  { value: COMMAND_EXECUTION_MODE_SELECT_EXECUTE, label: '选择后执行 (SBO)' },
];

export const getRemoteControlTypeLabel = (value: number): string =>
  REMOTE_CONTROL_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? `未知遥控类型 (${value})`;

export const getCommandExecutionModeLabel = (value: number): string =>
  COMMAND_EXECUTION_MODE_OPTIONS.find((option) => option.value === value)?.label ?? `未知执行方式 (${value})`;

export const isRemoteControlBusinessType = (businessType: number | undefined): boolean =>
  businessType === POINT_BUSINESS_TYPE_REMOTE_CONTROL;

export const normalizeRemoteControlFields = <T extends {
  remote_control_type?: number;
  command_execution_mode?: number;
}>(point: T): T & {
  remote_control_type: number;
  command_execution_mode: number;
} => ({
  ...point,
  remote_control_type: point.remote_control_type || REMOTE_CONTROL_TYPE_SINGLE,
  command_execution_mode: point.command_execution_mode || COMMAND_EXECUTION_MODE_SELECT_EXECUTE,
});
