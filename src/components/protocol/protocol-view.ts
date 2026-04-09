export type ProtocolViewKey = 'config' | 'logs';

export const PROTOCOL_VIEW_QUERY_KEY = 'view';
export const DEFAULT_PROTOCOL_VIEW: ProtocolViewKey = 'config';

export const PROTOCOL_VIEW_OPTIONS: Array<{ label: string; value: ProtocolViewKey }> = [
  {
    label: '\u8fde\u63a5\u914d\u7f6e',
    value: 'config',
  },
  {
    label: '\u62a5\u6587\u65e5\u5fd7',
    value: 'logs',
  },
];

export function normalizeProtocolView(value: string | null | undefined): ProtocolViewKey {
  return value === 'logs' ? 'logs' : DEFAULT_PROTOCOL_VIEW;
}

export function createProtocolViewSearch(search: string, view: ProtocolViewKey): string {
  const params = new URLSearchParams(search);

  if (view === DEFAULT_PROTOCOL_VIEW) {
    params.delete(PROTOCOL_VIEW_QUERY_KEY);
  } else {
    params.set(PROTOCOL_VIEW_QUERY_KEY, view);
  }

  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : '';
}
