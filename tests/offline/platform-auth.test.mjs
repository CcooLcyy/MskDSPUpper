import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformAuthController } from '../../src/auth/platform-auth-controller.ts';

const settings = { grpc_endpoint: 'http://localhost:50000', username: 'alice', auto_login: false };
const signedOut = { authenticated: false, username: null, display_name: null, connection_state: 'signed_out', expires_at: null, message: null };
const loggedIn = (expires = 10000) => ({ authenticated: true, username: 'alice', display_name: 'Alice', connection_state: 'online', expires_at: expires, message: null });
function fixture(overrides = {}) {
  let now = 1000;
  const calls = [];
  const api = {
    getSettings: async () => settings,
    saveSettings: async value => { calls.push(['settings', value]); return value; },
    login: async (...args) => { calls.push(['login', ...args]); return loggedIn(); },
    autoLogin: async () => { calls.push(['auto']); return loggedIn(); },
    getStatus: async () => signedOut,
    logout: async () => { calls.push(['logout']); return signedOut; },
    ...overrides,
  };
  const controller = createPlatformAuthController(api, async () => calls.push(['initialize']), () => now);
  return { controller, calls, setNow: value => { now = value; } };
}
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
  await controller.logout();
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
  assert.equal(controller.getSnapshot().phase, 'locked');
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
  await controller.logout();
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
  await controller.logout();
  await controller.login(' Alice ', 'secret', false);
  assert.equal(controller.getSnapshot().phase, 'authenticated');
});
