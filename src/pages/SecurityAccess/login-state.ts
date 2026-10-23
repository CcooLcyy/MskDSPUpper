import type {
  VerticalSecurityAccessMode,
  VerticalSecurityCertificateProfile,
  VerticalSecurityLoginCapabilities,
  VerticalSecurityLoginRequest,
  VerticalSecurityLoginResult,
} from '../../adapters/types.ts';

export type LoginIdentity = Omit<VerticalSecurityLoginRequest, 'password'>;
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
    && result.steps.length === LOGIN_STAGES.length
    && LOGIN_STAGES.every(stage => result.steps.some(step => step.id === stage.id && step.state === 'success'))
    && result.steps.every(step => step.state === 'success');
}

export function canAttemptLogin(
  mode: VerticalSecurityAccessMode,
  deviceId: string | undefined,
  capabilities: VerticalSecurityLoginCapabilities | null,
  profile: VerticalSecurityCertificateProfile | null,
): boolean {
  return Boolean(capabilities && profile?.configured && profile.client_certificate_path && profile.trust_certificate_path
    && (mode === 'direct' ? capabilities.direct_available : capabilities.remote_available && deviceId));
}
