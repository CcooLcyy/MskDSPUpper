export type SoftwareUpdateViewKey = 'upper' | 'lower';

export const SOFTWARE_UPDATE_VIEW_QUERY_KEY = 'view';
export const DEFAULT_SOFTWARE_UPDATE_VIEW: SoftwareUpdateViewKey = 'upper';

export const SOFTWARE_UPDATE_VIEW_OPTIONS: Array<{ label: string; value: SoftwareUpdateViewKey }> = [
  { label: '上位机更新', value: 'upper' },
  { label: '下位机更新', value: 'lower' },
];

export function normalizeSoftwareUpdateView(value: string | null | undefined): SoftwareUpdateViewKey {
  return value === 'lower' ? 'lower' : DEFAULT_SOFTWARE_UPDATE_VIEW;
}

export function createSoftwareUpdateViewSearch(search: string, view: SoftwareUpdateViewKey): string {
  const params = new URLSearchParams(search);

  if (view === DEFAULT_SOFTWARE_UPDATE_VIEW) {
    params.delete(SOFTWARE_UPDATE_VIEW_QUERY_KEY);
  } else {
    params.set(SOFTWARE_UPDATE_VIEW_QUERY_KEY, view);
  }

  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : '';
}
