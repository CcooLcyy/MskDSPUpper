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
  VerticalSecurityOneClickLoginRequest,
} from '../../adapters';
import { canAttemptLogin, getBuiltinCertificateMode, getCertificateMatchPresentation, isAuthenticatedLogin, LOGIN_STAGES, loginContextMatches, getOneClickLoginUsername, type LoginIdentity } from './login-state';
import { reportLoginConnectionFailure } from './access-state';
import { checkRetainedLogin, clearRetainedLogin, getRetainedLogin, retainLogin, subscribeRetainedLoginInvalidation } from './login-session';
import { formatLockCountdown, getLockSeconds, getLoginLockSeconds, restoreLoginLocks, updateLoginLock, type LoginLock } from './login-lockout';
import SecurityAdmin from './SecurityAdmin';
import SecurityOperator from './SecurityOperator';

const ROLE_OPTIONS = [{ value: 1, label: '系统管理员' }, { value: 2, label: '安全操作员' }];
const ROLE_HINTS = { 1: '管理装置账号与系统设置。', 2: '配置网络、隧道与策略。' };
const BUILTIN_MODE_OPTIONS = [{ value: 'auto', label: '自动匹配旧版／新版' }, { value: 'old', label: '仅旧版配套证书' }, { value: 'new', label: '仅新版配套证书' }];
type ActiveRequest = { identity: LoginIdentity; generation: number; cancelled: boolean };

export default function SecurityLogin({ mode, deviceId, deviceLabel, accessBusy, onLockChange, onAuthenticatedChange, modeControls }: {
  mode: VerticalSecurityAccessMode;
  deviceId?: string;
  deviceLabel?: string;
  accessBusy: boolean;
  onLockChange: (locked: boolean) => void;
  onAuthenticatedChange?: (authenticated: boolean) => void;
  modeControls?: ReactNode;
}) {
  const [capabilities, setCapabilities] = useState<VerticalSecurityLoginCapabilities | null>(null);
  const [profile, setProfile] = useState<VerticalSecurityCertificateProfile | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [role, setRole] = useState<VerticalSecurityOneClickLoginRequest['role']>(1);
  const username = getOneClickLoginUsername(role);
  const [clientPath, setClientPath] = useState('');
  const [trustPath, setTrustPath] = useState('');
  const [certificatePassword, setCertificatePassword] = useState('');
  const [serverName, setServerName] = useState('11.22.33.44');
  const [builtinMode, setBuiltinMode] = useState<VerticalSecurityBuiltinCertificateMode>('auto');
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [certificateBusy, setCertificateBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [autoRestartBusy, setAutoRestartBusy] = useState(false);
  const [result, setResult] = useState<VerticalSecurityLoginResult | null>(null);
  const [session, setSession] = useState<VerticalSecurityLoginResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loginLocks, setLoginLocks] = useState<LoginLock[]>([]);
  const [lockClock, setLockClock] = useState(() => performance.now());
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const activeRef = useRef<ActiveRequest | null>(null);
  const sessionRef = useRef<string | null>(null);
  const restoringRef = useRef(getRetainedLogin()?.session_id ?? null);
  const secretInputs = useRef<Array<HTMLInputElement | null>>([]);
  const autoRestartRef = useRef(false);
  const expectedRebootRef = useRef<string | null>(null);
  const locked = busy || certificateBusy || logoutBusy || autoRestartBusy || Boolean(session) || Boolean(getRetainedLogin());
  const allowed = !initializing && canAttemptLogin(mode, deviceId, capabilities, profile);
  const accountLockSeconds = getLoginLockSeconds(loginLocks, { mode, device_id: deviceId, username }, lockClock);
  const targetLocks = loginLocks.filter(lock => lock.mode === mode && lock.device_id === (mode === 'remote' ? deviceId : null));
  const certificateMatch = getCertificateMatchPresentation(result);
  const appliedBuiltinMode = getBuiltinCertificateMode(profile);
  const builtinSummary = appliedBuiltinMode === 'auto' ? '内置配套证书 · 自动匹配' : appliedBuiltinMode === 'old' ? '内置配套证书 · 仅旧版' : '内置配套证书 · 仅新版';

  useEffect(() => { onLockChange(locked); }, [locked, onLockChange]);
  useEffect(() => { onAuthenticatedChange?.(Boolean(session)); }, [session, onAuthenticatedChange]);

  useEffect(() => {
    if (!loginLocks.some(lock => getLockSeconds(lock, performance.now()) > 0)) return;
    const tick = () => {
      const now = performance.now();
      setLockClock(now);
      if (!loginLocks.some(lock => getLockSeconds(lock, now) > 0)) window.clearInterval(timer);
    };
    const timer = window.setInterval(tick, 250);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [loginLocks]);

  useEffect(() => {
    mountedRef.current = true;
    const inputs = secretInputs.current;
    let current = true;
    const unsubscribe = subscribeRetainedLoginInvalidation((id, invalidated) => {
      if (!current || (sessionRef.current !== id && restoringRef.current !== id)) return;
      sessionRef.current = null; restoringRef.current = null;
      setSession(null); setResult(null);
      if (invalidated && expectedRebootRef.current !== id) setError('纵密连接已失效或状态无法确认，请重新登录。');
    });
    const lockSnapshot = api.getVerticalSecurityLoginLocks().then(locks => ({ locks, sampledAt: performance.now() }));
    void Promise.all([api.getVerticalSecurityLoginCapabilities(), api.getVerticalSecurityCertificateProfile(), checkRetainedLogin(), lockSnapshot]).then(([available, configured, restored, snapshot]) => {
      if (!current) return;
      const now = performance.now();
      setLoginLocks(restoreLoginLocks(snapshot.locks, snapshot.sampledAt)); setLockClock(now);
      if (snapshot.locks.length) console.info('[纵密登录] 已恢复装置返回的账号锁定等待');
      setCapabilities(available); setProfile(configured);
      setClientPath(configured.client_certificate_path ?? '');
      setTrustPath(configured.trust_certificate_path ?? '');
      setServerName(configured.server_name || '11.22.33.44');
      setBuiltinMode(getBuiltinCertificateMode(configured));
      if (restored && restored.role !== 1 && restored.role !== 2) {
        clearRetainedLogin(restored.session_id!);
        void api.logoutVerticalSecurity(restored.session_id!).catch(() => {});
      } else if (restored && (restored.role === 1 || restored.role === 2) && getRetainedLogin() === restored && restored.mode === mode && restored.device_id === (mode === 'remote' ? deviceId : null)) {
        sessionRef.current = restored.session_id;
        setSession(restored); setResult(restored);
        setRole(restored.role);
        console.info('[纵密会话] 返回登录页，原连接检查通过');
      }
      restoringRef.current = null;
    }).catch(() => { if (current) setError('读取纵密登录能力、证书配置或锁定状态失败，请离开此页后重试。'); })
      .finally(() => { if (current) setInitializing(false); });
    return () => {
      current = false;
      unsubscribe();
      mountedRef.current = false;
      generationRef.current += 1;
      const active = activeRef.current;
      if (active) { active.cancelled = true; void api.cancelVerticalSecurityLogin(active.identity.request_id).catch(() => {}); }
      for (const input of inputs) if (input) input.value = '';
      onLockChange(false);
    };
  }, [onLockChange, mode, deviceId]);

  const clearSecrets = () => { setCertificatePassword(''); };
  const cleanupReturnedSession = async (value: VerticalSecurityLoginResult) => {
    if (!value.session_id) return;
    try { await api.logoutVerticalSecurity(value.session_id); } catch { /* 清理结果不能覆盖新请求的界面状态。 */ }
  };
  const cleanupReturnedConnection = async (value: VerticalSecurityLoginResult, requestId: string) => {
    await cleanupReturnedSession(value);
    const id = value.challenge_id?.trim() ? value.challenge_id : value.state === 'password_change_required' ? requestId : null;
    if (id) { try { await api.cancelVerticalSecurityLogin(id); } catch { /* 后端到期清理仍会关闭该临时连接。 */ } }
  };

  const rebootAuthenticatedAdmin = async (value: VerticalSecurityLoginResult) => {
    const id = value.session_id;
    if (!id || value.role !== 1 || value.state !== 'authenticated') throw new Error('重启纵密设备需要已认证的系统管理员。');
    const generation = generationRef.current;
    expectedRebootRef.current = id;
    setNotice('正在发送纵密装置重启命令。'); setError(null);
    console.info('[纵密设备维护] 使用管理员会话发送设备重启请求');
    try {
      const response = await api.runVerticalSecurityAdmin({ session_id: id, action: 'reboot_device' });
      if (response.status !== 'reboot_requested') throw new Error('纵密重启命令发送结果未确认，请核实装置状态；不会自动重试。');
      if (mountedRef.current && generationRef.current === generation) setNotice(response.message);
    } catch (reason) {
      if (mountedRef.current && generationRef.current === generation) {
        setNotice(null);
        setError(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '纵密设备重启结果未确认，请核实装置状态后重新登录；不会自动重试。');
      }
    } finally {
      // 重启可能直接断开管理连接；不保留可再次发送维护命令的旧身份。
      clearRetainedLogin(id);
      void api.logoutVerticalSecurity(id).catch(() => {});
      if (mountedRef.current && generationRef.current === generation) {
        sessionRef.current = null; setSession(null); setResult(null); setRole(1);
      }
      if (expectedRebootRef.current === id) expectedRebootRef.current = null;
    }
  };

  const login = async (requestedRole = role, restartAfterLogin = false) => {
    if (!allowed || (!restartAfterLogin && locked) || accessBusy || activeRef.current
      || (restartAfterLogin && (!autoRestartRef.current || sessionRef.current))) return;
    const requestedUsername = getOneClickLoginUsername(requestedRole);
    if (getLoginLockSeconds(loginLocks, { mode, device_id: deviceId, username: requestedUsername }, performance.now()) > 0) {
      console.info('[纵密登录] 账号仍在装置返回的锁定等待期间，未提交认证请求');
      if (restartAfterLogin) setError('四页配置已上传，但管理员账号仍在锁定等待期间；未发送重启命令，请解锁后登录管理员重启纵密设备。');
      return;
    }
    const request: VerticalSecurityOneClickLoginRequest = { request_id: `vertical-login-${crypto.randomUUID()}`, mode, ...(mode === 'remote' ? { device_id: deviceId } : {}), role: requestedRole };
    const identity: LoginIdentity = { ...request, username: requestedUsername };
    const active = { identity, generation: ++generationRef.current, cancelled: false };
    activeRef.current = active;
    setBusy(true); setResult(null); setError(null); setNotice(restartAfterLogin ? '四页配置已上传并回读核对，正在认证管理员。' : null);
    clearSecrets();
    try {
      console.info('[纵密登录] 已提交一键登录请求', { role: requestedRole });
      const value = await api.loginVerticalSecurityOneClick(request);
      if (!mountedRef.current || active.cancelled || generationRef.current !== active.generation) {
        await cleanupReturnedConnection(value, identity.request_id); return;
      }
      if (!loginContextMatches(identity, value)) {
        await cleanupReturnedConnection(value, identity.request_id);
        if (mountedRef.current && !active.cancelled && generationRef.current === active.generation) {
          setError('登录结果与当前请求或目标设备不匹配，已拒绝建立纵密身份。');
          if (restartAfterLogin) setNotice('四页配置已上传，未发送重启命令。');
        }
        return;
      }
      if (value.state === 'failed' && value.code === 'account_locked') {
        const now = performance.now();
        setLoginLocks(locks => updateLoginLock(locks, identity, value.lock_seconds, now)); setLockClock(now);
        console.info('[纵密登录] 收到装置账号锁定应答，按有效剩余时间等待');
      }
      reportLoginConnectionFailure(value);
      if (value.state === 'authenticated') {
        if (!isAuthenticatedLogin(identity, value)) {
          await cleanupReturnedConnection(value, identity.request_id);
          if (mountedRef.current && !active.cancelled && generationRef.current === active.generation) {
            setError('登录身份或初始化结果不完整，已拒绝建立纵密身份。');
            if (restartAfterLogin) setNotice('四页配置已上传，未发送重启命令。');
          }
          return;
        }
        if (restartAfterLogin) {
          // 自动切号只使用本次认证的管理员连接，不挂载工作台以免初刷与重启并发。
          setBusy(false); setResult(value);
          await rebootAuthenticatedAdmin(value);
        } else {
          sessionRef.current = value.session_id;
          retainLogin(value);
          setSession(value); setResult(value);
        }
      } else {
        await cleanupReturnedConnection(value, identity.request_id);
        if (!mountedRef.current || active.cancelled || generationRef.current !== active.generation) return;
        if (value.state === 'password_change_required') {
          setError('一键登录未完成密码处理，当前账号尚未登录。');
        }
        setResult({ ...value, session_id: null });
        if (restartAfterLogin) setNotice('四页配置已上传，但管理员登录未完成，未发送重启命令。');
      }
    } catch {
      if (mountedRef.current && !active.cancelled && generationRef.current === active.generation) {
        setError('纵密登录失败，请检查连接与装置状态后手动重试。');
        if (restartAfterLogin) setNotice('四页配置已上传，但管理员登录失败，未发送重启命令。');
      }
    } finally {
      if (activeRef.current === active && !active.cancelled) activeRef.current = null;
      if (mountedRef.current && generationRef.current === active.generation && !active.cancelled) setBusy(false);
    }
  };

  const completeAutoConfiguration = async () => {
    const id = sessionRef.current;
    if (!id || session?.role !== 2 || autoRestartRef.current || activeRef.current || accessBusy) return;
    const generation = generationRef.current;
    autoRestartRef.current = true; setAutoRestartBusy(true); setError(null);
    setNotice('四页配置已上传并回读核对，正在切换管理员以重启纵密装置。');
    try {
      await api.logoutVerticalSecurity(id);
      clearRetainedLogin(id);
      if (!mountedRef.current || generationRef.current !== generation) return;
      sessionRef.current = null; setSession(null); setResult(null); setRole(1);
      console.info('[纵密自动配置] 四页已核对，安全操作员退出完成，开始管理员认证');
      await login(1, true);
    } catch (reason) {
      if (mountedRef.current && generationRef.current === generation) setError(reason instanceof Error ? reason.message : '四页配置已上传，但退出安全操作员失败；未切换管理员或发送重启命令。');
    } finally {
      autoRestartRef.current = false;
      if (mountedRef.current) { setAutoRestartBusy(false); setAdminBusy(false); }
    }
  };

  const rebootCurrentDevice = async () => {
    if (!session || session.role !== 1 || sessionRef.current !== session.session_id || autoRestartRef.current || accessBusy) return;
    autoRestartRef.current = true; setAutoRestartBusy(true);
    try { await rebootAuthenticatedAdmin(session); }
    finally { autoRestartRef.current = false; if (mountedRef.current) { setAutoRestartBusy(false); setAdminBusy(false); } }
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
    if (!id || logoutBusy || adminBusy || autoRestartRef.current) return;
    const generation = generationRef.current;
    clearSecrets(); setLogoutBusy(true); setError(null);
    try {
      await api.logoutVerticalSecurity(id);
      const appliesToPage = mountedRef.current && generationRef.current === generation && sessionRef.current === id;
      // 退出应答可能在切页之后到达，仍须清除进程内的共享身份。
      clearRetainedLogin(id);
      if (!appliesToPage) return;
      sessionRef.current = null;
      setSession(null); setResult(null); setNotice('已退出纵密登录。');
    } catch { if (mountedRef.current && generationRef.current === generation && sessionRef.current === id) setError('退出纵密登录失败，会话记录仍保留，请重试。'); }
    finally { if (mountedRef.current && (generationRef.current === generation || sessionRef.current === null)) setLogoutBusy(false); }
  };

  return <section className="security-login-workbench" aria-label="纵密登录工作台">
    {!session && <div className="security-login-context" aria-label={`当前连接：${mode === 'direct' ? '101 口直连' : `平台远程 · ${deviceLabel || deviceId || '尚未选择 DSP'}`}`}>
      {modeControls && <div className="security-login-mode-controls">{modeControls}</div>}
      <div className="security-login-target-summary"><span>纵密目标 <strong>11.22.33.44</strong></span><span>出口：DSP 108 口</span></div>
    </div>}
    {session ? <>
      <header className="security-admin-session" aria-label="当前纵密会话">
        <div><h2>已登录纵密装置</h2><dl><div><dt>当前账号</dt><dd>{session.username}</dd></div><div><dt>当前角色</dt><dd>{ROLE_OPTIONS.find(item => item.value === session.role)?.label}</dd></div><div><dt>装置版本</dt><dd>{session.device_version || '未提供'}</dd></div><div><dt>装置地址</dt><dd>{session.target_ip}</dd></div></dl></div>
        <Button icon={<LogoutOutlined />} loading={logoutBusy} disabled={adminBusy || autoRestartBusy} onClick={() => void logout()}>退出纵密登录</Button>
      </header>
      {error && <Alert className="security-access-notice" type="error" showIcon title={error} />}
      {notice && <Alert className="security-access-notice" type="info" showIcon title={notice} />}
    </> : <div className="security-access-columns security-login-columns">
      <Card className="security-login-auth" title="装置身份认证" extra={<Tag color={session ? 'success' : busy ? 'processing' : 'default'}>{session ? '已登录' : busy ? '认证中' : '未登录'}</Tag>}>
        <div className="security-login-fields">
          <label htmlFor="vertical-security-role">登录角色<Select id="vertical-security-role" aria-label="纵密登录角色" value={role} disabled={locked || accessBusy} options={ROLE_OPTIONS} onChange={value => { clearSecrets(); setRole(value); setResult(null); setError(null); setNotice(null); }} /><Typography.Text className="security-login-role-hint" type="secondary">{ROLE_HINTS[role]}</Typography.Text></label>
        </div>
        <div className="security-login-actions"><Button type="primary" block icon={<LoginOutlined />} loading={busy} disabled={!allowed || locked || accessBusy || accountLockSeconds > 0} onClick={() => void login()}>登录纵密{accountLockSeconds > 0 && `（${formatLockCountdown(accountLockSeconds)} 后可重试）`}</Button>{busy && <Button block loading={cancelling} onClick={() => void cancelLogin()}>取消登录</Button>}</div>
          <details className="security-login-certificate"><summary>连接证书 <span>{profile?.configured ? profile.source === 'builtin' ? builtinSummary : '已配置 · 当前进程有效' : initializing ? '读取中' : '尚未配置'}</span></summary>
            {profile?.source === 'builtin' && profile.configured && <p>{profile.label || '内置配套证书'}已由上位机加载，无需手动选择证书。实际组别须等待本次 TLS 匹配完成。</p>}
            <details className="security-login-builtin-mode"><summary>内置证书模式（高级）</summary><p>自动模式仅在 TLS 握手期间匹配候选证书；账号认证仅在装置明确拒绝默认凭据后切换一次预设凭据；其他异常立即停止。旧版兼容仅适用于固定目标与精确匹配的配套证书，自定义和新版证书保持严格校验。</p><p>已生效模式：{profile?.source === 'builtin' && profile.configured ? BUILTIN_MODE_OPTIONS.find(item => item.value === appliedBuiltinMode)?.label : '当前使用自定义证书或尚未配置'}。下方选择须点击应用才会生效。</p><Space wrap><Select aria-label="内置证书模式" value={builtinMode} options={BUILTIN_MODE_OPTIONS} disabled={locked || accessBusy || initializing} onChange={setBuiltinMode} style={{ minWidth: 210 }} /><Button disabled={locked || accessBusy || initializing} loading={certificateBusy} onClick={() => void applyBuiltinCertificate(builtinMode)}>应用内置证书模式</Button></Space></details>
            <details className="security-login-custom-certificate" open={profile?.source !== 'builtin'}><summary>自定义证书替换（高级）</summary>
            <p>客户端证书使用 PKCS12（.p12 / .pfx），装置信任证书使用 PEM / DER。原 JKS 需先转换，不能直接导入。自定义配置仅在当前进程内有效，重启恢复内置证书自动匹配。</p>
            <Form layout="vertical" onFinish={() => void saveCertificate()} disabled={locked || accessBusy || initializing}>
              <Form.Item label="客户端证书"><Space.Compact block><Input aria-label="客户端证书路径" value={clientPath} readOnly placeholder="选择 .p12 或 .pfx 文件" /><Button icon={<FileOutlined />} onClick={() => void selectCertificate('client')}>选择客户端证书</Button></Space.Compact></Form.Item>
              <Form.Item label="装置信任证书"><Space.Compact block><Input aria-label="信任证书路径" value={trustPath} readOnly placeholder="选择 PEM / DER 证书" /><Button icon={<FileOutlined />} onClick={() => void selectCertificate('trust')}>选择信任证书</Button></Space.Compact></Form.Item>
              <Form.Item label="证书口令"><Input.Password aria-label="纵密证书口令" value={certificatePassword} autoComplete="off" onChange={event => setCertificatePassword(event.target.value)} ref={node => { secretInputs.current[0] = node?.input ?? null; }} /></Form.Item>
              <details className="security-login-advanced"><summary>高级证书校验设置</summary><Form.Item label="服务端证书名称" extra="须与装置证书中的 IP 或 DNS 名称匹配；不会关闭证书验证。"><Input aria-label="服务端证书名称" value={serverName} onChange={event => setServerName(event.target.value)} /></Form.Item></details>
              <Space wrap><Button htmlType="submit" loading={certificateBusy} disabled={locked || accessBusy || initializing || !clientPath || !trustPath || !serverName.trim()}>应用连接证书</Button><Button htmlType="button" disabled={locked || accessBusy || initializing} onClick={() => void applyBuiltinCertificate('auto')}>使用内置配套证书</Button></Space>
            </Form>
            </details>
          </details>
          {initializing && <p role="status">正在读取登录能力与证书配置…</p>}
          {!initializing && capabilities?.reason && (mode === 'direct' ? capabilities.direct_available : capabilities.remote_available) && <p className="security-login-capability"><Typography.Text type="secondary">当前登录能力：{capabilities.reason}</Typography.Text></p>}
          {!initializing && (!capabilities || !(mode === 'direct' ? capabilities.direct_available : capabilities.remote_available)) && <Alert className="security-access-notice" type="info" title={mode === 'remote' ? '远程纵密登录待网络通道接入' : '当前环境暂不支持纵密登录'} description={capabilities?.reason} />}
          {!initializing && profile && !profile.configured && <p className="security-login-hint">请展开连接证书，配置后再登录。</p>}
        {error && <Alert className="security-access-notice" type="error" showIcon title={error} />}
        {notice && <Alert className="security-access-notice" type="info" showIcon title={notice} />}
        {!session && targetLocks.map(lock => {
          const seconds = getLockSeconds(lock, lockClock);
          return <Alert key={lock.username} className="security-access-notice" type={seconds > 0 ? 'warning' : 'info'} showIcon
            title={seconds > 0 ? `纵密账号 ${lock.username} 已锁定，剩余 ${formatLockCountdown(seconds)}` : `纵密账号 ${lock.username} 的锁定等待时间已结束`}
            description={seconds > 0 ? '等待时间由纵密装置返回，期间不能再次提交该账号的登录请求。' : '可手动重新尝试登录，是否解锁以纵密装置应答为准。'} />;
        })}
        {result && !session && !(result.code === 'account_locked' && result.lock_seconds !== null && result.lock_seconds > 0) && <Alert className="security-access-notice" type={result.state === 'failed' ? 'error' : 'warning'} showIcon title={result.state === 'unverified_response' ? '装置应答尚未验证，未建立登录会话' : '纵密尚未登录'} description={<>{result.message}{result.code === 'account_locked' && result.lock_seconds === null && <p>装置未提供有效剩余时间，无法显示倒计时。</p>}{result.code === 'account_locked' && result.lock_seconds === 0 && <p>装置返回剩余 0 秒，可手动重新尝试登录。</p>}</>} />}
      </Card>
      <aside className="security-login-progress" aria-labelledby="security-login-progress-title"><h2 id="security-login-progress-title">登录进度</h2><div aria-live="polite">{LOGIN_STAGES.map(stage => {
        const step = result?.steps.find(item => item.id === stage.id);
        return <div className="security-access-step" key={stage.id}><Badge status={step?.state === 'success' ? 'success' : step?.state === 'failed' ? 'error' : step?.state === 'unsupported' ? 'warning' : 'default'} /><div><strong>{stage.name}</strong><p>{step?.message || (busy ? '等待装置返回本次检查结果' : '尚未执行')}</p></div><span>{step?.state === 'success' ? '通过' : step?.state === 'failed' ? '失败' : step?.state === 'unsupported' ? '不支持' : '待确认'}</span></div>;
      })}</div>{certificateMatch ? <Alert className="security-access-notice" type={certificateMatch.legacy ? 'warning' : 'info'} showIcon title={certificateMatch.label} description={<>{certificateMatch.compatibility}{certificateMatch.legacy && <p>仅此固定纵密目标、精确配套旧证书允许受限日期与名称兼容；不代表账号已经通过认证。</p>}</>} /> : profile?.source === 'builtin' && <p className="security-login-hint">证书组别待 TLS 匹配确认。</p>}<p className="security-access-boundary">使用纵密装置账号与连接证书。网络检查与身份认证分别显示；ICMP 无响应不阻止尝试登录。</p></aside>
    </div>}
    {session?.state === 'authenticated' && session.role === 2 && session.session_id && <SecurityOperator key={session.session_id} sessionId={session.session_id} disabled={logoutBusy || accessBusy || autoRestartBusy} onBusyChange={setAdminBusy} autoConfigurationAvailable={mode === 'direct'} onAutoConfigured={completeAutoConfiguration} />}
    {session?.state === 'authenticated' && session.role === 1 && session.session_id && <SecurityAdmin key={session.session_id} sessionId={session.session_id} disabled={logoutBusy || accessBusy || autoRestartBusy} onBusyChange={setAdminBusy} onRebootDevice={rebootCurrentDevice} />}
  </section>;
}
