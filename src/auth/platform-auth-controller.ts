export interface PlatformLoginSettings {
  grpc_endpoint: string;
  username: string;
  auto_login: boolean;
  remember_password: boolean;
}

export type PlatformAccountRole = 'admin' | 'operator';

export interface PlatformAuthStatus {
  authenticated: boolean;
  username: string | null;
  display_name: string | null;
  role: PlatformAccountRole | null;
  connection_state: 'signed_out' | 'connecting' | 'online' | 'reconnecting';
  expires_at: number | null;
  message: string | null;
}

export interface PlatformAuthApi {
  getSettings(): Promise<PlatformLoginSettings>;
  saveSettings(settings: PlatformLoginSettings): Promise<PlatformLoginSettings>;
  login(username: string, password: string, autoLogin: boolean, rememberPassword: boolean): Promise<PlatformAuthStatus>;
  hasSavedPassword(username: string): Promise<boolean>;
  getSavedPassword(username: string): Promise<string | null>;
  autoLogin(): Promise<PlatformAuthStatus>;
  getStatus(): Promise<PlatformAuthStatus>;
  logout(): Promise<PlatformAuthStatus>;
}

export interface PlatformAuthSnapshot {
  phase: 'booting' | 'signed_out' | 'authenticating' | 'initializing' | 'initialization_failed' | 'authenticated' | 'locked';
  settings: PlatformLoginSettings | null;
  status: PlatformAuthStatus | null;
  workspaceReady: boolean;
  owner: string | null;
  error: string | null;
  savingSettings: boolean;
  endingSession: boolean;
}

export interface PlatformAuthLifecycle {
  prepareLogout?: () => void;
  resetWorkspace?: () => Promise<void>;
}

/** 仅转换桌面认证层的固定安全文案，不透传未知异常或凭据。 */
function loginFailureMessage(error: unknown, usingSavedPassword: boolean): string {
  const reason = typeof error === 'string' ? error : error instanceof Error ? error.message : null;
  switch (reason) {
    case '账号或密码错误，或账号已停用':
      return usingSavedPassword ? '账号或密码错误，请重新输入密码。' : '账号或密码错误，请重新输入。';
    case '无法连接平台，请检查网络、平台地址和证书':
      return '无法连接平台，请检查网络、平台地址和证书。';
    case '平台登录协议响应无效，请检查平台版本':
      return reason;
    default:
      return usingSavedPassword
        ? '无法使用已保存密码登录，请重新输入密码，并检查账号启用状态及平台连接地址。'
        : '登录失败，请检查账号、密码、账号启用状态及平台连接地址。';
  }
}

/** 只保留不含秘密的界面状态，密码直接交给桌面认证接口。 */
export function createPlatformAuthController(
  api: PlatformAuthApi,
  initializeWorkspace: () => Promise<void>,
  now: () => number = Date.now,
  lifecycle: PlatformAuthLifecycle = {},
) {
  let snapshot: PlatformAuthSnapshot = {
    phase: 'booting', settings: null, status: null, workspaceReady: false,
    owner: null, error: null, savingSettings: false, endingSession: false,
  };
  const listeners = new Set<() => void>();
  let startPromise: Promise<void> | null = null;
  let generation = 0;
  let polling = false;

  function update(patch: Partial<PlatformAuthSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
  }

  function lock(message: string) {
    generation += 1;
    update({ phase: snapshot.workspaceReady ? 'locked' : 'signed_out', status: null, error: message });
  }

  function valid(status: PlatformAuthStatus) {
    return status.authenticated && !!status.username && status.expires_at !== null && status.expires_at > now();
  }

  const normalizedUsername = (username: string) => username.trim().toLowerCase();
  const normalizeSettings = (settings: PlatformLoginSettings): PlatformLoginSettings => ({
    ...settings, username: normalizedUsername(settings.username), remember_password: settings.remember_password || settings.auto_login,
  });

  function normalizeStatus(status: PlatformAuthStatus): PlatformAuthStatus {
    return { ...status, username: status.username ? normalizedUsername(status.username) : null };
  }

  async function initialize(status: PlatformAuthStatus, epoch: number) {
    status = normalizeStatus(status);
    if (!valid(status)) {
      lock(status.message || '登录会话已失效，请重新登录。');
      return;
    }
    if (snapshot.owner && snapshot.owner !== status.username) {
      lock('当前保留了其他账号的配置草稿，请点击“退出并更换账号”后重新登录。');
      return;
    }
    update({ status, error: null });
    if (!snapshot.workspaceReady) {
      update({ phase: 'initializing' });
      try {
        await initializeWorkspace();
      } catch {
        if (epoch === generation) update({ phase: 'initialization_failed', error: '本地配置加载失败，已停止进入工作台以保护现有配置。请重试或退出登录。' });
        return;
      }
    }
    if (epoch !== generation) return;
    if (!valid(status)) {
      lock('登录会话已到期，请重新登录。');
      return;
    }
    update({ phase: 'authenticated', workspaceReady: true, owner: status.username, status, error: null });
  }

  async function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const epoch = generation;
      try {
        const loaded = await api.getSettings();
        const settings = normalizeSettings(loaded);
        if (epoch !== generation) return;
        update({ settings, phase: 'signed_out' });
        if (settings.auto_login) {
          update({ phase: 'authenticating' });
          const status = await api.autoLogin();
          if (epoch !== generation) return;
          await initialize(status, epoch);
        }
      } catch {
        if (epoch === generation) update({ phase: 'signed_out', error: '无法自动登录或读取平台连接设置。请检查桌面运行环境、平台地址及账号后手动登录。' });
      }
    })();
    return startPromise;
  }

  async function login(username: string, password: string, autoLogin: boolean, rememberPassword = false) {
    if (['booting', 'authenticating', 'initializing'].includes(snapshot.phase) || snapshot.savingSettings || snapshot.endingSession) return;
    const account = normalizedUsername(username);
    if (snapshot.owner && account !== snapshot.owner) {
      update({ error: `配置草稿属于 ${snapshot.owner}，请使用原账号重新登录，或点击“退出并更换账号”。` });
      return;
    }
    const epoch = ++generation;
    update({ phase: 'authenticating', error: null });
    try {
      const remember = rememberPassword || autoLogin;
      const status = normalizeStatus(await api.login(account, password, autoLogin, remember));
      if (epoch !== generation) return;
      if (valid(status) && snapshot.settings) update({ settings: { ...snapshot.settings, username: status.username!, auto_login: autoLogin, remember_password: remember } });
      await initialize(status, epoch);
    } catch (error) {
      if (epoch === generation) {
        const message = loginFailureMessage(error, !password);
        console.warn('平台登录未完成', { 提示: message });
        lock(message);
      }
    }
  }

  async function logout() {
    if (snapshot.endingSession || snapshot.savingSettings) return false;
    try {
      // 必须在锁定前检查不可中断的任务，拦截时保留完整工作台资格。
      lifecycle.prepareLogout?.();
    } catch (error) {
      update({ error: error instanceof Error ? error.message : '当前任务尚未完成，请稍后退出登录。' });
      return false;
    }
    // 先同步锁定界面，使晚到的会话和凭据响应失效。
    lock('正在退出登录并清理工作台。');
    update({ endingSession: true, error: null });
    try {
      if (snapshot.settings?.auto_login) {
        const settings = await api.saveSettings({ ...snapshot.settings, auto_login: false });
        update({ settings: normalizeSettings(settings) });
      }
      await api.logout();
      // 生产环境重载页面后不会返回；重建完成前持续锁定旧工作台。
      await lifecycle.resetWorkspace?.();
      update({ phase: 'signed_out', owner: null, workspaceReady: false, status: null, endingSession: false, error: null });
      return true;
    } catch {
      update({ endingSession: false, error: '退出登录未完成，当前工作台仍保持锁定。请重试退出并更换账号。' });
      return false;
    }
  }

  function tick() {
    if (snapshot.status?.authenticated && !valid(snapshot.status)) lock('登录会话已到期，请重新登录。当前页面草稿仍保留在内存中。');
  }

  async function poll() {
    tick();
    if (polling || snapshot.phase !== 'authenticated') return;
    polling = true;
    const epoch = generation;
    try {
      const status = normalizeStatus(await api.getStatus());
      if (epoch !== generation) return;
      if (!valid(status) || status.username !== snapshot.owner) {
        lock(status.message || '平台登录已失效，请重新登录。当前页面草稿仍保留在内存中。');
      } else {
        update({ status });
      }
    } catch {
      if (epoch === generation && snapshot.status) {
        tick();
        if (snapshot.phase === 'authenticated') update({ status: { ...snapshot.status!, connection_state: 'reconnecting', message: '平台暂时无法连接，会话到期前可继续本地配置。' } });
      }
    } finally {
      polling = false;
    }
  }

  async function saveSettings(settings: PlatformLoginSettings) {
    if (snapshot.savingSettings || snapshot.endingSession || ['booting', 'authenticating', 'initializing', 'authenticated'].includes(snapshot.phase)) return false;
    if (snapshot.workspaceReady && settings.grpc_endpoint.trim() !== snapshot.settings?.grpc_endpoint) {
      update({ error: '当前保留了原平台账号的配置草稿，更换平台地址前请先退出并更换账号。' });
      return false;
    }
    update({ savingSettings: true, error: null });
    try {
      const saved = await api.saveSettings(normalizeSettings(settings));
      update({ settings: normalizeSettings(saved), status: null, phase: snapshot.workspaceReady ? 'locked' : 'signed_out', error: null });
      return true;
    } catch {
      update({ error: '平台连接设置保存失败，请检查 gRPC 地址格式及桌面运行环境。' });
      return false;
    } finally {
      update({ savingSettings: false });
    }
  }

  async function hasSavedPassword(username: string) {
    const account = normalizedUsername(username);
    const settings = snapshot.settings;
    const epoch = generation;
    if (snapshot.endingSession || !account || !settings?.remember_password || account !== settings.username) return false;
    try {
      const saved = await api.hasSavedPassword(account);
      // 平台、账号或保存选项变化后，不采用旧查询结果。
      return saved && snapshot.settings === settings && epoch === generation && !snapshot.endingSession;
    } catch {
      return false;
    }
  }

  async function getSavedPassword(username: string) {
    const account = normalizedUsername(username);
    const settings = snapshot.settings;
    const epoch = generation;
    const canRead = () => ['signed_out', 'locked'].includes(snapshot.phase)
      && !snapshot.endingSession && !snapshot.savingSettings;
    if (!canRead() || !account || !settings?.remember_password || account !== settings.username
      || (snapshot.owner && account !== snapshot.owner)) return null;
    try {
      const password = await api.getSavedPassword(account);
      // 密码只交给当前表单；设置或会话变化后丢弃旧读取结果。
      return password && snapshot.settings === settings && generation === epoch && canRead() ? password : null;
    } catch {
      return null;
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start, login, logout, poll, tick, saveSettings, hasSavedPassword, getSavedPassword,
    retryInitialization: async () => {
      if (snapshot.phase === 'initialization_failed' && snapshot.status) await initialize(snapshot.status, generation);
    },
  };
}

export type PlatformAuthController = ReturnType<typeof createPlatformAuthController>;
