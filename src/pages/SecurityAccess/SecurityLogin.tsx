import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, Form, Input, Select, Space, Tag, Typography } from 'antd';
import { FileOutlined, LoginOutlined, LogoutOutlined } from '@ant-design/icons';
import { api } from '../../adapters';
import type {
  VerticalSecurityAccessMode,
  VerticalSecurityBuiltinCertificateMode,
  VerticalSecurityCertificateProfile,
  VerticalSecurityLoginCapabilities,
  VerticalSecurityLoginResult,
  VerticalSecurityRole,
} from '../../adapters';
import { canAttemptLogin, getBuiltinCertificateMode, getCertificateMatchPresentation, isAuthenticatedLogin, isPasswordChangeRequired, LOGIN_STAGES, loginContextMatches, validateNewPassword, type LoginIdentity } from './login-state';

const ROLE_OPTIONS = [{ value: 1, label: '系统管理员' }, { value: 2, label: '安全操作员' }, { value: 3, label: '日志审计员' }];
const ROLE_HINTS = { 1: '管理装置账号与系统设置。', 2: '配置网络、隧道与策略。', 3: '查看运行日志与审计信息。' };
const BUILTIN_MODE_OPTIONS = [{ value: 'auto', label: '自动匹配旧版／新版' }, { value: 'old', label: '仅旧版配套证书' }, { value: 'new', label: '仅新版配套证书' }];
type ActiveRequest = { identity: LoginIdentity; generation: number; cancelled: boolean };
type PasswordChallenge = { id: string; identity: LoginIdentity };
type ActivePasswordChange = { challenge: PasswordChallenge; generation: number };

export default function SecurityLogin({ mode, deviceId, deviceLabel, accessBusy, onLockChange, modeControls }: {
  mode: VerticalSecurityAccessMode;
  deviceId?: string;
  deviceLabel?: string;
  accessBusy: boolean;
  onLockChange: (locked: boolean) => void;
  modeControls?: ReactNode;
}) {
  const [capabilities, setCapabilities] = useState<VerticalSecurityLoginCapabilities | null>(null);
  const [profile, setProfile] = useState<VerticalSecurityCertificateProfile | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [role, setRole] = useState<VerticalSecurityRole>(2);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clientPath, setClientPath] = useState('');
  const [trustPath, setTrustPath] = useState('');
  const [certificatePassword, setCertificatePassword] = useState('');
  const [serverName, setServerName] = useState('11.22.33.44');
  const [builtinMode, setBuiltinMode] = useState<VerticalSecurityBuiltinCertificateMode>('auto');
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [certificateBusy, setCertificateBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [changeBusy, setChangeBusy] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [challenge, setChallenge] = useState<PasswordChallenge | null>(null);
  const [result, setResult] = useState<VerticalSecurityLoginResult | null>(null);
  const [session, setSession] = useState<VerticalSecurityLoginResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const activeRef = useRef<ActiveRequest | null>(null);
  const sessionRef = useRef<string | null>(null);
  const challengeRef = useRef<PasswordChallenge | null>(null);
  const passwordChangeRef = useRef<ActivePasswordChange | null>(null);
  const secretInputs = useRef<Array<HTMLInputElement | null>>([]);
  const mustChangePassword = Boolean(challenge);
  const locked = busy || certificateBusy || logoutBusy || changeBusy || Boolean(session) || mustChangePassword;
  const allowed = !initializing && canAttemptLogin(mode, deviceId, capabilities, profile);
  const certificateMatch = getCertificateMatchPresentation(result);
  const appliedBuiltinMode = getBuiltinCertificateMode(profile);
  const builtinSummary = appliedBuiltinMode === 'auto' ? '内置配套证书 · 自动匹配' : appliedBuiltinMode === 'old' ? '内置配套证书 · 仅旧版' : '内置配套证书 · 仅新版';

  useEffect(() => { onLockChange(locked); }, [locked, onLockChange]);

  useEffect(() => {
    mountedRef.current = true;
    const inputs = secretInputs.current;
    let current = true;
    void Promise.all([api.getVerticalSecurityLoginCapabilities(), api.getVerticalSecurityCertificateProfile()]).then(([available, configured]) => {
      if (!current) return;
      setCapabilities(available); setProfile(configured);
      setClientPath(configured.client_certificate_path ?? '');
      setTrustPath(configured.trust_certificate_path ?? '');
      setServerName(configured.server_name || '11.22.33.44');
      setBuiltinMode(getBuiltinCertificateMode(configured));
    }).catch(() => { if (current) setError('读取纵密登录能力或证书配置失败，请离开此页后重试。'); })
      .finally(() => { if (current) setInitializing(false); });
    return () => {
      current = false;
      mountedRef.current = false;
      generationRef.current += 1;
      const active = activeRef.current;
      if (active) { active.cancelled = true; void api.cancelVerticalSecurityLogin(active.identity.request_id).catch(() => {}); }
      if (sessionRef.current) void api.logoutVerticalSecurity(sessionRef.current).catch(() => {});
      if (challengeRef.current) void api.cancelVerticalSecurityLogin(challengeRef.current.id).catch(() => {});
      for (const input of inputs) if (input) input.value = '';
      onLockChange(false);
    };
  }, [onLockChange]);

  useEffect(() => {
    const sessionId = session?.session_id;
    const pending = challenge;
    const connectionId = sessionId || pending?.id;
    if (!connectionId || changeBusy) return;
    const generation = generationRef.current;
    let current = true;
    let checking = false;
    const check = async () => {
      if (checking || passwordChangeRef.current) return;
      checking = true;
      let connected = false;
      try { connected = await api.isVerticalSecurityLoginActive(connectionId); } catch { /* 状态无法确认时退出当前身份。 */ }
      checking = false;
      if (!current || !mountedRef.current || generationRef.current !== generation || passwordChangeRef.current
        || (sessionId ? sessionRef.current !== sessionId : challengeRef.current !== pending) || connected) return;
      generationRef.current += 1;
      if (sessionId) {
        sessionRef.current = null;
        void api.logoutVerticalSecurity(sessionId).catch(() => {});
      } else if (pending) {
        challengeRef.current = null;
        void api.cancelVerticalSecurityLogin(pending.id).catch(() => {});
      }
      setSession(null); setChallenge(null); setResult(null);
      setPassword(''); setCertificatePassword(''); setNewPassword(''); setConfirmPassword('');
      setError('纵密连接已失效或状态无法确认，请重新登录。'); setNotice(null);
    };
    const timer = window.setInterval(() => { void check(); }, 3000);
    return () => { current = false; window.clearInterval(timer); };
  }, [session, challenge, changeBusy]);

  const clearSecrets = () => { setPassword(''); setCertificatePassword(''); setNewPassword(''); setConfirmPassword(''); };
  const cleanupReturnedSession = async (value: VerticalSecurityLoginResult) => {
    if (!value.session_id) return;
    try { await api.logoutVerticalSecurity(value.session_id); } catch { /* 清理结果不能覆盖新请求的界面状态。 */ }
  };
  const cleanupReturnedConnection = async (value: VerticalSecurityLoginResult, requestId: string) => {
    await cleanupReturnedSession(value);
    const id = value.challenge_id?.trim() ? value.challenge_id : value.state === 'password_change_required' ? requestId : null;
    if (id) { try { await api.cancelVerticalSecurityLogin(id); } catch { /* 后端到期清理仍会关闭该临时连接。 */ } }
  };

  const login = async () => {
    if (!allowed || locked || accessBusy || activeRef.current) return;
    if (!username.trim() || !password || username.length > 32 || password.length > 32) {
      setError('请输入纵密用户名和密码，长度均不能超过 32 个字符。'); return;
    }
    const identity: LoginIdentity = { request_id: `vertical-login-${crypto.randomUUID()}`, mode, ...(mode === 'remote' ? { device_id: deviceId } : {}), username, role };
    const active = { identity, generation: ++generationRef.current, cancelled: false };
    activeRef.current = active;
    setBusy(true); setResult(null); setError(null); setNotice(null);
    const secret = password;
    clearSecrets();
    try {
      const value = await api.loginVerticalSecurity({ ...identity, password: secret });
      if (!mountedRef.current || active.cancelled || generationRef.current !== active.generation) {
        await cleanupReturnedConnection(value, identity.request_id); return;
      }
      if (!loginContextMatches(identity, value)) {
        await cleanupReturnedConnection(value, identity.request_id);
        if (mountedRef.current && !active.cancelled && generationRef.current === active.generation) setError('登录结果与当前请求或目标设备不匹配，已拒绝建立纵密身份。');
        return;
      }
      if (value.state === 'authenticated') {
        if (!isAuthenticatedLogin(identity, value)) {
          await cleanupReturnedConnection(value, identity.request_id);
          if (mountedRef.current && !active.cancelled && generationRef.current === active.generation) setError('登录身份或初始化结果不完整，已拒绝建立纵密身份。');
          return;
        }
        sessionRef.current = value.session_id;
        setSession(value); setResult(value);
      } else {
        if (value.state === 'password_change_required') {
          if (!isPasswordChangeRequired(identity, value)) {
            await cleanupReturnedConnection(value, identity.request_id);
            if (mountedRef.current && !active.cancelled && generationRef.current === active.generation) setError('密码变更身份或挑战不完整，已拒绝使用此结果，请重新登录。');
            return;
          }
          const pending = { id: value.challenge_id!, identity };
          challengeRef.current = pending; setChallenge(pending);
        } else {
          await cleanupReturnedConnection(value, identity.request_id);
          if (!mountedRef.current || active.cancelled || generationRef.current !== active.generation) return;
        }
        setResult({ ...value, session_id: null });
      }
    } catch {
      if (mountedRef.current && !active.cancelled && generationRef.current === active.generation) setError('纵密登录失败，请检查连接与装置状态后手动重试。');
    } finally {
      if (activeRef.current === active && !active.cancelled) activeRef.current = null;
      if (mountedRef.current && generationRef.current === active.generation && !active.cancelled) setBusy(false);
    }
  };

  const cancelLogin = async () => {
    const active = activeRef.current;
    if (!active || cancelling) return;
    active.cancelled = true;
    clearSecrets(); setCancelling(true);
    try { await api.cancelVerticalSecurityLogin(active.identity.request_id); if (mountedRef.current) setNotice('已取消本次纵密登录。'); }
    catch { if (mountedRef.current) setError('取消请求未获确认；本页将拒绝迟到结果，并尝试清理返回的会话。'); }
    finally {
      if (activeRef.current === active) {
        generationRef.current += 1; activeRef.current = null;
        if (mountedRef.current) { setBusy(false); setCancelling(false); setResult(null); }
      }
    }
  };

  const selectCertificate = async (kind: 'client' | 'trust') => {
    if (locked || accessBusy) return;
    setCertificateBusy(true);
    try { const path = await api.selectVerticalSecurityCertificate(kind); if (mountedRef.current && path) (kind === 'client' ? setClientPath : setTrustPath)(path); }
    catch { if (mountedRef.current) setError('无法选择证书文件，请重试。'); }
    finally { if (mountedRef.current) setCertificateBusy(false); }
  };

  const saveCertificate = async () => {
    if (locked || accessBusy || !clientPath || !trustPath || !serverName.trim()) return;
    const request = { client_certificate_path: clientPath, trust_certificate_path: trustPath, certificate_password: certificatePassword, server_name: serverName };
    setCertificatePassword(''); setCertificateBusy(true); setError(null); setNotice(null);
    try {
      const value = await api.configureVerticalSecurityCertificateProfile(request);
      if (mountedRef.current) { setProfile(value); setResult(null); setNotice(value.configured ? '连接证书已配置，仅在当前上位机进程内有效。' : '连接证书尚未配置成功。'); }
    } catch { if (mountedRef.current) setError('证书配置失败，请检查格式、口令与装置信任证书。'); }
    finally { if (mountedRef.current) setCertificateBusy(false); }
  };

  const applyBuiltinCertificate = async (requestedMode: VerticalSecurityBuiltinCertificateMode) => {
    if (locked || accessBusy || initializing) return;
    clearSecrets(); setCertificateBusy(true); setError(null); setNotice(null);
    try {
      const value = await api.useBuiltinVerticalSecurityCertificates(requestedMode);
      if (!mountedRef.current) return;
      if (!value.configured || value.source !== 'builtin' || getBuiltinCertificateMode(value) !== requestedMode) {
        setProfile(null);
        setResult(null);
        setError('内置证书配置结果与请求不一致，无法确认当前模式，请重新应用证书配置。');
        return;
      }
      setProfile(value);
      setBuiltinMode(getBuiltinCertificateMode(value));
      setResult(null);
      setClientPath(value.client_certificate_path ?? '');
      setTrustPath(value.trust_certificate_path ?? '');
      setServerName(value.server_name || '11.22.33.44');
      setNotice(requestedMode === 'auto' ? '已启用内置证书自动匹配，等待下次 TLS 连接确认实际组别。' : `已应用${requestedMode === 'old' ? '旧版' : '新版'}内置证书模式，等待下次 TLS 连接确认。`);
    } catch { if (mountedRef.current) setError('加载内置配套证书失败，请检查应用资源与证书状态。'); }
    finally { if (mountedRef.current) setCertificateBusy(false); }
  };

  const logout = async () => {
    const id = sessionRef.current;
    if (!id || logoutBusy) return;
    const generation = generationRef.current;
    clearSecrets(); setLogoutBusy(true); setError(null);
    try {
      await api.logoutVerticalSecurity(id);
      if (!mountedRef.current || generationRef.current !== generation || sessionRef.current !== id) return;
      sessionRef.current = null;
      setSession(null); setResult(null); setNotice('已退出纵密登录。');
    } catch { if (mountedRef.current && generationRef.current === generation && sessionRef.current === id) setError('退出纵密登录失败，会话记录仍保留，请重试。'); }
    finally { if (mountedRef.current && (generationRef.current === generation || sessionRef.current === null)) setLogoutBusy(false); }
  };

  const dismissChallenge = async () => {
    const pending = challengeRef.current;
    if (!pending || passwordChangeRef.current || changeBusy) return;
    const active = { challenge: pending, generation: ++generationRef.current };
    passwordChangeRef.current = active;
    clearSecrets(); setChangeBusy(true); setError(null); setNotice(null);
    try {
      await api.cancelVerticalSecurityLogin(pending.id);
      if (mountedRef.current && generationRef.current === active.generation) setNotice('已结束密码变更流程，请重新登录。');
    } catch {
      if (mountedRef.current && generationRef.current === active.generation) setError('结束密码变更流程未获确认，请重新登录。');
    } finally {
      if (passwordChangeRef.current === active) passwordChangeRef.current = null;
      if (mountedRef.current && generationRef.current === active.generation && challengeRef.current === pending) {
        challengeRef.current = null; setChallenge(null); setResult(null); setChangeBusy(false);
      }
    }
  };

  const changePassword = async () => {
    const pending = challengeRef.current;
    if (!capabilities?.password_change_available || !pending || passwordChangeRef.current || changeBusy) return;
    const validation = validateNewPassword(pending.identity.username, newPassword, confirmPassword);
    if (validation) { setError(validation); return; }
    const secret = newPassword;
    const active = { challenge: pending, generation: ++generationRef.current };
    passwordChangeRef.current = active;
    clearSecrets(); setChangeBusy(true); setError(null); setNotice(null);
    try {
      const value = await api.changeVerticalSecurityPassword({ challenge_id: pending.id, new_password: secret });
      if (!mountedRef.current || generationRef.current !== active.generation || challengeRef.current !== pending) return;
      if (value.changed) setNotice('密码已修改，请使用新密码重新登录纵密装置。');
      else setError(value.message?.trim() || '密码修改未完成，当前账号仍未登录，请重新登录。');
    } catch {
      if (mountedRef.current && generationRef.current === active.generation && challengeRef.current === pending) setError('密码修改结果未确认，请先手动核实装置状态后重新登录。');
    } finally {
      if (passwordChangeRef.current === active) passwordChangeRef.current = null;
      if (mountedRef.current && generationRef.current === active.generation && challengeRef.current === pending) {
        challengeRef.current = null; setChallenge(null); setResult(null); setChangeBusy(false);
      }
    }
  };

  return <section className="security-login-workbench" aria-label="纵密登录工作台">
    <div className="security-login-context" aria-label={`当前连接：${mode === 'direct' ? '101 口直连' : `平台远程 · ${deviceLabel || deviceId || '尚未选择 DSP'}`}`}>
      {modeControls && <div className="security-login-mode-controls">{modeControls}</div>}
      <div className="security-login-target-summary"><span>纵密目标 <strong>11.22.33.44</strong></span><span>出口：DSP 108 口</span></div>
    </div>
    <div className="security-access-columns security-login-columns">
      <Card className="security-login-auth" title="装置身份认证" extra={<Tag color={session ? 'success' : busy ? 'processing' : 'default'}>{session ? '已登录' : busy ? '认证中' : '未登录'}</Tag>}>
        {session ? <>
          <Alert type="success" showIcon title="已登录纵密装置" description="已完成身份认证与账号、版本资料只读初始化；纵密业务入口尚未接入。" />
          <dl className="security-login-session"><dt>当前账号</dt><dd>{session.username}</dd><dt>当前角色</dt><dd>{ROLE_OPTIONS.find(item => item.value === session.role)?.label}</dd><dt>装置地址</dt><dd>{session.target_ip}</dd><dt>装置版本</dt><dd>{session.device_version || '未提供'}</dd><dt>上次登录</dt><dd>{session.last_login_at || '未提供'}</dd></dl>
          <Button icon={<LogoutOutlined />} loading={logoutBusy} onClick={() => void logout()}>退出纵密登录</Button>
        </> : mustChangePassword ? <>
          <Alert type="warning" showIcon title="设置新密码" description={<><p>{result?.code === 'default_password' ? '当前密码为默认密码，必须修改后重新登录。' : '密码已过期，必须修改后重新登录。'}</p><p>{result?.message}</p><p>当前账号尚未登录。新密码须为 8 至 16 位，至少包含大写字母、小写字母、数字、特殊字符中的三类，不能包含用户名或空格。允许的特殊字符：!@#$_.-+=*?。</p></>} />
          {!capabilities?.password_change_available ? <Alert className="security-access-notice" type="info" title="密码修改流程尚未验证，当前不可修改" description="此状态不代表已经登录纵密装置。" /> : <div className="security-login-fields"><label>新密码<Input.Password aria-label="纵密新密码" value={newPassword} maxLength={16} autoComplete="new-password" disabled={changeBusy} onChange={event => setNewPassword(event.target.value)} ref={node => { secretInputs.current[2] = node?.input ?? null; }} /></label><label>确认新密码<Input.Password aria-label="确认纵密新密码" value={confirmPassword} maxLength={16} autoComplete="new-password" disabled={changeBusy} onChange={event => setConfirmPassword(event.target.value)} ref={node => { secretInputs.current[3] = node?.input ?? null; }} /></label><Button type="primary" loading={changeBusy} onClick={() => void changePassword()}>修改密码并返回登录</Button></div>}
          <Button className="security-access-notice" disabled={changeBusy} onClick={() => void dismissChallenge()}>取消并返回登录</Button>
        </> : <>
          <div className="security-login-fields">
            <label htmlFor="vertical-security-role">登录角色<Select id="vertical-security-role" aria-label="纵密登录角色" value={role} disabled={locked || accessBusy} options={ROLE_OPTIONS} onChange={value => { clearSecrets(); setRole(value); setUsername(''); setResult(null); setError(null); setNotice(null); }} /><Typography.Text className="security-login-role-hint" type="secondary">{ROLE_HINTS[role]}</Typography.Text></label>
            <label htmlFor="vertical-security-username">用户名<Input id="vertical-security-username" aria-label="纵密用户名" value={username} maxLength={32} autoComplete="off" disabled={locked || accessBusy} placeholder="输入纵密账号" onChange={event => setUsername(event.target.value)} /></label>
            <label htmlFor="vertical-security-password">密码<Input.Password id="vertical-security-password" aria-label="纵密密码" value={password} maxLength={32} autoComplete="off" disabled={locked || accessBusy} placeholder="输入纵密密码" onChange={event => setPassword(event.target.value)} onPressEnter={() => void login()} ref={node => { secretInputs.current[0] = node?.input ?? null; }} /></label>
          </div>
          <div className="security-login-actions"><Button type="primary" block icon={<LoginOutlined />} loading={busy} disabled={!allowed || locked || accessBusy || !username.trim() || !password} onClick={() => void login()}>登录纵密</Button>{busy && <Button block loading={cancelling} onClick={() => void cancelLogin()}>取消登录</Button>}</div>
          <details className="security-login-certificate"><summary>连接证书 <span>{profile?.configured ? profile.source === 'builtin' ? builtinSummary : '已配置 · 当前进程有效' : initializing ? '读取中' : '尚未配置'}</span></summary>
            {profile?.source === 'builtin' && profile.configured && <p>{profile.label || '内置配套证书'}已由上位机加载，无需手动选择证书。实际组别须等待本次 TLS 匹配完成。</p>}
            <details className="security-login-builtin-mode"><summary>内置证书模式（高级）</summary><p>自动模式仅在 TLS 握手期间匹配候选证书；发送账号后不切换证书、不自动重试认证。旧版兼容仅适用于固定目标与精确匹配的配套证书，自定义和新版证书保持严格校验。</p><p>已生效模式：{profile?.source === 'builtin' && profile.configured ? BUILTIN_MODE_OPTIONS.find(item => item.value === appliedBuiltinMode)?.label : '当前使用自定义证书或尚未配置'}。下方选择须点击应用才会生效。</p><Space wrap><Select aria-label="内置证书模式" value={builtinMode} options={BUILTIN_MODE_OPTIONS} disabled={locked || accessBusy || initializing} onChange={setBuiltinMode} style={{ minWidth: 210 }} /><Button disabled={locked || accessBusy || initializing} loading={certificateBusy} onClick={() => void applyBuiltinCertificate(builtinMode)}>应用内置证书模式</Button></Space></details>
            <details className="security-login-custom-certificate" open={profile?.source !== 'builtin'}><summary>自定义证书替换（高级）</summary>
            <p>客户端证书使用 PKCS12（.p12 / .pfx），装置信任证书使用 PEM / DER。原 JKS 需先转换，不能直接导入。自定义配置仅在当前进程内有效，重启恢复内置证书自动匹配。</p>
            <Form layout="vertical" onFinish={() => void saveCertificate()} disabled={locked || accessBusy || initializing}>
              <Form.Item label="客户端证书"><Space.Compact block><Input aria-label="客户端证书路径" value={clientPath} readOnly placeholder="选择 .p12 或 .pfx 文件" /><Button icon={<FileOutlined />} onClick={() => void selectCertificate('client')}>选择客户端证书</Button></Space.Compact></Form.Item>
              <Form.Item label="装置信任证书"><Space.Compact block><Input aria-label="信任证书路径" value={trustPath} readOnly placeholder="选择 PEM / DER 证书" /><Button icon={<FileOutlined />} onClick={() => void selectCertificate('trust')}>选择信任证书</Button></Space.Compact></Form.Item>
              <Form.Item label="证书口令"><Input.Password aria-label="纵密证书口令" value={certificatePassword} autoComplete="off" onChange={event => setCertificatePassword(event.target.value)} ref={node => { secretInputs.current[1] = node?.input ?? null; }} /></Form.Item>
              <details className="security-login-advanced"><summary>高级证书校验设置</summary><Form.Item label="服务端证书名称" extra="须与装置证书中的 IP 或 DNS 名称匹配；不会关闭证书验证。"><Input aria-label="服务端证书名称" value={serverName} onChange={event => setServerName(event.target.value)} /></Form.Item></details>
              <Space wrap><Button htmlType="submit" loading={certificateBusy} disabled={locked || accessBusy || initializing || !clientPath || !trustPath || !serverName.trim()}>应用连接证书</Button><Button htmlType="button" disabled={locked || accessBusy || initializing} onClick={() => void applyBuiltinCertificate('auto')}>使用内置配套证书</Button></Space>
            </Form>
            </details>
          </details>
          {initializing && <p role="status">正在读取登录能力与证书配置…</p>}
          {!initializing && capabilities?.reason && (mode === 'direct' ? capabilities.direct_available : capabilities.remote_available) && <p className="security-login-capability"><Typography.Text type="secondary">当前登录能力：{capabilities.reason}</Typography.Text></p>}
          {!initializing && (!capabilities || !(mode === 'direct' ? capabilities.direct_available : capabilities.remote_available)) && <Alert className="security-access-notice" type="info" title={mode === 'remote' ? '远程纵密登录待网络通道接入' : '当前环境暂不支持纵密登录'} description={capabilities?.reason} />}
          {!initializing && profile && !profile.configured && <p className="security-login-hint">请展开连接证书，配置后再登录。</p>}
        </>}
        {error && <Alert className="security-access-notice" type="error" showIcon title={error} />}
        {notice && <Alert className="security-access-notice" type="info" showIcon title={notice} />}
        {result && !session && !mustChangePassword && <Alert className="security-access-notice" type={result.state === 'failed' ? 'error' : 'warning'} showIcon title={result.state === 'unverified_response' ? '装置应答尚未验证，未建立登录会话' : '纵密尚未登录'} description={<>{result.message}{result.lock_seconds !== null && <p>装置返回锁定时间：{result.lock_seconds} 秒</p>}</>} />}
      </Card>
      <aside className="security-login-progress" aria-labelledby="security-login-progress-title"><h2 id="security-login-progress-title">登录进度</h2><div aria-live="polite">{LOGIN_STAGES.map(stage => {
        const step = result?.steps.find(item => item.id === stage.id);
        return <div className="security-access-step" key={stage.id}><Badge status={step?.state === 'success' ? 'success' : step?.state === 'failed' ? 'error' : step?.state === 'unsupported' ? 'warning' : 'default'} /><div><strong>{stage.name}</strong><p>{step?.message || (busy ? '等待装置返回本次检查结果' : '尚未执行')}</p></div><span>{step?.state === 'success' ? '通过' : step?.state === 'failed' ? '失败' : step?.state === 'unsupported' ? '不支持' : '待确认'}</span></div>;
      })}</div>{certificateMatch ? <Alert className="security-access-notice" type={certificateMatch.legacy ? 'warning' : 'info'} showIcon title={certificateMatch.label} description={<>{certificateMatch.compatibility}{certificateMatch.legacy && <p>仅此固定纵密目标、精确配套旧证书允许受限日期与名称兼容；不代表账号已经通过认证。</p>}</>} /> : profile?.source === 'builtin' && <p className="security-login-hint">证书组别待 TLS 匹配确认。</p>}<p className="security-access-boundary">使用纵密装置账号与连接证书。网络检查与身份认证分别显示；ICMP 无响应不阻止尝试登录。</p></aside>
    </div>
  </section>;
}
