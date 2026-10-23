import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthenticatedLogin, loginContextMatches, canAttemptLogin, getCertificateMatchPresentation, getBuiltinCertificateMode } from '../../src/pages/SecurityAccess/login-state.ts';
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


test('内置证书配置无需外部路径，自定义配置仍必须提供两个路径', () => {
  const builtin = { configured: true, source: 'builtin', label: '内置配套证书', client_certificate_path: null, trust_certificate_path: null, server_name: '11.22.33.44' };
  assert.equal(canAttemptLogin('direct', undefined, capabilities, builtin), true);
  assert.equal(canAttemptLogin('direct', undefined, capabilities, { ...builtin, configured: false }), false);
  assert.equal(canAttemptLogin('direct', undefined, capabilities, { ...builtin, source: 'custom' }), false);
  assert.equal(canAttemptLogin('direct', undefined, capabilities, { ...profile, source: 'custom', trust_certificate_path: null }), false);
  assert.equal(canAttemptLogin('direct', undefined, capabilities, { ...profile, source: 'custom' }), true);
  assert.equal(canAttemptLogin('direct', undefined, capabilities, { ...profile, trust_certificate_path: null }), false);
});


test('默认自动匹配，只有真实TLS成功才展示实际证书组别和兼容状态', () => {
  assert.equal(getBuiltinCertificateMode({ ...profile, source: 'builtin' }), 'auto');
  assert.equal(getBuiltinCertificateMode({ ...profile, source: 'builtin', builtin_mode: 'old' }), 'old');
  assert.equal(getBuiltinCertificateMode({ ...profile, source: 'builtin', builtin_mode: 'new' }), 'new');
  assert.equal(getCertificateMatchPresentation(null), null);
  assert.equal(getCertificateMatchPresentation({ ...result(), certificate_group: 'old', legacy_compatibility: true, steps: [] }), null);
  assert.equal(getCertificateMatchPresentation({ ...result(), certificate_group: 'old', legacy_compatibility: true, steps: [{ id: 'tls', state: 'failed' }] }), null);
  assert.equal(getCertificateMatchPresentation({ ...result(), certificate_group: 'old', legacy_compatibility: true }).label, '已匹配旧版证书');
  assert.equal(getCertificateMatchPresentation({ ...result(), certificate_group: 'old', legacy_compatibility: true }).compatibility, '受限旧版兼容已启用');
  assert.equal(getCertificateMatchPresentation({ ...result(), certificate_group: 'old', legacy_compatibility: false }), null);
  assert.equal(getCertificateMatchPresentation({ ...result(), certificate_group: 'old' }), null);
  assert.equal(getCertificateMatchPresentation({ ...result(), certificate_group: 'new', legacy_compatibility: false }).label, '已匹配新版证书');
  assert.equal(getCertificateMatchPresentation({ ...result(), certificate_group: 'new', legacy_compatibility: false }).compatibility, '严格证书校验');
  assert.equal(getCertificateMatchPresentation({ ...result(), certificate_group: 'new', legacy_compatibility: true }), null);
  assert.equal(getCertificateMatchPresentation(result()), null);
});


test('带有证书元数据的认证结果必须满足旧版兼容与新版严格校验边界', () => {
  assert.equal(isAuthenticatedLogin(request, { ...result(), certificate_group: 'old', legacy_compatibility: false }), false);
  assert.equal(isAuthenticatedLogin(request, { ...result(), certificate_group: 'old' }), false);
  assert.equal(isAuthenticatedLogin(request, { ...result(), certificate_group: 'new', legacy_compatibility: true }), false);
  assert.equal(isAuthenticatedLogin(request, { ...result(), certificate_group: 'old', legacy_compatibility: true }), true);
  assert.equal(isAuthenticatedLogin(request, { ...result(), certificate_group: 'new', legacy_compatibility: false }), true);
  assert.equal(isAuthenticatedLogin(request, result()), true);
});
