export interface Dlt645PointLike {
  tag: string;
  di: string;
  data_len?: number | null;
  data_type?: number | null;
  byte_index?: number | null;
  bit_index?: number | null;
}

export type Dlt645PointConflict = 'tag' | 'di' | 'di_bit' | 'di_length' | null;

function isBitPoint(point: Dlt645PointLike): boolean {
  return point.data_type === 1 && point.bit_index !== null && point.bit_index !== undefined;
}

function byteIndex(point: Dlt645PointLike): number {
  return point.byte_index ?? 0;
}

/** 按 DLT645 点表约束查找当前候选点与已有点位的首个冲突。 */
export function findDlt645PointConflict(
  candidate: Dlt645PointLike,
  existingPoints: readonly Dlt645PointLike[],
  editingIndex = -1,
): Dlt645PointConflict {
  const candidateTag = candidate.tag.trim();
  const candidateDi = candidate.di.trim();
  for (const [index, existing] of existingPoints.entries()) {
    if (index === editingIndex) {
      continue;
    }

    if (candidateTag && existing.tag.trim() === candidateTag) {
      return 'tag';
    }
    if (!candidateDi || existing.di.trim() !== candidateDi) {
      continue;
    }

    const candidateIsBit = isBitPoint(candidate);
    const existingIsBit = isBitPoint(existing);
    if (!candidateIsBit || !existingIsBit) {
      return 'di';
    }
    if (byteIndex(candidate) === byteIndex(existing) && candidate.bit_index === existing.bit_index) {
      return 'di_bit';
    }
    if (candidate.data_len !== existing.data_len) {
      return 'di_length';
    }
  }
  return null;
}
