export type DataBusViewKey = 'config' | 'monitor';

export const DATA_BUS_VIEW_QUERY_KEY = 'view';
export const DEFAULT_DATA_BUS_VIEW: DataBusViewKey = 'config';

export const DATA_BUS_VIEW_OPTIONS: Array<{ label: string; value: DataBusViewKey }> = [
  { label: '拓扑配置', value: 'config' },
  { label: '运行监视', value: 'monitor' },
];

export function normalizeDataBusView(value: string | null | undefined): DataBusViewKey {
  return value === 'monitor' ? 'monitor' : DEFAULT_DATA_BUS_VIEW;
}

export function createDataBusViewSearch(search: string, view: DataBusViewKey): string {
  const params = new URLSearchParams(search);

  if (view === DEFAULT_DATA_BUS_VIEW) {
    params.delete(DATA_BUS_VIEW_QUERY_KEY);
  } else {
    params.set(DATA_BUS_VIEW_QUERY_KEY, view);
  }

  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : '';
}
