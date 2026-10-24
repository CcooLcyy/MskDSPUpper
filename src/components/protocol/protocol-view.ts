export type ProtocolViewKey = 'config' | 'soe' | 'logs';
export type ProtocolPointTableView = 'config' | 'runtime';

// 点表沿用现有列定义；工作台视图只决定展示，不触发保存或运行操作。
export function protocolPointTableView(view: 'engineering' | 'runtime'): ProtocolPointTableView {
  return view === 'runtime' ? 'runtime' : 'config';
}

export function workbenchViewFromPointTable(view: ProtocolPointTableView): 'engineering' | 'runtime' {
  return view === 'runtime' ? 'runtime' : 'engineering';
}

export const PROTOCOL_VIEW_QUERY_KEY = 'view';
export const DEFAULT_PROTOCOL_VIEW: ProtocolViewKey = 'config';

export const PROTOCOL_VIEW_OPTIONS: Array<{ label: string; value: ProtocolViewKey }> = [
  {
    label: '\u8fde\u63a5\u914d\u7f6e',
    value: 'config',
  },
  {
    label: '\u0053\u004f\u0045\u5386\u53f2',
    value: 'soe',
  },
  {
    label: '\u62a5\u6587\u65e5\u5fd7',
    value: 'logs',
  },
];

export function normalizeProtocolView(value: string | null | undefined, includeSoe = false): ProtocolViewKey {
  if (value === 'logs') return 'logs';
  if (includeSoe && value === 'soe') return 'soe';
  return DEFAULT_PROTOCOL_VIEW;
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
