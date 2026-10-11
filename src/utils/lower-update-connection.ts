import type { LowerUpdateSshAuth } from '../adapters/types';

export interface LowerUpdateConnectionSettings {
  upload_account: string;
  install_dir: string;
  auth_method: LowerUpdateSshAuth['method'];
  reuse_ssh_password_for_sudo: boolean;
  remember_password: boolean;
}

export interface LowerUpdateCredentials {
  ssh_password: string | null;
  sudo_password: string | null;
}

export function normalizeLowerUpdateUploadAccount(account: string): string {
  return account.trim().replace(/:(\d+)$/, (_match, port: string) => `:${Number(port)}`);
}

/** Windows 凭据目标名不区分 ASCII 大小写；仅索引统一，实际连接账号保持原值。 */
export function lowerUpdateCredentialAccountKey(account: string): string {
  return normalizeLowerUpdateUploadAccount(account).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** 普通设置只恢复白名单中的非敏感字段。 */
export function readLowerUpdateConnectionSettings(value: unknown): LowerUpdateConnectionSettings | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (typeof data.upload_account !== 'string' || typeof data.install_dir !== 'string'
    || (data.auth_method !== 'password' && data.auth_method !== 'certificate')
    || typeof data.reuse_ssh_password_for_sudo !== 'boolean' || typeof data.remember_password !== 'boolean') return null;
  const uploadAccount = data.upload_account.trim();
  const account = /^([A-Za-z_][A-Za-z0-9_-]*)@([^@:\s]+):(\d+)$/.exec(uploadAccount);
  if (!account || Number(account[3]) < 1 || Number(account[3]) > 65535
    || !/^\/[^\s]*$/.test(data.install_dir.trim())) return null;
  return {
    upload_account: `${account[1]}@${account[2]}:${Number(account[3])}`,
    install_dir: data.install_dir.trim().replace(/\/+$/, '') || '/',
    auth_method: data.auth_method,
    reuse_ssh_password_for_sudo: data.auth_method === 'password' && data.reuse_ssh_password_for_sudo,
    remember_password: data.remember_password,
  };
}

export const LOWER_UPDATE_CONNECTION_HISTORY_LIMIT = 20;

/** 恢复历史白名单并兼容旧单条设置，保持最近成功使用的顺序。 */
export function readLowerUpdateConnectionHistory(value: unknown, legacy?: unknown): LowerUpdateConnectionSettings[] {
  const entries = Array.isArray(value) ? [...value] : [];
  if (legacy) entries.push(legacy);
  const history: LowerUpdateConnectionSettings[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const settings = readLowerUpdateConnectionSettings(entry);
    if (!settings) continue;
    const key = lowerUpdateCredentialAccountKey(settings.upload_account);
    if (seen.has(key)) continue;
    seen.add(key);
    history.push(settings);
    if (history.length === LOWER_UPDATE_CONNECTION_HISTORY_LIMIT) break;
  }
  return history;
}

/** 仅成功保存后调用，将实际成功的目标配置移至首位。 */
export function upsertLowerUpdateConnectionHistory(history: unknown, settings: LowerUpdateConnectionSettings): LowerUpdateConnectionSettings[] {
  return readLowerUpdateConnectionHistory([settings, ...readLowerUpdateConnectionHistory(history)]);
}

/** 清除密码不删除历史地址，也不改变最近使用顺序。 */
export function clearLowerUpdateConnectionHistoryRememberPassword(history: unknown, account: string): LowerUpdateConnectionSettings[] {
  const key = lowerUpdateCredentialAccountKey(account);
  return readLowerUpdateConnectionHistory(history).map((entry) => lowerUpdateCredentialAccountKey(entry.upload_account) === key
    ? { ...entry, remember_password: false }
    : entry);
}

interface ConnectionRequest {
  upload_account: string;
  install_dir: string;
  auth: LowerUpdateSshAuth;
  sudo_password: string;
}

export function snapshotLowerUpdateConnection(request: ConnectionRequest, reuseSsh: boolean, remember: boolean) {
  return {
    settings: {
      upload_account: normalizeLowerUpdateUploadAccount(request.upload_account),
      install_dir: request.install_dir.trim().replace(/\/+$/, '') || '/',
      auth_method: request.auth.method,
      reuse_ssh_password_for_sudo: request.auth.method === 'password' && reuseSsh,
      remember_password: remember,
    } satisfies LowerUpdateConnectionSettings,
    auth: { ...request.auth },
    sudoPassword: request.sudo_password,
  };
}

export async function persistSuccessfulLowerUpdateConnection(
  snapshot: ReturnType<typeof snapshotLowerUpdateConnection>,
  effects: {
    save: (settings: LowerUpdateConnectionSettings, auth: LowerUpdateSshAuth, sudoPassword: string) => Promise<void>;
    cache: (settings: LowerUpdateConnectionSettings) => void;
    warn: (message: string) => void;
    canRemember?: () => boolean;
  },
): Promise<boolean> {
  // 清除或关闭记住密码已撤销旧操作的保存授权，旧回调不得覆盖新设置或新凭据。
  if (effects.canRemember && !effects.canRemember()) return false;
  const settings = { ...snapshot.settings };
  try {
    await effects.save(settings, snapshot.auth, snapshot.sudoPassword);
    effects.cache(settings);
    return true;
  } catch {
    // 不暴露凭据相关错误，也不把已成功的下发改判为失败。
    effects.warn('下发成功，但连接信息或密码保存失败，请下次重新输入');
    return false;
  }
}

/** 切换目标时同步使旧读取失效；分别保护用户已编辑的两个密码框。 */
export function createLowerUpdateCredentialReadGuard() {
  let revision = 0;
  const edits = { ssh: 0, sudo: 0 };
  return {
    invalidate() { revision += 1; },
    markEdited(field: keyof typeof edits) { edits[field] += 1; },
    begin() { return { revision, ...edits }; },
    canApply(token: { revision: number; ssh: number; sudo: number }, field: keyof typeof edits) {
      return token.revision === revision && token[field] === edits[field];
    },
  };
}

/** 跨页面共享撤销代次，并按目标串行保存与清除，防止旧成功回调恢复已删除的密码。 */
export function createLowerUpdateCredentialCoordinator() {
  const revisions = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();
  return {
    revision(account: string): number { return revisions.get(lowerUpdateCredentialAccountKey(account)) ?? 0; },
    revoke(account: string): void {
      const key = lowerUpdateCredentialAccountKey(account);
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
    },
    async run<T>(account: string, action: () => Promise<T>): Promise<T> {
      const key = lowerUpdateCredentialAccountKey(account);
      const previous = queues.get(key) ?? Promise.resolve();
      const task = previous.catch(() => {}).then(action);
      queues.set(key, task);
      try { return await task; }
      finally { if (queues.get(key) === task) queues.delete(key); }
    },
  };
}

export const lowerUpdateCredentialCoordinator = createLowerUpdateCredentialCoordinator();
