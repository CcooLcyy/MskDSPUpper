import type { AgcMemberConfig, AgcSignalSpec, DcPointUpdate } from '../adapters/types';
import { compareAgcDecimalTexts, resolveAgcDecimalText, subtractAgcDecimalTexts } from './agc-decimal.ts';
import { getDecimalTextError } from './decimal-input.ts';
import { summarizeControlRuntime } from './control-runtime-values.ts';

/** 输出只采用 AGC 源端快照；缺失源值时不得回退为同名路由输入。 */
export function selectAgcOverviewUpdates(
  updates: Record<string, DcPointUpdate>,
  publishedUpdates: Record<string, DcPointUpdate>,
  publishedTags: string[],
): Record<string, DcPointUpdate> {
  const selected = { ...updates };
  for (const tag of publishedTags.filter(Boolean)) {
    if (publishedUpdates[tag]) selected[tag] = publishedUpdates[tag];
    else delete selected[tag];
  }
  return selected;
}

/** 读取数字缓存原文；缺失或非数字点不能作为零参与运算。 */
export function readRuntimeNumericText(update: DcPointUpdate | null | undefined): string | null {
  const value = update?.value;
  if (!value || !['Decimal', 'Int', 'Double'].includes(value.type)) return null;
  const text = String(value.value);
  return getDecimalTextError(text, '运行值') ? null : text;
}

const identityConversion = (signal: AgcSignalSpec): boolean => (
  compareAgcDecimalTexts(resolveAgcDecimalText(signal, 'scale', 'scale_decimal', '1'), '1') === 0
  && compareAgcDecimalTexts(resolveAgcDecimalText(signal, 'offset', 'offset_decimal'), '0') === 0
);

/** 同单位、默认换算的可控成员按设定减实测比较缓存值，不代表设备执行确认。 */
export function getMemberRuntimeDifference(
  member: AgcMemberConfig,
  measurement: DcPointUpdate | null | undefined,
  setpoint: DcPointUpdate | null | undefined,
): string | null {
  const measureSignal = member.p_meas;
  const setSignal = member.p_set?.signal;
  if (!member.controllable || member.p_set?.mode !== 1 || !measureSignal || !setSignal) return null;
  const measureUnit = measureSignal.unit.trim();
  if (measureUnit !== 'kW' || setSignal.unit.trim() !== 'kW') return null;
  const measureText = readRuntimeNumericText(measurement);
  const setText = readRuntimeNumericText(setpoint);
  if (measureText === null || setText === null) return null;
  try {
    if (!identityConversion(measureSignal) || !identityConversion(setSignal)) return null;
    return subtractAgcDecimalTexts(setText, measureText);
  } catch {
    return null;
  }
}

/** 复用已有新鲜度规则，连接异常时明确显示缓存值。 */
export function runtimePointState(update: DcPointUpdate | undefined, nowMs: number, maxAgeMs: number, offline: boolean): string {
  if (offline) return '连接异常 · 缓存值';
  if (!update) return '点值缺失';
  const summary = summarizeControlRuntime({ point: update }, ['point'], nowMs, maxAgeMs);
  if (summary.staleCount > 0) return '数据陈旧';
  if (summary.uncertainCount > 0) return '质量异常';
  if (readRuntimeNumericText(update) === null) return '数值异常';
  return '新鲜 · 有效';
}


/** 按通信心跳显示参与条件；仅用于监视，实际控制资格由下位机独立判断。 */
export function memberCommunicationState(
  member: Pick<AgcMemberConfig, 'controllable' | 'communication_state' | 'communication_timeout_ms'>,
  update: DcPointUpdate | undefined,
  nowMs: number,
  offline: boolean,
): { label: string; eligible: boolean; reason: string } {
  const result = (label: string, healthy = false) => ({
    label, eligible: member.controllable && healthy,
    reason: !member.controllable ? '仅参与测量' : healthy ? '满足通信参与条件' : label,
  });
  if (!member.communication_state?.tag) return { label: '未关联', eligible: member.controllable, reason: member.controllable ? '沿用原参与规则' : '仅参与测量' };
  if (offline) return result('查询异常');
  if (!update) return result('等待通信状态');
  if (update.quality !== 1 || (update.quality_flags != null && update.quality_flags !== 0)) return result('质量异常');
  const timeout = member.communication_timeout_ms || 30000;
  if (!Number.isFinite(update.ts_ms) || update.ts_ms <= 0 || update.ts_ms > nowMs) return result('时间异常');
  if (nowMs - update.ts_ms > timeout) return result('心跳超时');
  const value = readRuntimeNumericText(update);
  if (value === null) return result('状态值无效');
  for (const [code, label] of [['0', '未知'], ['1', '通信正常'], ['2', '通信异常'], ['3', '已停止']]) {
    if (compareAgcDecimalTexts(value, code) === 0) return result(label, code === '1');
  }
  return result('状态值无效');
}
