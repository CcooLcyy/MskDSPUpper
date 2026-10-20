export interface PlatformLoginSettings {
  grpc_endpoint: string;
  username: string;
  auto_login: boolean;
}

export interface PlatformAuthStatus {
  authenticated: boolean;
  username: string | null;
  display_name: string | null;
  connection_state: 'signed_out' | 'connecting' | 'online' | 'reconnecting';
  expires_at: number | null;
  message: string | null;
}

export interface PlatformAuthApi {
  getSettings(): Promise<PlatformLoginSettings>;
  saveSettings(settings: PlatformLoginSettings): Promise<PlatformLoginSettings>;
  login(username: string, password: string, autoLogin: boolean): Promise<PlatformAuthStatus>;
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

/** 只保留不含秘密的界面状态，密码直接交给桌面认证接口。 */
export function createPlatformAuthController(
  api: PlatformAuthApi,
  initializeWorkspace: () => Promise<void>,
  now: () => number = Date.now,
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
      lock('当前保留了其他账号的配置草稿，请重启程序后切换账号。');
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
        const settings = { ...loaded, username: normalizedUsername(loaded.username) };
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

  async function login(username: string, password: string, autoLogin: boolean) {
    if (['booting', 'authenticating', 'initializing'].includes(snapshot.phase) || snapshot.savingSettings || snapshot.endingSession) return;
    const account = normalizedUsername(username);
    if (snapshot.owner && account !== snapshot.owner) {
      update({ error: `配置草稿属于 ${snapshot.owner}，请使用原账号重新登录；切换账号需先重启程序。` });
      return;
    }
    const epoch = ++generation;
    update({ phase: 'authenticating', error: null });
    try {
      const status = normalizeStatus(await api.login(account, password, autoLogin));
      if (epoch !== generation) return;
      if (valid(status) && snapshot.settings) update({ settings: { ...snapshot.settings, username: status.username!, auto_login: autoLogin } });
      await initialize(status, epoch);
    } catch {
      if (epoch === generation) lock('登录失败，请检查账号、密码、账号启用状态及平台连接地址。');
    }
  }

  async function logout() {
    if (snapshot.endingSession) return;
    // 先同步锁定界面，再请求服务端退出，避免未完成的旧请求重新打开工作台。
    lock('已退出登录。保留的页面草稿可在本次程序运行中使用原账号登录后恢复。');
    update({ endingSession: true });
    try {
      await api.logout();
    } catch {
      update({ error: '已锁定工作台，退出请求未完成。请检查平台连接；服务端会话将按有效期失效。' });
    } finally {
      update({ endingSession: false });
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
    if (snapshot.savingSettings || snapshot.endingSession || ['booting', 'authenticating', 'initializing', 'authenticated'].includes(snapshot.phase)) return;
    if (snapshot.workspaceReady && settings.grpc_endpoint.trim() !== snapshot.settings?.grpc_endpoint) {
      update({ error: '当前保留了原平台账号的配置草稿，更换平台地址前请重启程序。' });
      return;
    }
    update({ savingSettings: true, error: null });
    try {
      const saved = await api.saveSettings({ ...settings, username: normalizedUsername(settings.username) });
      update({ settings: saved, status: null, phase: snapshot.workspaceReady ? 'locked' : 'signed_out' });
    } catch {
      update({ error: '平台连接设置保存失败，请检查 gRPC 地址格式及桌面运行环境。' });
    } finally {
      update({ savingSettings: false });
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start, login, logout, poll, tick, saveSettings,
    retryInitialization: async () => {
      if (snapshot.phase === 'initialization_failed' && snapshot.status) await initialize(snapshot.status, generation);
    },
  };
}

export type PlatformAuthController = ReturnType<typeof createPlatformAuthController>;
