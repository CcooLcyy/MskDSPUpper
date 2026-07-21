export type ControlModule = 'agc' | 'avc';

export const CONTROL_MODULE_QUERY_KEY = 'module';

export const CONTROL_MODULE_OPTIONS: Array<{ label: string; value: ControlModule }> = [
  { label: 'AGC', value: 'agc' },
  { label: 'AVC', value: 'avc' },
];

export function normalizeControlModule(value: string | null | undefined): ControlModule {
  return value === 'avc' ? 'avc' : 'agc';
}

export function createControlModuleSearch(search: string, module: ControlModule): string {
  const params = new URLSearchParams(search);

  if (module === 'agc') {
    params.delete(CONTROL_MODULE_QUERY_KEY);
  } else {
    params.set(CONTROL_MODULE_QUERY_KEY, module);
  }

  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : '';
}
