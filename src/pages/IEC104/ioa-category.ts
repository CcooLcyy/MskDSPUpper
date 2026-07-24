export const MAX_IOA = 0xFFFFFF;

export type IoaBusinessCategoryKey =
  | 'teleindication'
  | 'telemetry'
  | 'remoteAdjust'
  | 'remoteControl'
  | 'parameter';

export type IoaCategoryKey = 'custom' | IoaBusinessCategoryKey;
export type IoaCategoryFilterKey = IoaBusinessCategoryKey | 'unclassified';

export type IoaCategoryOption = {
  value: IoaBusinessCategoryKey;
  label: string;
  start: number;
  end: number;
};

export const IOA_CATEGORY_OPTIONS: IoaCategoryOption[] = [
  { value: 'teleindication', label: '遥信', start: 0x0001, end: 0x4000 },
  { value: 'telemetry', label: '遥测', start: 0x4001, end: 0x6200 },
  { value: 'remoteAdjust', label: '遥调', start: 0x6201, end: 0x7FFF },
  { value: 'remoteControl', label: '遥控', start: 0x8000, end: 0x9FFF },
  { value: 'parameter', label: '参数', start: 0xA000, end: 0xBFFF },
];

export const IOA_CATEGORY_FORM_OPTIONS = [
  { value: 'custom', label: '自定义' },
  ...IOA_CATEGORY_OPTIONS,
];

export const IOA_CATEGORY_FILTER_OPTIONS = [
  ...IOA_CATEGORY_OPTIONS,
  { value: 'unclassified', label: '未分类' },
];

export const getIoaCategoryRange = (category: IoaCategoryKey) => {
  const option = IOA_CATEGORY_OPTIONS.find((item) => item.value === category);
  return option ? { start: option.start, end: option.end } : null;
};

export const getIoaCategoryByIoa = (ioa?: number | null): IoaCategoryKey => {
  if (typeof ioa !== 'number' || !Number.isInteger(ioa) || ioa < 1 || ioa > MAX_IOA) {
    return 'custom';
  }

  return IOA_CATEGORY_OPTIONS.find((option) => ioa >= option.start && ioa <= option.end)?.value ?? 'custom';
};

export const getIoaCategoryFilterByIoa = (ioa?: number | null): IoaCategoryFilterKey => {
  const category = getIoaCategoryByIoa(ioa);
  return category === 'custom' ? 'unclassified' : category;
};

export const matchesIoaCategoryFilter = (
  ioa: number,
  category: IoaCategoryFilterKey | undefined,
): boolean => category === undefined || getIoaCategoryFilterByIoa(ioa) === category;

export const getIoaCategoryLabel = (category: IoaCategoryFilterKey): string =>
  IOA_CATEGORY_FILTER_OPTIONS.find((option) => option.value === category)?.label ?? '未分类';
