import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformAuthController } from '../../src/auth/platform-auth-controller.ts';

const settings = { grpc_endpoint: 'http://localhost:50000', username: 'alice', auto_login: false, remember_password: false };
const signedOut = { authenticated: false, username: null, display_name: null, role: null, connection_state: 'signed_out', expires_at: null, message: null };
const loggedIn = (expires = 10000) => ({ authenticated: true, username: 'alice', display_name: 'Alice', role: 'operator', connection_state: 'online', expires_at: expires, message: null });
function fixture(overrides = {}, lifecycle = {}) {
  let now = 1000;
  const calls = [];
  const api = {
    getSettings: async () => settings,
    saveSettings: async value => { calls.push(['settings', value]); return value; },
    login: async (...args) => { calls.push(['login', ...args]); return loggedIn(); },
    autoLogin: async () => { calls.push(['auto']); return loggedIn(); },
    hasSavedPassword: async username => { calls.push(['saved', username]); return true; },
    getSavedPassword: async username => { calls.push(['password', username]); return 'saved-secret'; },
    getStatus: async () => signedOut,
    logout: async () => { calls.push(['logout']); return signedOut; },
    ...overrides,
  };
  const controller = createPlatformAuthController(api, async () => calls.push(['initialize']), () => now, { resetWorkspace: async () => { calls.push(['reset']); }, ...lifecycle });
  return { controller, calls, setNow: value => { now = value; } };
}

test('role changes refresh account identity without reinitializing retained workspace', async () => {
  let status = loggedIn();
  const { controller, calls } = fixture({ getStatus: async () => status });
  await controller.start();
  await controller.login('alice', 'secret', false);
  for (const role of ['admin', 'operator']) {
    status = { ...loggedIn(), role, display_name: '新的显示名' };
    await controller.poll();
    assert.equal(controller.getSnapshot().status.role, role);
    assert.equal(controller.getSnapshot().status.display_name, '新的显示名');
    assert.equal(controller.getSnapshot().workspaceReady, true);
    assert.equal(controller.getSnapshot().phase, 'authenticated');
  }
  assert.equal(calls.filter(call => call[0] === 'initialize').length, 1);
  status = signedOut;
  await controller.poll();
  assert.equal(controller.getSnapshot().status, null);
  await controller.login('alice', 'secret', false);
  assert.equal(calls.filter(call => call[0] === 'initialize').length, 1);
});

test('network failure retains last known role until lease expiry clears identity', async () => {
  const { controller, setNow } = fixture({
    login: async () => ({ ...loggedIn(), role: 'admin' }),
    getStatus: async () => { throw Error('network'); },
  });
  await controller.start();
  await controller.login('alice', 'secret', false);
  await controller.poll();
  assert.equal(controller.getSnapshot().status.role, 'admin');
  setNow(10000);
  controller.tick();
  assert.equal(controller.getSnapshot().phase, 'locked');
  assert.equal(controller.getSnapshot().status, null);
});
test('first startup never initializes business settings before successful login', async () => {
  const { controller, calls } = fixture();
  await controller.start();
  assert.equal(controller.getSnapshot().workspaceReady, false);
  assert.equal(controller.getSnapshot().phase, 'signed_out');
  assert.deepEqual(calls, []);
  await controller.login('alice', 'secret', false);
  assert.equal(controller.getSnapshot().phase, 'authenticated');
  assert.equal(controller.getSnapshot().workspaceReady, true);
  assert.deepEqual(calls.map(call => call[0]), ['login', 'initialize']);
  assert.ok(!JSON.stringify(controller.getSnapshot()).includes('secret'));
});
test('automatic login runs once and failure stays on login page', async () => {
  const { controller, calls } = fixture({ getSettings: async () => ({ ...settings, auto_login: true }), autoLogin: async () => { calls.push(['auto']); throw Error('failed'); } });
  await Promise.all([controller.start(), controller.start()]);
  await controller.start();
  assert.equal(calls.filter(call => call[0] === 'auto').length, 1);
  assert.equal(controller.getSnapshot().workspaceReady, false);
  assert.equal(controller.getSnapshot().phase, 'signed_out');
});
test('successful automatic login initializes once and enters workbench', async () => {
  const { controller, calls } = fixture({ getSettings: async () => ({ ...settings, auto_login: true }) });
  await controller.start();
  await controller.start();
  assert.equal(controller.getSnapshot().phase, 'authenticated');
  assert.deepEqual(calls.map(call => call[0]), ['auto', 'initialize']);
});
test('failed login never opens business configuration', async () => {
  const { controller } = fixture({ login: async () => { throw Error('401'); } });
  await controller.start();
  await controller.login('alice', 'wrong', false);
  assert.equal(controller.getSnapshot().phase, 'signed_out');
  assert.equal(controller.getSnapshot().workspaceReady, false);
});
test('temporary status failure keeps valid lease; expiry locks while retaining drafts', async () => {
  const { controller, setNow } = fixture({ getStatus: async () => { throw Error('network'); } });
  await controller.start();
  await controller.login('alice', 'secret', false);
  await controller.poll();
  assert.equal(controller.getSnapshot().phase, 'authenticated');
  assert.equal(controller.getSnapshot().status.connection_state, 'reconnecting');
  setNow(10000);
  controller.tick();
  assert.equal(controller.getSnapshot().phase, 'locked');
  assert.equal(controller.getSnapshot().workspaceReady, true);
  await controller.login('alice', 'secret', false);
  assert.equal(controller.getSnapshot().phase, 'locked', 'expired login result cannot reopen application');
});
test('explicit server revocation locks immediately and same account login restores drafts', async () => {
  const { controller, calls } = fixture();
  await controller.start();
  await controller.login('alice', 'secret', false);
  await controller.poll();
  assert.equal(controller.getSnapshot().phase, 'locked');
  await controller.login('alice', 'secret', false);
  assert.equal(controller.getSnapshot().phase, 'authenticated');
  assert.equal(calls.filter(call => call[0] === 'initialize').length, 1);
  await controller.poll();
  await controller.login('bob', 'secret', false);
  assert.equal(calls.filter(call => call[0] === 'login').length, 2, 'cannot send other account login while drafts remain');
  assert.equal(controller.getSnapshot().phase, 'locked');
});
test('duplicate login is suppressed and stale login completion cannot undo logout', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { controller, calls } = fixture({ login: async () => { calls.push(['login']); return pending; } });
  await controller.start();
  const first = controller.login('alice', 'secret', false);
  await controller.login('alice', 'secret', false);
  assert.equal(calls.filter(call => call[0] === 'login').length, 1);
  await controller.logout();
  resolve(loggedIn());
  await first;
  assert.equal(controller.getSnapshot().phase, 'signed_out');
  assert.equal(controller.getSnapshot().workspaceReady, false);
});
test('initialization failure blocks business mounting and can be retried', async () => {
  let attempts = 0;
  const api = {
    getSettings: async () => settings, saveSettings: async value => value,
    login: async () => loggedIn(), autoLogin: async () => signedOut,
    getStatus: async () => signedOut, logout: async () => signedOut,
  };
  const c = createPlatformAuthController(api, async () => { if (++attempts === 1) throw Error('settings'); }, () => 1000);
  await c.start();
  await c.login('alice', 'secret', false);
  assert.equal(c.getSnapshot().workspaceReady, false);
  assert.equal(c.getSnapshot().phase, 'initialization_failed');
  await c.retryInitialization();
  assert.equal(c.getSnapshot().workspaceReady, true);
});
test('connection settings can be saved without loading configuration', async () => {
  const { controller, calls } = fixture();
  await controller.start();
  await controller.saveSettings({ ...settings, grpc_endpoint: 'https://platform.example:50000' });
  assert.equal(controller.getSnapshot().settings.grpc_endpoint, 'https://platform.example:50000');
  assert.deepEqual(calls.map(call => call[0]), ['settings']);
});
test('stale status result cannot unlock or update an explicitly logged out application', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { controller } = fixture({ getStatus: async () => pending });
  await controller.start();
  await controller.login('alice', 'secret', true);
  const poll = controller.poll();
  await controller.logout();
  resolve(loggedIn());
  await poll;
  assert.equal(controller.getSnapshot().phase, 'signed_out');
  assert.equal(controller.getSnapshot().status, null);
});
test('lease expiry during slow initialization never mounts business providers', async () => {
  let resolve;
  let now = 1000;
  const pending = new Promise(done => { resolve = done; });
  const api = { getSettings: async () => settings, saveSettings: async value => value, login: async () => loggedIn(), autoLogin: async () => signedOut, getStatus: async () => signedOut, logout: async () => signedOut };
  const c = createPlatformAuthController(api, () => pending, () => now);
  await c.start();
  const login = c.login('alice', 'secret', false);
  await Promise.resolve();
  now = 10000;
  c.tick();
  resolve();
  await login;
  assert.equal(c.getSnapshot().workspaceReady, false);
  assert.equal(c.getSnapshot().phase, 'signed_out');
});
test('new login waits until pending logout completes', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { controller, calls } = fixture({ logout: async () => pending });
  await controller.start();
  await controller.login('alice', 'secret', false);
  const logout = controller.logout();
  await controller.login('alice', 'secret', false);
  assert.equal(calls.filter(call => call[0] === 'login').length, 1);
  resolve(signedOut);
  await logout;
  await controller.login('alice', 'secret', false);
  assert.equal(calls.filter(call => call[0] === 'login').length, 2);
});
test('retained drafts cannot be reopened against a different platform with the same username', async () => {
  const { controller, calls } = fixture();
  await controller.start();
  await controller.login('alice', 'secret', false);
  await controller.poll();
  await controller.saveSettings({ ...settings, grpc_endpoint: 'https://another-platform.example:50000' });
  assert.equal(calls.filter(call => call[0] === 'settings').length, 0);
  assert.equal(controller.getSnapshot().settings.grpc_endpoint, settings.grpc_endpoint);
  assert.equal(controller.getSnapshot().phase, 'locked');
});
test('usernames follow platform lowercase rules across settings, login and retained drafts', async () => {
  const { controller, calls } = fixture({ getSettings: async () => ({ ...settings, username: ' Alice ' }) });
  await controller.start();
  assert.equal(controller.getSnapshot().settings.username, 'alice');
  await controller.login(' ALICE ', 'secret', false);
  assert.equal(calls.find(call => call[0] === 'login')[1], 'alice');
  assert.equal(controller.getSnapshot().settings.username, 'alice');
  await controller.poll();
  await controller.login(' Alice ', 'secret', false);
  assert.equal(controller.getSnapshot().phase, 'authenticated');
});

// 仅记住密码不能在启动时擅自登录，也不把秘密放入界面快照。
test('remembered password waits for manual login and keeps independent preferences', async () => {
  const { controller, calls } = fixture({ getSettings: async () => ({ ...settings, remember_password: true }) });
  await controller.start();
  assert.deepEqual(calls, []);
  assert.equal(await controller.hasSavedPassword(' ALICE '), true);
  assert.equal(await controller.hasSavedPassword('bob'), false);
  assert.deepEqual(calls, [['saved', 'alice']]);
  await controller.login('alice', '', false, true);
  assert.deepEqual(calls.find(call => call[0] === 'login'), ['login', 'alice', '', false, true]);
  assert.equal(controller.getSnapshot().settings.remember_password, true);
  assert.equal(controller.getSnapshot().settings.auto_login, false);
  assert.equal(controller.getSnapshot().phase, 'authenticated');
  assert.ok(!JSON.stringify(controller.getSnapshot()).includes('secret'));
});

// 自动登录必须同时记住密码，兼容旧版设置并规范化新登录请求。
test('automatic login always implies remembering the password', async () => {
  const { controller } = fixture({ getSettings: async () => ({ ...settings, auto_login: true }) });
  await controller.start();
  assert.equal(controller.getSnapshot().settings.remember_password, true);
  const manual = fixture();
  await manual.controller.start();
  await manual.controller.login('alice', 'secret', true, false);
  assert.deepEqual(manual.calls.find(call => call[0] === 'login'), ['login', 'alice', 'secret', true, true]);
  assert.equal(manual.controller.getSnapshot().settings.remember_password, true);
});

// 撤销后不主动重用保存密码，用户点击后仍可恢复同账号草稿。
test('remembered password never automatically unlocks revoked drafts', async () => {
  const { controller, calls } = fixture({ getSettings: async () => ({ ...settings, remember_password: true }) });
  await controller.start();
  await controller.login('alice', '', false, true);
  await controller.poll();
  assert.equal(controller.getSnapshot().phase, 'locked');
  assert.equal(calls.filter(call => call[0] === 'login').length, 1);
  assert.equal(calls.filter(call => call[0] === 'auto').length, 0);
  await controller.login('alice', '', false, true);
  assert.equal(controller.getSnapshot().phase, 'authenticated');
  assert.equal(calls.filter(call => call[0] === 'initialize').length, 1);
  await controller.poll();
  assert.equal(controller.getSnapshot().phase, 'locked');
  assert.equal(await controller.hasSavedPassword('alice'), true);
  assert.equal(calls.filter(call => call[0] === 'login').length, 2);
});

// 清理保存密码时保持锁定草稿，失败时不得把界面偏好误报成已清除。
test('forgetting password persists both flags and keeps settings on failure', async () => {
  const remembered = { ...settings, remember_password: true };
  const { controller, calls } = fixture({ getSettings: async () => remembered });
  await controller.start();
  await controller.login('alice', '', false, true);
  await controller.poll();
  assert.equal(await controller.saveSettings({ ...remembered, remember_password: false, auto_login: false }), true);
  assert.equal(controller.getSnapshot().phase, 'locked');
  assert.equal(await controller.hasSavedPassword('alice'), false);
  assert.deepEqual(calls.find(call => call[0] === 'settings')[1], settings);
  const failing = fixture({ getSettings: async () => remembered, saveSettings: async () => { throw Error('store'); } });
  await failing.controller.start();
  assert.equal(await failing.controller.saveSettings(settings), false);
  assert.equal(failing.controller.getSnapshot().settings.remember_password, true);
  assert.ok(failing.controller.getSnapshot().error);
});

// 凭据查询和登录失败都不能使配置工作台获得资格。
test('unavailable or rejected remembered credentials leave manual password entry possible', async () => {
  const { controller } = fixture({
    getSettings: async () => ({ ...settings, remember_password: true }),
    hasSavedPassword: async () => { throw Error('credential store'); },
    login: async () => { throw Error('credentials rejected'); },
  });
  await controller.start();
  assert.equal(await controller.hasSavedPassword('alice'), false);
  await controller.login('alice', '', false, true);
  assert.equal(controller.getSnapshot().phase, 'signed_out');
  assert.equal(controller.getSnapshot().workspaceReady, false);
  assert.match(controller.getSnapshot().error, /重新输入密码/);
});

// 删除保存密码或更换平台后，较晚返回的旧凭据查询不能再次启用留空登录。
test('stale saved credential query cannot survive changed settings', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { controller } = fixture({
    getSettings: async () => ({ ...settings, remember_password: true }),
    hasSavedPassword: async () => pending,
  });
  await controller.start();
  const queried = controller.hasSavedPassword('alice');
  await controller.saveSettings(settings);
  resolve(true);
  assert.equal(await queried, false);
  assert.equal(controller.getSnapshot().settings.remember_password, false);
});

// 回填只读取当前平台的已记住账号，秘密不进入认证快照，也不触发登录。
test('password autofill reads only remembered matching account without authenticating', async () => {
  const { controller, calls } = fixture({ getSettings: async () => ({ ...settings, remember_password: true }) });
  await controller.start();
  assert.equal(await controller.getSavedPassword(' ALICE '), 'saved-secret');
  assert.equal(await controller.getSavedPassword('bob'), null);
  assert.equal(await controller.getSavedPassword(''), null);
  assert.deepEqual(calls, [['password', 'alice']]);
  assert.equal(controller.getSnapshot().phase, 'signed_out');
  assert.ok(!JSON.stringify(controller.getSnapshot()).includes('saved-secret'));
  await controller.saveSettings(settings);
  assert.equal(await controller.getSavedPassword('alice'), null);
  assert.equal(calls.filter(call => call[0] === 'password').length, 1);
});

// 缺失、空凭据或系统读取失败时退回手动输入，不展示原始系统错误。
test('password autofill safely handles missing empty and unreadable credentials', async () => {
  for (const read of [async () => null, async () => '', async () => { throw Error('saved-secret'); }]) {
    const { controller } = fixture({ getSettings: async () => ({ ...settings, remember_password: true }), getSavedPassword: read });
    await controller.start();
    assert.equal(await controller.getSavedPassword('alice'), null);
    assert.equal(controller.getSnapshot().error, null);
    await controller.login('alice', 'manual-secret', false, true);
    assert.equal(controller.getSnapshot().phase, 'authenticated');
  }
});

// 选项、账号或平台变化使旧密码读取结果失效。
test('password autofill discards delayed results after identity or preference changes', async () => {
  for (const changed of [settings, { ...settings, username: 'bob', remember_password: true }, { ...settings, grpc_endpoint: 'https://other.example:50000', remember_password: true }]) {
    let resolve;
    const { controller } = fixture({
      getSettings: async () => ({ ...settings, remember_password: true }),
      getSavedPassword: () => new Promise(done => { resolve = done; }),
    });
    await controller.start();
    const queried = controller.getSavedPassword('alice');
    await controller.saveSettings(changed);
    resolve('saved-secret');
    assert.equal(await queried, null);
  }
});

// 登录或退出已推进会话代次时，晚到的密码不得回填；稳定锁定后仍可主动读取。
test('password autofill rejects reads during login and delayed results across logout', async () => {
  let resolve;
  const { controller, calls } = fixture({
    getSettings: async () => ({ ...settings, remember_password: true }),
    getSavedPassword: () => new Promise(done => { resolve = done; }),
  });
  await controller.start();
  const queried = controller.getSavedPassword('alice');
  await controller.logout();
  resolve('saved-secret');
  assert.equal(await queried, null);

  let finishLogin;
  const pending = fixture({
    getSettings: async () => ({ ...settings, remember_password: true }),
    login: () => new Promise(done => { finishLogin = done; }),
  });
  await pending.controller.start();
  const login = pending.controller.login('alice', 'secret', false, true);
  assert.equal(await pending.controller.getSavedPassword('alice'), null);
  assert.equal(pending.calls.filter(call => call[0] === 'password').length, 0);
  finishLogin(loggedIn());
  await login;
  assert.equal(await pending.controller.getSavedPassword('alice'), null);
  await pending.controller.logout();
  assert.equal(await pending.controller.getSavedPassword('alice'), 'saved-secret');
  assert.equal(calls.filter(call => call[0] === 'login').length, 0);
});

// 主动退出直接清理工作台，不需要额外的切换或进程重启步骤。
test('explicit logout resets workspace and allows another account with fresh initialization', async () => {
  const { controller, calls } = fixture({ login: async username => { calls.push(['login', username]); return { ...loggedIn(), username }; } });
  await controller.start();
  await controller.login('alice', 'secret', true, true);
  calls.length = 0;
  assert.equal(await controller.logout(), true);
  assert.deepEqual(calls.map(call => call[0]), ['settings', 'logout', 'reset']);
  assert.equal(controller.getSnapshot().settings.auto_login, false);
  assert.equal(controller.getSnapshot().settings.remember_password, true);
  assert.equal(controller.getSnapshot().owner, null);
  assert.equal(controller.getSnapshot().workspaceReady, false);
  assert.equal(controller.getSnapshot().phase, 'signed_out');
  await controller.login('bob', 'secret', false);
  assert.equal(controller.getSnapshot().owner, 'bob');
  assert.equal(calls.filter(call => call[0] === 'initialize').length, 1);
});

// 各阶段失败均保留原账号草稿，禁止新账号，允许重试且不泄露系统错误。
test('failed explicit logout retains locked drafts and permits retry at every stage', async () => {
  for (const stage of ['settings', 'logout', 'reset']) {
    let fail = true;
    const { controller, calls } = fixture({
      saveSettings: async value => { calls.push(['settings', value]); if (fail && stage === 'settings') throw Error('private'); return value; },
      logout: async () => { calls.push(['logout']); if (fail && stage === 'logout') throw Error('private'); return signedOut; },
    }, { resetWorkspace: async () => { calls.push(['reset']); if (fail && stage === 'reset') throw Error('private'); } });
    await controller.start();
    await controller.login('alice', 'secret', true, true);
    calls.length = 0;
    assert.equal(await controller.logout(), false);
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.phase, 'locked');
    assert.equal(snapshot.owner, 'alice');
    assert.equal(snapshot.workspaceReady, true);
    assert.equal(snapshot.endingSession, false);
    assert.ok(snapshot.error && !snapshot.error.includes('private'));
    assert.deepEqual(calls.map(call => call[0]), stage === 'settings' ? ['settings'] : stage === 'logout' ? ['settings', 'logout'] : ['settings', 'logout', 'reset']);
    await controller.login('bob', 'secret', false);
    assert.equal(calls.filter(call => call[0] === 'login').length, 0);
    fail = false;
    assert.equal(await controller.logout(), true);
    assert.equal(controller.getSnapshot().owner, null);
  }
});

// 前端重建完成前持续锁定，不能重复退出、读取凭据或登录。
test('logout stays locked until reset finishes and suppresses concurrent operations', async () => {
  let finish;
  const { controller, calls } = fixture({}, { resetWorkspace: () => new Promise(resolve => { finish = resolve; }) });
  await controller.start();
  await controller.login('alice', 'secret', false);
  const logout = controller.logout();
  await Promise.resolve();
  assert.equal(controller.getSnapshot().phase, 'locked');
  assert.equal(controller.getSnapshot().endingSession, true);
  assert.equal(await controller.logout(), false);
  await controller.login('bob', 'secret', false);
  assert.equal(await controller.saveSettings(settings), false);
  assert.equal(await controller.getSavedPassword('alice'), null);
  assert.equal(calls.filter(call => call[0] === 'login').length, 1);
  finish();
  assert.equal(await logout, true);
  assert.equal(calls.filter(call => call[0] === 'logout').length, 1);
  assert.equal(calls.filter(call => call[0] === 'settings').length, 0);
});

// 正在保存偏好时不允许退出，避免较晚的保存结果恢复旧身份偏好。
test('logout waits for a settings save to finish', async () => {
  let finish;
  const { controller, calls } = fixture({ saveSettings: value => new Promise(resolve => { finish = () => resolve(value); }) });
  await controller.start();
  const saving = controller.saveSettings(settings);
  assert.equal(await controller.logout(), false);
  assert.equal(calls.filter(call => call[0] === 'logout').length, 0);
  finish();
  await saving;
  assert.equal(await controller.logout(), true);
});

// 升级任务拦截发生在锁定前，保持认证资格及原有草稿。
test('logout preparation guard preserves original authenticated snapshot', async () => {
  const { controller, calls } = fixture({}, { prepareLogout: () => { throw Error('设备正在升级，请等待升级完成后退出。'); } });
  await controller.start();
  await controller.login('alice', 'secret', false);
  const before = controller.getSnapshot();
  assert.equal(await controller.logout(), false);
  const after = controller.getSnapshot();
  assert.equal(after.phase, before.phase);
  assert.equal(after.status, before.status);
  assert.equal(after.workspaceReady, before.workspaceReady);
  assert.equal(after.owner, before.owner);
  assert.equal(after.endingSession, false);
  assert.match(after.error, /设备正在升级/);
  assert.equal(calls.filter(call => call[0] === 'logout').length, 0);
});

// 退出代次使晚到凭据失效，即使页面重建失败也不能回填旧密码。
test('logout invalidates delayed saved credentials even when reset fails', async () => {
  let finishPassword;
  let finishExists;
  const { controller } = fixture({
    getSettings: async () => ({ ...settings, remember_password: true }),
    getSavedPassword: () => new Promise(resolve => { finishPassword = resolve; }),
    hasSavedPassword: () => new Promise(resolve => { finishExists = resolve; }),
  }, { resetWorkspace: async () => { throw Error('reset'); } });
  await controller.start();
  const password = controller.getSavedPassword('alice');
  const exists = controller.hasSavedPassword('alice');
  assert.equal(await controller.logout(), false);
  finishPassword('saved-secret');
  finishExists(true);
  assert.equal(await password, null);
  assert.equal(await exists, false);
});
