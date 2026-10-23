import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthenticatedLogin, loginContextMatches, canAttemptLogin } from '../../src/pages/SecurityAccess/login-state.ts';
const request = { request_id: 'fixture-request', mode: 'direct', role: 2, username: ' fixture-user ' };
const capabilities = { direct_available: true, remote_available: false, password_change_available: false, reason: null };
const profile = { configured: true, client_certificate_path: 'fixture.p12', trust_certificate_path: 'fixture.pem', server_name: '11.22.33.44' };
const result = () => ({ ...request, state: 'authenticated', code: 'fixture', message: '', target_ip: '11.22.33.44', device_id: null, session_id: 'fixture-session', challenge_id: null, lock_seconds: null, last_login_at: null, device_version: null, steps: ['connect', 'tls', 'authenticate', 'initialize'].map(id => ({ id, name: id, state: 'success', message: '' })) });

test('仅接受匹配请求与身份且四阶段成功的认证会话', () => {
  assert.equal(isAuthenticatedLogin(request, result()), true);
  for (const [key, value] of Object.entries({ request_id: 'other', target_ip: '127.0.0.1', mode: 'remote', device_id: 'other', username: 'fixture-user', role: 1, session_id: null, state: 'unverified_response' })) {
    assert.equal(isAuthenticatedLogin(request, { ...result(), [key]: value }), false, key);
  }
  assert.equal(isAuthenticatedLogin(request, { ...result(), steps: result().steps.slice(0, 3) }), false);
  assert.equal(isAuthenticatedLogin(request, { ...result(), steps: result().steps.map(step => step.id === 'initialize' ? { ...step, state: 'failed' } : step) }), false);
  assert.equal(isAuthenticatedLogin(request, { ...result(), session_id: ' ' }), false);
});

test('远程会话必须精确匹配当前DSP，不重写原始用户名', () => {
  const remote = { ...request, mode: 'remote', device_id: 'fixture-dsp' };
  assert.equal(loginContextMatches(remote, { ...result(), mode: 'remote', device_id: 'fixture-dsp' }), true);
  assert.equal(loginContextMatches(remote, { ...result(), mode: 'remote', device_id: 'other' }), false);
});

test('能力和证书加载完成前不发登录，ICMP不作为登录条件', () => {
  assert.equal(canAttemptLogin('direct', undefined, null, profile), false);
  assert.equal(canAttemptLogin('direct', undefined, capabilities, null), false);
  assert.equal(canAttemptLogin('direct', undefined, capabilities, { ...profile, configured: false }), false);
  assert.equal(canAttemptLogin('direct', undefined, capabilities, profile), true);
  assert.equal(canAttemptLogin('remote', 'fixture-dsp', capabilities, profile), false);
  assert.equal(canAttemptLogin('remote', undefined, { ...capabilities, remote_available: true }, profile), false);
  assert.equal(canAttemptLogin('remote', 'fixture-dsp', { ...capabilities, remote_available: true }, profile), true);
});
