import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthenticatedLogin, loginContextMatches, canAttemptLogin, getCertificateMatchPresentation, getBuiltinCertificateMode } from '../../src/pages/SecurityAccess/login-state.ts';
import * as loginState from '../../src/pages/SecurityAccess/login-state.ts';
const request = { request_id: 'fixture-request', mode: 'direct', role: 2, username: ' fixture-user ' };
const capabilities = { direct_available: true, remote_available: false, password_change_available: false, reason: null };
const profile = { configured: true, client_certificate_path: 'fixture.p12', trust_certificate_path: 'fixture.pem', server_name: '11.22.33.44' };
const result = () => ({ ...request, state: 'authenticated', code: 'fixture', message: '', target_ip: '11.22.33.44', device_id: null, session_id: 'fixture-session', challenge_id: null, lock_seconds: null, last_login_at: null, device_version: null, steps: ['connect', 'tls', 'authenticate', 'initialize'].map(id => ({ id, name: id, state: 'success', message: '' })) });
const challengeResult = () => ({ ...result(), state: 'password_change_required', code: 'default_password', session_id: null, challenge_id: 'fixture-challenge', steps: result().steps.map(step => step.id === 'initialize' ? { ...step, state: 'pending' } : step) });

test('一键登录角色绑定固定账号，仍严格核对最终会话身份', () => {
  for (const [role, username] of [[1, 'admin'], [2, 'secure']]) {
    assert.equal(loginState.getOneClickLoginUsername(role), username);
    const identity = { ...request, role, username };
    const response = { ...result(), role, username };
    assert.equal(isAuthenticatedLogin(identity, response), true);
    assert.equal(isAuthenticatedLogin(identity, { ...response, username: role === 1 ? 'secure' : 'admin' }), false);
    assert.equal(isAuthenticatedLogin(identity, { ...response, role: 3 }), false);
    assert.equal(isAuthenticatedLogin(identity, { ...response, state: 'password_change_required', session_id: null }), false);
  }
});

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

test('改密挑战必须有匹配的完整身份、目标和一次性标识，不能携带会话', () => {
  const challenge = challengeResult();
  assert.equal(typeof loginState.isPasswordChangeRequired, 'function');
  assert.equal(loginState.isPasswordChangeRequired(request, challenge), true);
  assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, code: 'password_expired' }), true);
  for (const [key, value] of Object.entries({ request_id: 'other', mode: 'remote', target_ip: '192.0.2.1', device_id: 'other', username: null, role: null, challenge_id: null, session_id: 'unexpected', code: 'unknown' })) {
    assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, [key]: value }), false, key);
  }
  assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, challenge_id: ' ' }), false);
  assert.equal(isAuthenticatedLogin(request, challenge), false);
});

test('改密挑战必须完成连接、TLS和认证且尚未读取装置信息，拒绝缺失或重复阶段', () => {
  const challenge = challengeResult();
  assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, steps: result().steps }), false, '已经初始化不属于待改密挑战');
  assert.equal(loginState.isPasswordChangeRequired(request, challenge), true);
  assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, steps: [] }), false);
  assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, steps: challenge.steps.slice(0, 3) }), false);
  assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, steps: [...challenge.steps, challenge.steps[0]] }), false);
  assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, steps: challenge.steps.map(step => step.id === 'authenticate' ? { ...step, id: 'connect' } : step) }), false);
  for (const stage of ['connect', 'tls', 'authenticate']) {
    for (const state of ['pending', 'failed', 'unsupported']) {
      assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, steps: challenge.steps.map(step => step.id === stage ? { ...step, state } : step) }), false, `${stage}:${state}`);
    }
  }
  for (const state of ['success', 'failed', 'unsupported']) {
    assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, steps: challenge.steps.map(step => step.id === 'initialize' ? { ...step, state } : step) }), false, `initialize:${state}`);
  }
});

test('改密挑战的证书组别与兼容模式遵循已认证会话的同一边界', () => {
  const challenge = challengeResult();
  for (const metadata of [{ certificate_group: 'old', legacy_compatibility: false }, { certificate_group: 'old' }, { certificate_group: 'new', legacy_compatibility: true }, { legacy_compatibility: true }]) {
    assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, ...metadata }), false, JSON.stringify(metadata));
  }
  assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, certificate_group: 'old', legacy_compatibility: true }), true);
  assert.equal(loginState.isPasswordChangeRequired(request, { ...challenge, certificate_group: 'new', legacy_compatibility: false }), true);
  assert.equal(loginState.isPasswordChangeRequired(request, challenge), true);
});

test('新密码遵循原程序字符集合、8至16位及至少三类复杂度，并禁止包含账号', () => {
  assert.equal(typeof loginState.validateNewPassword, 'function');
  for (const value of ['Abcdef12', 'abcdefgh1!', 'ABCDEFG1=', 'Abcdef12!@#_+=.?']) {
    assert.equal(loginState.validateNewPassword('fixture-user', value, value), null, value);
  }
  for (const value of ['', 'Abc123!', 'Abcdef1234567890!x', 'Abcdefgh', 'abcdefgh12', 'ABCDEFGH12', 'Abcdef12%', 'Abcdef12 ', 'Abcdef12\t', 'Abcdef12中', 'Abcdef12\u007f', 'fixture-userA1!']) {
    assert.equal(typeof loginState.validateNewPassword('fixture-user', value, value), 'string', value);
  }
  assert.equal(typeof loginState.validateNewPassword('fixture-user', 'Abcdef12', 'abcdef12'), 'string', '确认密码必须区分大小写');
});
