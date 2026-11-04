import type {
  VerticalSecurityAccessMode,
  VerticalSecurityBuiltinCertificateMode,
  VerticalSecurityCertificateProfile,
  VerticalSecurityLoginCapabilities,
  VerticalSecurityLoginRequest,
  VerticalSecurityLoginResult,
  VerticalSecurityOneClickLoginRequest,
} from '../../adapters/types.ts';

export type LoginIdentity = Omit<VerticalSecurityLoginRequest, 'password'>;

export function getOneClickLoginUsername(role: VerticalSecurityOneClickLoginRequest['role']): string {
  return role === 1 ? 'admin' : 'secure';
}
export const LOGIN_STAGES = [
  { id: 'connect', name: '连接装置' },
  { id: 'tls', name: 'TLS 安全连接' },
  { id: 'authenticate', name: '身份认证' },
  { id: 'initialize', name: '读取装置信息' },
] as const;

export function loginContextMatches(request: LoginIdentity, result: VerticalSecurityLoginResult): boolean {
  return result.request_id === request.request_id
    && result.target_ip === '11.22.33.44'
    && result.mode === request.mode
    && result.device_id === (request.mode === 'remote' ? request.device_id : null);
}

export function isAuthenticatedLogin(request: LoginIdentity, result: VerticalSecurityLoginResult): boolean {
  return loginContextMatches(request, result)
    && result.state === 'authenticated'
    && Boolean(result.session_id?.trim())
    && result.username === request.username
    && result.role === request.role
    && (result.certificate_group !== 'old' || result.legacy_compatibility === true)
    && (result.legacy_compatibility !== true || result.certificate_group === 'old')
    && result.steps.length === LOGIN_STAGES.length
    && LOGIN_STAGES.every(stage => result.steps.some(step => step.id === stage.id && step.state === 'success'))
    && result.steps.every(step => step.state === 'success');
}

export function isPasswordChangeRequired(request: LoginIdentity, result: VerticalSecurityLoginResult): boolean {
  return loginContextMatches(request, result)
    && result.state === 'password_change_required'
    && (result.code === 'default_password' || result.code === 'password_expired')
    && result.username === request.username
    && result.role === request.role
    && typeof result.challenge_id === 'string'
    && Boolean(result.challenge_id.trim())
    && result.session_id === null
    && (result.certificate_group !== 'old' || result.legacy_compatibility === true)
    && (result.legacy_compatibility !== true || result.certificate_group === 'old')
    && result.steps.length === LOGIN_STAGES.length
    && LOGIN_STAGES.every(stage => result.steps.some(step => step.id === stage.id
      && step.state === (stage.id === 'initialize' ? 'pending' : 'success')));
}

export function validateNewPassword(username: string, password: string, confirmation: string): string | null {
  if (password !== confirmation) return '两次新密码输入不一致，请重新输入。';
  if (password.length < 8 || password.length > 16) return '新密码长度须为 8 至 16 个 ASCII 字符。';
  // 与原程序 XOPUtil.checkPassword 的实际字符集合一致。
  if (!/^[A-Za-z0-9!@#$_.+=*?-]+$/.test(password)) return '新密码仅允许英文字母、数字及 !@#$_.-+=*? 中的特殊字符，不能包含空格。';
  if (username && password.includes(username)) return '新密码不能包含用户名。';
  const categories = [/[A-Z]/, /[a-z]/, /[0-9]/, /[!@#$_.+=*?-]/];
  if (categories.filter(pattern => pattern.test(password)).length < 3) return '新密码至少包含大写字母、小写字母、数字和特殊字符中的三类。';
  return null;
}

export function canAttemptLogin(
  mode: VerticalSecurityAccessMode,
  deviceId: string | undefined,
  capabilities: VerticalSecurityLoginCapabilities | null,
  profile: VerticalSecurityCertificateProfile | null,
): boolean {
  return Boolean(capabilities && profile?.configured
    && (profile.source === 'builtin' || (profile.client_certificate_path && profile.trust_certificate_path))
    && (mode === 'direct' ? capabilities.direct_available : capabilities.remote_available && deviceId));
}

export function getBuiltinCertificateMode(profile: VerticalSecurityCertificateProfile | null): VerticalSecurityBuiltinCertificateMode {
  return profile?.builtin_mode === 'old' || profile?.builtin_mode === 'new' ? profile.builtin_mode : 'auto';
}

export function getCertificateMatchPresentation(result: VerticalSecurityLoginResult | null): {
  label: string;
  compatibility: string;
  legacy: boolean;
} | null {
  if (!result?.steps.some(step => step.id === 'tls' && step.state === 'success')) return null;
  if (result.certificate_group === 'old' && result.legacy_compatibility === true) {
    return { label: '已匹配旧版证书', compatibility: '受限旧版兼容已启用', legacy: true };
  }
  if (result.certificate_group === 'new' && result.legacy_compatibility !== true) {
    return { label: '已匹配新版证书', compatibility: '严格证书校验', legacy: false };
  }
  return null;
}
