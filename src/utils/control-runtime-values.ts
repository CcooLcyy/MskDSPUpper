import type { DcPointUpdate, DcSourcePointUpdate } from '../adapters';

export type ControlRuntimeUpdates = Record<string, DcPointUpdate>;

// 展示时钟每秒更新，容忍刚到达的点值比最近一次计时略晚。
export const CONTROL_RUNTIME_FUTURE_TOLERANCE_MS = 1000;

export interface ControlRuntimePointDetail {
  tag: string;
  update: DcPointUpdate | undefined;
  issues: string[];
}

/** 展开实际缓存的时间与质量问题，保持与既有运行摘要相同的判定规则。 */
export const describeControlRuntimePoints = (
  updates: ControlRuntimeUpdates,
  expectedTags: string[],
  nowMs: number,
  maxAgeMs: number,
): ControlRuntimePointDetail[] => [...new Set(expectedTags.filter(Boolean))].map((tag) => {
  const update = updates[tag];
  const issues: string[] = [];
  if (!update) return { tag, update, issues: ['点值缺失'] };
  const ageLimit = Number.isFinite(maxAgeMs) ? Math.max(0, maxAgeMs) : 0;
  if (!Number.isFinite(update.ts_ms) || update.ts_ms <= 0) issues.push('时间未知');
  else if (update.ts_ms - nowMs > CONTROL_RUNTIME_FUTURE_TOLERANCE_MS) issues.push('时间超前');
  else if (nowMs - update.ts_ms > ageLimit) issues.push('数据陈旧');
  if (update.quality !== 1) {
    issues.push(({ 0: '质量未指定', 2: '质量无效', 3: '质量不确定' } as Record<number, string>)[update.quality] ?? '质量未知');
  }
  return { tag, update, issues };
});

export interface ControlRuntimeSummary {
  state: 'waiting' | 'ok' | 'stale' | 'quality' | 'missing';
  latestTimestamp: number | null;
  staleCount: number;
  missingCount: number;
  uncertainCount: number;
}

/** 根据点值的实际时间和质量汇总展示状态，不修改原始运行值。 */
export const summarizeControlRuntime = (
  updates: ControlRuntimeUpdates,
  expectedTags: string[],
  nowMs: number,
  maxAgeMs: number,
): ControlRuntimeSummary => {
  const tags = [...new Set(expectedTags.filter(Boolean))];
  const summary: ControlRuntimeSummary = {
    state: 'waiting',
    latestTimestamp: null,
    staleCount: 0,
    missingCount: 0,
    uncertainCount: 0,
  };
  let observedCount = 0;
  const ageLimit = Number.isFinite(maxAgeMs) ? Math.max(0, maxAgeMs) : 0;

  tags.forEach((tag) => {
    const update = updates[tag];
    if (!update) {
      summary.missingCount += 1;
      return;
    }
    observedCount += 1;
    const knownTimestamp = Number.isFinite(update.ts_ms) && update.ts_ms > 0;
    if (knownTimestamp) {
      summary.latestTimestamp = Math.max(summary.latestTimestamp ?? update.ts_ms, update.ts_ms);
    }
    if (!knownTimestamp || update.ts_ms - nowMs > CONTROL_RUNTIME_FUTURE_TOLERANCE_MS || nowMs - update.ts_ms > ageLimit) {
      summary.staleCount += 1;
    }
    if (update.quality !== 1) {
      summary.uncertainCount += 1;
    }
  });

  if (observedCount > 0) {
    summary.state = summary.missingCount > 0 ? 'missing'
      : summary.staleCount > 0 ? 'stale'
        : summary.uncertainCount > 0 ? 'quality' : 'ok';
  }
  return summary;
};

/**
 * Read a BOOL state from the runtime snapshot while retaining the group DTO
 * value until the corresponding point has been observed.
 */
export const readControlRuntimeBool = (
  updates: ControlRuntimeUpdates,
  tag: string | null | undefined,
  fallback: boolean,
): boolean => {
  const value = tag ? updates[tag]?.value : null;
  return value?.type === 'Bool' ? value.value : fallback;
};

const toDestinationUpdate = (update: DcSourcePointUpdate): DcPointUpdate => ({
  src_conn_id: update.conn_id,
  src_tag: update.tag,
  dst_conn_id: update.conn_id,
  dst_tag: update.tag,
  value: update.value,
  ts_ms: update.ts_ms,
  quality: update.quality,
});

export const mergeControlRuntimeUpdates = (
  destinationUpdates: DcPointUpdate[],
  sourceUpdates: DcSourcePointUpdate[],
): ControlRuntimeUpdates => {
  const updates: ControlRuntimeUpdates = {};

  destinationUpdates.forEach((update) => {
    const tag = update.dst_tag || update.src_tag;
    if (tag) {
      updates[tag] = update;
    }
  });

  // 控制模块自己发布的设定值/派生点属于源端缓存，按源端值覆盖同名目的端值。
  sourceUpdates.forEach((update) => {
    if (update.tag) {
      updates[update.tag] = toDestinationUpdate(update);
    }
  });

  return updates;
};
