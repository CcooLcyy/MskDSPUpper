import type {
  AgcControlProfile,
  AgcGroupConfig,
  AgcMemberConfig,
  AgcMemberControlProfile,
  AgcSignalSpec,
  AgcTuningConfig,
  AgcTuningStatus,
  AgcValueSpec,
} from '../adapters/types';
import {
  getDecimalTextError,
  toDecimalInputText,
  toLegacyDecimalNumber,
} from './decimal-input';
import type { ControlAllocationMode } from './control-allocation';

const AGC_DECIMAL_SCALE = 10n ** 20n;
const AGC_DECIMAL_PATTERN = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?)(\d+))?$/;

type NumericRecord = Record<string, unknown>;

export const resolveAgcDecimalText = (
  source: object,
  legacyField: string,
  decimalField: string,
  fallback = '0',
): string => {
  const record = source as NumericRecord;
  const decimalValue = record[decimalField];
  if (typeof decimalValue === 'string' && decimalValue !== '') return decimalValue;
  const legacyValue = toDecimalInputText(record[legacyField]);
  return legacyValue || fallback;
};

export const createAgcDecimalFields = <LegacyField extends string, DecimalField extends string>(
  value: string,
  legacyField: LegacyField,
  decimalField: DecimalField,
): Record<LegacyField, number> & Record<DecimalField, string> => ({
  [legacyField]: toLegacyDecimalNumber(value),
  [decimalField]: value,
} as Record<LegacyField, number> & Record<DecimalField, string>);

const pow10 = (exponent: bigint): bigint => 10n ** exponent;

const roundHalfAwayFromZero = (coefficient: bigint, divisor: bigint): bigint => {
  const quotient = coefficient / divisor;
  const remainder = coefficient % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
};

const parseAgcDecimalUnits = (value: string): bigint => {
  const error = getDecimalTextError(value, 'AGC 工程量');
  if (error) throw new Error(error);

  const match = AGC_DECIMAL_PATTERN.exec(value);
  if (!match) throw new Error('AGC 工程量必须是完整十进制数');
  const integerPart = match[2] ?? '';
  const fractionalPart = match[3] ?? match[4] ?? '';
  const digits = `${integerPart}${fractionalPart}`.replace(/^0+/, '') || '0';
  let coefficient = BigInt(digits);
  if (coefficient === 0n) return 0n;

  const exponentMagnitude = BigInt(match[6] ?? '0');
  const exponent = match[5] === '-' ? -exponentMagnitude : exponentMagnitude;
  const shift = exponent - BigInt(fractionalPart.length) + 20n;
  if (shift >= 0n) {
    coefficient *= pow10(shift);
  } else {
    const divisorExponent = -shift;
    if (divisorExponent > BigInt(digits.length)) {
      coefficient = 0n;
    } else {
      coefficient = roundHalfAwayFromZero(coefficient, pow10(divisorExponent));
    }
  }
  return match[1] === '-' ? -coefficient : coefficient;
};

const formatAgcDecimalUnits = (units: bigint): string => {
  if (units === 0n) return '0';
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(21, '0');
  const integerPart = digits.slice(0, -20);
  if (integerPart.length > 100) {
    throw new Error('AGC 工程量的整数部分最多 100 位');
  }
  const fractionalPart = digits.slice(-20).replace(/0+$/, '');
  return `${negative ? '-' : ''}${integerPart}${fractionalPart ? `.${fractionalPart}` : ''}`;
};

export const compareAgcDecimalTexts = (left: string, right: string): -1 | 0 | 1 => {
  const leftUnits = parseAgcDecimalUnits(left);
  const rightUnits = parseAgcDecimalUnits(right);
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
};

export const addAgcDecimalTexts = (left: string, right: string): string => (
  formatAgcDecimalUnits(parseAgcDecimalUnits(left) + parseAgcDecimalUnits(right))
);

export const subtractAgcDecimalTexts = (left: string, right: string): string => (
  formatAgcDecimalUnits(parseAgcDecimalUnits(left) - parseAgcDecimalUnits(right))
);

export const multiplyAgcDecimalTexts = (left: string, right: string): string => {
  const product = parseAgcDecimalUnits(left) * parseAgcDecimalUnits(right);
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const result = roundHalfAwayFromZero(magnitude, AGC_DECIMAL_SCALE);
  return formatAgcDecimalUnits(negative ? -result : result);
};

export const absAgcDecimalText = (value: string): string => {
  const units = parseAgcDecimalUnits(value);
  return formatAgcDecimalUnits(units < 0n ? -units : units);
};

export const minAgcDecimalText = (left: string, right: string): string => (
  compareAgcDecimalTexts(left, right) <= 0 ? left : right
);

export const normalizeAgcSignalDecimalFields = (
  signal: AgcSignalSpec,
): AgcSignalSpec => {
  const scale = resolveAgcDecimalText(signal as unknown as NumericRecord, 'scale', 'scale_decimal', '1');
  const offset = resolveAgcDecimalText(signal as unknown as NumericRecord, 'offset', 'offset_decimal');
  return {
    ...signal,
    ...createAgcDecimalFields(scale, 'scale', 'scale_decimal'),
    ...createAgcDecimalFields(offset, 'offset', 'offset_decimal'),
  };
};

const normalizeValueSpec = (value: AgcValueSpec | null): AgcValueSpec | null => (
  value ? { ...value, signal: value.signal ? normalizeAgcSignalDecimalFields(value.signal) : null } : null
);

export const normalizeAgcMemberDecimalFields = (member: AgcMemberConfig): AgcMemberConfig => {
  const record = member as unknown as NumericRecord;
  const capacity = resolveAgcDecimalText(record, 'capacity_kw', 'capacity_kw_decimal');
  const weight = resolveAgcDecimalText(record, 'weight', 'weight_decimal', '1');
  const lower = resolveAgcDecimalText(record, 'min_kw', 'min_kw_decimal');
  const upper = resolveAgcDecimalText(record, 'max_kw', 'max_kw_decimal');
  return {
    ...member,
    ...createAgcDecimalFields(capacity, 'capacity_kw', 'capacity_kw_decimal'),
    ...createAgcDecimalFields(weight, 'weight', 'weight_decimal'),
    ...createAgcDecimalFields(lower, 'min_kw', 'min_kw_decimal'),
    ...createAgcDecimalFields(upper, 'max_kw', 'max_kw_decimal'),
    p_meas: member.p_meas ? normalizeAgcSignalDecimalFields(member.p_meas) : null,
    p_set: normalizeValueSpec(member.p_set),
  };
};

export const normalizeAgcGroupConfigDecimalFields = (config: AgcGroupConfig): AgcGroupConfig => ({
  ...config,
  p_cmd: normalizeValueSpec(config.p_cmd),
  members: config.members.map(normalizeAgcMemberDecimalFields),
  outputs: config.outputs ? {
    ...config.outputs,
    p_total_meas: config.outputs.p_total_meas
      ? normalizeAgcSignalDecimalFields(config.outputs.p_total_meas)
      : null,
    p_total_target: config.outputs.p_total_target
      ? normalizeAgcSignalDecimalFields(config.outputs.p_total_target)
      : null,
    p_total_error: config.outputs.p_total_error
      ? normalizeAgcSignalDecimalFields(config.outputs.p_total_error)
      : null,
  } : null,
});

const PROFILE_DECIMAL_FIELDS = [
  ['up_p_gain', 'up_p_gain_decimal'],
  ['up_i_gain', 'up_i_gain_decimal'],
  ['down_p_gain', 'down_p_gain_decimal'],
  ['down_i_gain', 'down_i_gain_decimal'],
  ['up_bias_kw', 'up_bias_kw_decimal'],
  ['down_bias_kw', 'down_bias_kw_decimal'],
  ['integral_limit_kw', 'integral_limit_kw_decimal'],
  ['max_step_kw', 'max_step_kw_decimal'],
  ['max_ramp_kw_per_s', 'max_ramp_kw_per_s_decimal'],
] as const;

export const normalizeAgcMemberControlProfileDecimalFields = (
  member: AgcMemberControlProfile,
): AgcMemberControlProfile => {
  const normalized: NumericRecord = { ...member };
  for (const [legacyField, decimalField] of PROFILE_DECIMAL_FIELDS) {
    Object.assign(
      normalized,
      createAgcDecimalFields(
        resolveAgcDecimalText(member as unknown as NumericRecord, legacyField, decimalField),
        legacyField,
        decimalField,
      ),
    );
  }
  return normalized as unknown as AgcMemberControlProfile;
};

export const normalizeAgcControlProfileDecimalFields = (
  profile: AgcControlProfile,
): AgcControlProfile => ({
  ...profile,
  members: profile.members.map(normalizeAgcMemberControlProfileDecimalFields),
});

export const normalizeAgcTuningConfigDecimalFields = (
  config: AgcTuningConfig,
): AgcTuningConfig => {
  const record = config as unknown as NumericRecord;
  const lower = resolveAgcDecimalText(record, 'target_lower_kw', 'target_lower_kw_decimal');
  const upper = resolveAgcDecimalText(record, 'target_upper_kw', 'target_upper_kw_decimal');
  const tolerance = resolveAgcDecimalText(record, 'total_tolerance_kw', 'total_tolerance_kw_decimal');
  return {
    ...config,
    ...createAgcDecimalFields(lower, 'target_lower_kw', 'target_lower_kw_decimal'),
    ...createAgcDecimalFields(upper, 'target_upper_kw', 'target_upper_kw_decimal'),
    ...createAgcDecimalFields(tolerance, 'total_tolerance_kw', 'total_tolerance_kw_decimal'),
  };
};

export const normalizeAgcTuningStatusDecimalFields = (
  status: AgcTuningStatus,
): AgcTuningStatus => {
  const record = status as unknown as NumericRecord;
  const target = resolveAgcDecimalText(record, 'current_target_kw', 'current_target_kw_decimal');
  const measured = resolveAgcDecimalText(record, 'current_total_meas_kw', 'current_total_meas_kw_decimal');
  return {
    ...status,
    ...createAgcDecimalFields(target, 'current_target_kw', 'current_target_kw_decimal'),
    ...createAgcDecimalFields(measured, 'current_total_meas_kw', 'current_total_meas_kw_decimal'),
    candidate_profile: status.candidate_profile
      ? normalizeAgcControlProfileDecimalFields(status.candidate_profile)
      : null,
  };
};

type AgcAllocationMember = Pick<
  AgcMemberConfig,
  'controllable' | 'weight' | 'weight_decimal' | 'capacity_kw' | 'capacity_kw_decimal'
>;

export const inferAgcAllocationMode = (members: AgcAllocationMember[]): ControlAllocationMode => {
  const controllable = members.filter((member) => member.controllable);
  if (controllable.length <= 1) return 'equal';

  const weightOf = (member: AgcAllocationMember): string => (
    compareAgcDecimalTexts(resolveAgcDecimalText(member, 'weight', 'weight_decimal', '1'), '0') > 0
      ? resolveAgcDecimalText(member, 'weight', 'weight_decimal', '1')
      : '1'
  );
  const firstWeight = weightOf(controllable[0]);
  if (controllable.every((member) => compareAgcDecimalTexts(weightOf(member), firstWeight) === 0)) {
    return 'equal';
  }

  const firstBasis = resolveAgcDecimalText(controllable[0], 'capacity_kw', 'capacity_kw_decimal');
  if (
    compareAgcDecimalTexts(firstBasis, '0') > 0
    && compareAgcDecimalTexts(firstWeight, '0') > 0
    && controllable.every((member) => {
      const basis = resolveAgcDecimalText(member, 'capacity_kw', 'capacity_kw_decimal');
      const weight = resolveAgcDecimalText(member, 'weight', 'weight_decimal');
      return compareAgcDecimalTexts(basis, '0') > 0
        && compareAgcDecimalTexts(weight, '0') > 0
        && parseAgcDecimalUnits(weight) * parseAgcDecimalUnits(firstBasis)
          === parseAgcDecimalUnits(firstWeight) * parseAgcDecimalUnits(basis);
    })
  ) {
    return 'proportional';
  }
  return 'custom';
};
