export type ControlViewKey = 'strategy' | 'logs';

export const CONTROL_VIEW_QUERY_KEY = 'view';
export const DEFAULT_CONTROL_VIEW: ControlViewKey = 'strategy';

export const CONTROL_VIEW_OPTIONS: Array<{ label: string; value: ControlViewKey }> = [
  {
    label: '控制策略',
    value: 'strategy',
  },
  {
    label: '控制日志',
    value: 'logs',
  },
];

export function normalizeControlView(value: string | null | undefined): ControlViewKey {
  return value === 'logs' ? 'logs' : DEFAULT_CONTROL_VIEW;
}

export function createControlViewSearch(search: string, view: ControlViewKey): string {
  const params = new URLSearchParams(search);

  if (view === DEFAULT_CONTROL_VIEW) {
    params.delete(CONTROL_VIEW_QUERY_KEY);
  } else {
    params.set(CONTROL_VIEW_QUERY_KEY, view);
  }

  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : '';
}
