export type ControlAllocationMode = 'equal' | 'proportional' | 'custom';

export type ControlAllocationMember = {
  controllable: boolean;
  weight: number;
  basis: number;
};

const nearlyEqual = (left: number, right: number): boolean => {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * scale * 16;
};

export const inferControlAllocationMode = (
  members: ControlAllocationMember[],
): ControlAllocationMode => {
  const controllable = members.filter((member) => member.controllable);
  if (controllable.length <= 1) return 'equal';

  const effectiveWeights = controllable.map((member) => member.weight > 0 ? member.weight : 1);
  if (effectiveWeights.every((weight) => nearlyEqual(weight, effectiveWeights[0]))) {
    return 'equal';
  }

  const first = controllable[0];
  if (
    first.basis > 0
    && first.weight > 0
    && controllable.every((member) => (
      member.basis > 0
      && member.weight > 0
      && nearlyEqual(member.weight * first.basis, first.weight * member.basis)
    ))
  ) {
    return 'proportional';
  }

  return 'custom';
};

export const resolveControlAllocationWeight = (
  mode: ControlAllocationMode,
  basis: number,
  currentWeight: number,
): number => {
  if (mode === 'equal') return 1;
  if (mode === 'proportional') return basis;
  return currentWeight;
};

export const calculateControlAllocationShares = (
  members: ControlAllocationMember[],
): number[] => {
  const totalWeight = members.reduce((total, member) => (
    member.controllable && Number.isFinite(member.weight) && member.weight > 0
      ? total + member.weight
      : total
  ), 0);

  return members.map((member) => {
    if (
      totalWeight <= 0
      || !member.controllable
      || !Number.isFinite(member.weight)
      || member.weight <= 0
    ) {
      return 0;
    }
    return member.weight / totalWeight;
  });
};
