/**
 * 点表/分组配置 → DataCenter 标签注册表（ConnTags）派生。
 *
 * 规则来自下位机源码核对（见 `doc/离线工作区第一阶段方案.md` §4.7）：
 * 导出文件里的标签会被现场导入以 replace=true 覆盖注册表，
 * 少了任何标签都会静默剪除引用该标签的路由，因此必须逐字一致。
 *
 * 本模块是纯函数，不依赖适配器，便于用黄金用例做对照测试。
 */

import type {
  AgcGroupConfig,
  AvcGroupConfig,
  CalcGroupConfig,
  CalcItemConfig,
  Dlt645Block,
  Dlt645Point,
  Iec104Point,
  ModbusPoint,
} from '../../adapters/types.ts';

/** IEC104 对时标签默认值；模块内可被 config.time_sync_tag 覆盖。 */
export const IEC104_DEFAULT_TIME_SYNC_TAG = '__time_sync__';

/** AGC 固定默认点（模块内硬编码，组名不参与命名）。 */
export const AGC_DEFAULT_POINT_TAGS: readonly string[] = [
  '理论可调有功下限',
  '理论可调有功上限',
  '当前可调有功下限',
  '当前可调有功上限',
  '调节返回值',
  'AGC装机容量',
  'AGC功能投入',
  'AGC远方操作',
];

/** AVC 固定默认点（模块内硬编码，组名不参与命名）。 */
export const AVC_DEFAULT_POINT_TAGS: readonly string[] = [
  '理论可调无功下限',
  '理论可调无功上限',
  '当前可调无功下限',
  '当前可调无功上限',
  '调节返回值',
  '当前电压',
  '总无功目标',
  '总无功实测',
  '总无功偏差',
  '电压偏差',
  'AVC功能投入',
  'AVC远方操作',
];

export const DEVICE_INFO_RUNTIME_CONNECTION = 'device-runtime';
export const DEVICE_INFO_TAGS: readonly string[] = ['cpu.usage_percent', 'memory.usage_percent'];

export const BOARD_IO_DI_CONNECTION = 'board-di';
export const BOARD_IO_DO_CONNECTION = 'board-do';
export const BOARD_IO_DI_TAGS: readonly string[] = ['DI1', 'DI2', 'DI3', 'DI4'];
export const BOARD_IO_DO_TAGS: readonly string[] = ['DO1', 'DO2'];

/** 聚合运算符（求和/求平均）按 1-based 编号派生 input_N，其余按左右输入槽位派生。 */
export const CALC_AGGREGATE_OPERATOR_KINDS: readonly number[] = [9, 10];

/** 值模式：2 = 增量值。 */
export const VALUE_MODE_DELTA = 2;
/** 增量基准：3 = 指定 base_tag。 */
export const DELTA_BASE_TAG = 3;

type MaybeSignal = { tag?: string } | null | undefined;

type MaybeValueSpec = {
  signal?: MaybeSignal;
  mode?: number;
  delta_base?: number;
  base_tag?: string;
} | null | undefined;

export type DeriveTagsInput =
  | { module: 'IEC104'; points: readonly Iec104Point[]; timeSyncTag?: string }
  | { module: 'ModbusRTU' | 'ModbusTCP'; points: readonly ModbusPoint[] }
  | { module: 'DLT645'; points: readonly Dlt645Point[]; blocks?: readonly Dlt645Block[] }
  | { module: 'AGC'; config: AgcGroupConfig }
  | { module: 'AVC'; config: AvcGroupConfig }
  | { module: 'Calc'; config: CalcGroupConfig }
  | { module: 'DeviceInfo' }
  | { module: 'BoardIO'; connName: string };

/** 去重、去空并按字典序排序：与下位机导出 ConnTags 的排序一致。 */
export function sortTags(tags: readonly string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))).sort();
}

/** 单个计算项派生的标签：result + input_N（聚合）或 left/right_input（非聚合）。 */
export function deriveCalcItemTags(item: Pick<
  CalcItemConfig,
  'item_name' | 'operator_kind' | 'operands' | 'left_operand' | 'right_operand'
>): string[] {
  const itemName = String(item.item_name ?? '').trim();
  const tags = [`${itemName}/result`];

  if (CALC_AGGREGATE_OPERATOR_KINDS.includes(Number(item.operator_kind))) {
    const operandCount = Array.isArray(item.operands) ? item.operands.length : 0;

    for (let index = 0; index < operandCount; index += 1) {
      tags.push(`${itemName}/input_${index + 1}`);
    }
  } else {
    // 非聚合项（含 NOT 单操作数）在模块内始终注册左右两个输入槽位。
    tags.push(`${itemName}/left_input`, `${itemName}/right_input`);
  }

  return sortTags(tags);
}

export function deriveConnTags(input: DeriveTagsInput): string[] {
  switch (input.module) {
    case 'IEC104': {
      const tags = input.points.map((point) => point.tag);
      const timeSyncTag = String(input.timeSyncTag ?? '').trim() || IEC104_DEFAULT_TIME_SYNC_TAG;
      tags.push(timeSyncTag);

      return sortTags(tags);
    }
    case 'ModbusRTU':
    case 'ModbusTCP':
      return sortTags(input.points.map((point) => point.tag));
    case 'DLT645': {
      const tags = input.points.map((point) => point.tag);

      for (const block of input.blocks ?? []) {
        for (const item of block?.items ?? []) {
          tags.push(item.tag);
        }
      }

      return sortTags(tags);
    }
    case 'AGC':
      return sortTags(collectAgcTags(input.config));
    case 'AVC':
      return sortTags(collectAvcTags(input.config));
    case 'Calc':
      return sortTags((input.config?.items ?? []).flatMap((item) => deriveCalcItemTags(item)));
    case 'DeviceInfo':
      return sortTags(DEVICE_INFO_TAGS);
    case 'BoardIO': {
      if (input.connName === BOARD_IO_DO_CONNECTION) {
        return sortTags(BOARD_IO_DO_TAGS);
      }

      if (input.connName === BOARD_IO_DI_CONNECTION) {
        return sortTags(BOARD_IO_DI_TAGS);
      }

      throw new Error(`离线工作区暂不支持派生该连接的标签: BoardIO/${input.connName}`);
    }
    default: {
      const moduleName = (input as { module?: string }).module ?? '未知模块';

      throw new Error(`离线工作区暂不支持派生该模块的标签: ${moduleName}`);
    }
  }
}

function collectAgcTags(config: AgcGroupConfig | null | undefined): string[] {
  const tags: string[] = [...AGC_DEFAULT_POINT_TAGS];

  pushValueSpecTags(tags, config?.p_cmd);
  pushSignalTag(tags, config?.outputs?.p_total_meas);
  pushSignalTag(tags, config?.outputs?.p_total_target);
  pushSignalTag(tags, config?.outputs?.p_total_error);

  for (const member of config?.members ?? []) {
    pushSignalTag(tags, member?.p_meas);
    pushValueSpecTags(tags, member?.p_set);
  }

  return tags;
}

function collectAvcTags(config: AvcGroupConfig | null | undefined): string[] {
  const tags: string[] = [...AVC_DEFAULT_POINT_TAGS];

  pushSignalTag(tags, config?.voltage_meas);
  pushSignalTag(tags, config?.voltage_cmd);
  pushValueSpecTags(tags, config?.q_total_cmd);

  for (const member of config?.members ?? []) {
    pushSignalTag(tags, member?.q_meas);
    pushValueSpecTags(tags, member?.q_set);
  }

  return tags;
}

/** 追加值规格标签：信号 tag 始终注册，base_tag 仅在增量模式且基准为指定 tag 时注册。 */
function pushValueSpecTags(tags: string[], spec: MaybeValueSpec): void {
  if (!spec) {
    return;
  }

  pushSignalTag(tags, spec.signal);

  if (spec.mode === VALUE_MODE_DELTA && spec.delta_base === DELTA_BASE_TAG) {
    pushTag(tags, spec.base_tag);
  }
}

function pushSignalTag(tags: string[], signal: MaybeSignal): void {
  pushTag(tags, signal?.tag);
}

function pushTag(tags: string[], tag: unknown): void {
  if (typeof tag === 'string') {
    tags.push(tag);
  }
}
