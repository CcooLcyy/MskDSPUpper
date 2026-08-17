import type { Iec104Point } from '../../adapters';
import { getIoaCategoryLabel, getIoaCategoryRange, type IoaCategoryKey } from './ioa-category';

export const BATCH_POINT_TYPE_FLOAT = 1;
export const BATCH_POINT_TYPE_SINGLE = 2;
const MAX_BATCH_POINT_IOA = 0xFFFFFF;

export type BatchPointDraft = Iec104Point & {
  key: string;
  sourceLine: number;
  ioa_category: IoaCategoryKey;
};

export type BatchPointIssue = {
  line: number;
  message: string;
};

export type GenerateBatchPointsOptions = {
  text: string;
  startIoa: number;
  step: number;
  ioaCategory?: IoaCategoryKey;
  pointType: number;
  scale: number;
  offset: number;
  deadband: number;
  occupiedTags?: ReadonlySet<string>;
  occupiedIoas?: ReadonlySet<number>;
};

export type GenerateBatchPointsResult = {
  drafts: BatchPointDraft[];
  issues: BatchPointIssue[];
};

const isFiniteNumber = (value: number): boolean => Number.isFinite(value);

const getBatchPointCategoryLabel = (category: IoaCategoryKey): string =>
  category === 'custom' ? '自定义' : getIoaCategoryLabel(category);

export const parseBatchPointNames = (text: string): Array<{ line: number; tag: string }> =>
  text
    .split(/\r\n|\n|\r/)
    .map((value, index) => ({ line: index + 1, tag: value.trim() }))
    .filter((item) => item.tag.length > 0);

export const generateBatchPoints = ({
  text,
  startIoa,
  step,
  ioaCategory = 'custom',
  pointType,
  scale,
  offset,
  deadband,
  occupiedTags = new Set<string>(),
  occupiedIoas = new Set<number>(),
}: GenerateBatchPointsOptions): GenerateBatchPointsResult => {
  const names = parseBatchPointNames(text);
  const issues: BatchPointIssue[] = [];
  const hasValidStart = Number.isInteger(startIoa) && startIoa >= 1 && startIoa <= MAX_BATCH_POINT_IOA;
  const hasValidStep = Number.isInteger(step) && step >= 1;
  const hasValidType = pointType === BATCH_POINT_TYPE_FLOAT || pointType === BATCH_POINT_TYPE_SINGLE;
  const ioaCategoryRange = getIoaCategoryRange(ioaCategory);

  if (names.length === 0) {
    issues.push({ line: 0, message: '请至少输入一个点名' });
  }
  if (!hasValidStart) {
    issues.push({ line: 0, message: `起始 IOA 必须为 1 - ${MAX_BATCH_POINT_IOA} 的整数` });
  }
  if (!hasValidStep) {
    issues.push({ line: 0, message: '步长必须为正整数' });
  }
  if (ioaCategoryRange && hasValidStart && (startIoa < ioaCategoryRange.start || startIoa > ioaCategoryRange.end)) {
    issues.push({
      line: 0,
      message: `起始 IOA 必须位于${getBatchPointCategoryLabel(ioaCategory)}范围 ${ioaCategoryRange.start} - ${ioaCategoryRange.end} 内`,
    });
  }
  if (!hasValidType) {
    issues.push({ line: 0, message: '请选择有效的点位类型' });
  }
  if (pointType === BATCH_POINT_TYPE_FLOAT) {
    if (!isFiniteNumber(scale)) {
      issues.push({ line: 0, message: 'Scale 必须是有效数字' });
    }
    if (!isFiniteNumber(offset)) {
      issues.push({ line: 0, message: 'Offset 必须是有效数字' });
    }
    if (!isFiniteNumber(deadband) || deadband < 0) {
      issues.push({ line: 0, message: 'Deadband 必须大于等于 0' });
    }
  }

  const safeStart = Number.isFinite(startIoa) ? Math.trunc(startIoa) : 0;
  const safeStep = Number.isFinite(step) ? Math.trunc(step) : 1;
  const normalizedScale = pointType === BATCH_POINT_TYPE_SINGLE ? 1 : scale;
  const normalizedOffset = pointType === BATCH_POINT_TYPE_SINGLE ? 0 : offset;
  const normalizedDeadband = pointType === BATCH_POINT_TYPE_SINGLE ? 0 : deadband;
  const batchTagCounts = new Map<string, number>();
  const batchIoaCounts = new Map<number, number>();

  names.forEach(({ tag }, index) => {
    const ioa = safeStart + index * safeStep;
    batchTagCounts.set(tag, (batchTagCounts.get(tag) ?? 0) + 1);
    batchIoaCounts.set(ioa, (batchIoaCounts.get(ioa) ?? 0) + 1);
  });

  const drafts = names.map(({ line, tag }, index) => {
    const ioa = safeStart + index * safeStep;
    const key = `batch-${line}-${index}`;

    if (tag.length > 128) {
      issues.push({ line, message: '标签不能超过 128 个字符' });
    }
    if (occupiedTags.has(tag)) {
      issues.push({ line, message: `标签 ${tag} 已存在于当前点表` });
    }
    if ((batchTagCounts.get(tag) ?? 0) > 1) {
      issues.push({ line, message: `标签 ${tag} 在批量输入中重复` });
    }

    if (!Number.isInteger(ioa) || ioa < 1 || ioa > MAX_BATCH_POINT_IOA) {
      issues.push({ line, message: `生成的 IOA ${ioa} 超出 1 - ${MAX_BATCH_POINT_IOA} 范围` });
    } else {
      if (ioaCategoryRange && (ioa < ioaCategoryRange.start || ioa > ioaCategoryRange.end)) {
        issues.push({
          line,
          message: `IOA ${ioa} 不在${getBatchPointCategoryLabel(ioaCategory)} IOA 范围 ${ioaCategoryRange.start} - ${ioaCategoryRange.end} 内`,
        });
      }
      if (occupiedIoas.has(ioa)) {
        issues.push({ line, message: `IOA ${ioa} 已存在于当前点表` });
      }
      if ((batchIoaCounts.get(ioa) ?? 0) > 1) {
        issues.push({ line, message: `IOA ${ioa} 在批量生成结果中重复` });
      }
    }

    return {
      key,
      sourceLine: line,
      tag,
      ioa,
      ioa_category: ioaCategory,
      point_type: pointType,
      scale: normalizedScale,
      offset: normalizedOffset,
      deadband: normalizedDeadband,
    };
  });

  return { drafts, issues };
};
