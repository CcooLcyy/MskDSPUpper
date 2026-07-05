export const ADVANCED_CONFIG_PATH = '/advanced-config';

const ADVANCED_CONFIG_AUTH_KEY = 'mskdsp.upper.advanced_config.authorized';
const ADVANCED_CONFIG_PASSWORD = 'Meg@admin123';

function getSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function isAdvancedConfigAuthorized(): boolean {
  return getSessionStorage()?.getItem(ADVANCED_CONFIG_AUTH_KEY) === '1';
}

export function authorizeAdvancedConfigSession(): void {
  getSessionStorage()?.setItem(ADVANCED_CONFIG_AUTH_KEY, '1');
}

export function revokeAdvancedConfigSession(): void {
  getSessionStorage()?.removeItem(ADVANCED_CONFIG_AUTH_KEY);
}

export function isAdvancedConfigPasswordValid(password: string): boolean {
  return password === ADVANCED_CONFIG_PASSWORD;
}
