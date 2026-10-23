import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Form, Input, Select, Space, Tag, Typography } from 'antd';
import { FileOutlined, LoginOutlined, LogoutOutlined } from '@ant-design/icons';
import { api } from '../../adapters';
import type {
  VerticalSecurityAccessMode,
  VerticalSecurityCertificateProfile,
  VerticalSecurityLoginCapabilities,
  VerticalSecurityLoginResult,
  VerticalSecurityRole,
} from '../../adapters';
import { canAttemptLogin, isAuthenticatedLogin, LOGIN_STAGES, loginContextMatches, type LoginIdentity } from './login-state';

const ROLE_OPTIONS = [{ value: 1, label: '系统管理员' }, { value: 2, label: '安全操作员' }, { value: 3, label: '日志审计员' }];
const ROLE_HINTS = { 1: '管理装置账号与系统设置。', 2: '配置网络、隧道与策略。', 3: '查看运行日志与审计信息。' };
type ActiveRequest = { identity: LoginIdentity; generation: number; cancelled: boolean };

export default function SecurityLogin({ mode, deviceId, deviceLabel, accessBusy, onLockChange }: {
  mode: VerticalSecurityAccessMode;
  deviceId?: string;
  deviceLabel?: string;
  accessBusy: boolean;
  onLockChange: (locked: boolean) => void;
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
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [certificateBusy, setCertificateBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [changeBusy, setChangeBusy] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [result, setResult] = useState<VerticalSecurityLoginResult | null>(null);
  const [session, setSession] = useState<VerticalSecurityLoginResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const activeRef = useRef<ActiveRequest | null>(null);
  const sessionRef = useRef<string | null>(null);
  const challengeRef = useRef<string | null>(null);
  const secretInputs = useRef<Array<HTMLInputElement | null>>([]);
  const challenge = result?.state === 'password_change_required' ? result.challenge_id : null;
  const mustChangePassword = result?.state === 'password_change_required';
  const locked = busy || certificateBusy || logoutBusy || changeBusy || Boolean(session) || mustChangePassword;
  const allowed = !initializing && canAttemptLogin(mode, deviceId, capabilities, profile);

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
    }).catch(() => { if (current) setError('读取纵密登录能力或证书配置失败，请离开此页后重试。'); })
      .finally(() => { if (current) setInitializing(false); });
    return () => {
      current = false;
      mountedRef.current = false;
      generationRef.current += 1;
      const active = activeRef.current;
      if (active) { active.cancelled = true; void api.cancelVerticalSecurityLogin(active.identity.request_id).catch(() => {}); }
      if (sessionRef.current) void api.logoutVerticalSecurity(sessionRef.current).catch(() => {});
      if (challengeRef.current && !active) void api.cancelVerticalSecurityLogin(challengeRef.current).catch(() => {});
      for (const input of inputs) if (input) input.value = '';
      onLockChange(false);
    };
  }, [onLockChange]);

  const clearSecrets = () => { setPassword(''); setCertificatePassword(''); setNewPassword(''); setConfirmPassword(''); };
  const cleanupReturnedSession = async (value: VerticalSecurityLoginResult) => {
    if (!value.session_id) return;
    try { await api.logoutVerticalSecurity(value.session_id); }
    catch { if (mountedRef.current) setError('返回的异常或过期会话清理失败，请检查装置连接后退出此页重试。'); }
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
        await cleanupReturnedSession(value); return;
      }
      if (!loginContextMatches(identity, value)) {
        await cleanupReturnedSession(value);
        if (mountedRef.current) setError('登录结果与当前请求或目标设备不匹配，已拒绝建立纵密身份。');
        return;
      }
      if (value.state === 'authenticated') {
        if (!isAuthenticatedLogin(identity, value)) {
          await cleanupReturnedSession(value);
          if (mountedRef.current) setError('登录身份或初始化结果不完整，已拒绝建立纵密身份。');
          return;
        }
        sessionRef.current = value.session_id;
        setSession(value); setResult(value);
      } else {
        await cleanupReturnedSession(value);
        if (!mountedRef.current || active.cancelled || generationRef.current !== active.generation) return;
        if (value.state === 'password_change_required' && value.challenge_id && capabilities?.password_change_available
          && (value.username !== identity.username || value.role !== identity.role)) {
          setError('密码变更结果与当前账号或角色不匹配，已拒绝使用此结果。'); return;
        }
        setResult({ ...value, session_id: null });
        if (value.state === 'password_change_required') challengeRef.current = identity.request_id;
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
      if (mountedRef.current) { setProfile(value); setNotice(value.configured ? '连接证书已配置，仅在当前上位机进程内有效。' : '连接证书尚未配置成功。'); }
    } catch { if (mountedRef.current) setError('证书配置失败，请检查格式、口令与装置信任证书。'); }
    finally { if (mountedRef.current) setCertificateBusy(false); }
  };

  const restoreBuiltinCertificate = async () => {
    if (locked || accessBusy || initializing) return;
    clearSecrets(); setCertificateBusy(true); setError(null); setNotice(null);
    try {
      const value = await api.useBuiltinVerticalSecurityCertificates();
      if (!mountedRef.current) return;
      setProfile(value);
      setClientPath(value.client_certificate_path ?? '');
      setTrustPath(value.trust_certificate_path ?? '');
      setServerName(value.server_name || '11.22.33.44');
      if (value.configured && value.source === 'builtin') setNotice('已加载内置配套证书。');
      else setError('内置配套证书尚未加载成功，当前不能使用内置证书登录。');
    } catch { if (mountedRef.current) setError('加载内置配套证书失败，请检查应用资源与证书状态。'); }
    finally { if (mountedRef.current) setCertificateBusy(false); }
  };

  const logout = async () => {
    const id = sessionRef.current;
    if (!id || logoutBusy) return;
    clearSecrets(); setLogoutBusy(true); setError(null);
    try {
      await api.logoutVerticalSecurity(id);
      sessionRef.current = null;
      if (mountedRef.current) { setSession(null); setResult(null); setNotice('已退出纵密登录。'); }
    } catch { if (mountedRef.current) setError('退出纵密登录失败，会话记录仍保留，请重试。'); }
    finally { if (mountedRef.current) setLogoutBusy(false); }
  };

  const dismissChallenge = async () => {
    if (!challengeRef.current || changeBusy) return;
    clearSecrets(); setChangeBusy(true);
    try {
      await api.cancelVerticalSecurityLogin(challengeRef.current);
      challengeRef.current = null;
      if (mountedRef.current) { setResult(null); setNotice('已结束密码变更流程，请重新登录。'); }
    } catch { if (mountedRef.current) setError('结束密码变更流程失败，请重试。'); }
    finally { if (mountedRef.current) setChangeBusy(false); }
  };

  const changePassword = async () => {
    if (!capabilities?.password_change_available || !challenge || changeBusy) return;
    if (!newPassword || newPassword.length > 32 || newPassword !== confirmPassword) { setError('请填写不超过 32 个字符的新密码，并确认两次输入一致。'); return; }
    const secret = newPassword;
    clearSecrets(); setChangeBusy(true); setError(null);
    try {
      const value = await api.changeVerticalSecurityPassword({ challenge_id: challenge, new_password: secret });
      if (!mountedRef.current) return;
      if (value.changed) { challengeRef.current = null; setResult(null); setNotice('密码已修改，请重新登录纵密装置。'); }
      else setError('密码修改未完成，请检查装置状态；当前账号仍未登录。');
    } catch { if (mountedRef.current) setError('密码修改失败，当前账号仍未登录。'); }
    finally { if (mountedRef.current) setChangeBusy(false); }
  };

  return <section className="security-login-workbench" aria-label="纵密登录工作台">
    <header className="security-workbench-heading"><h2>登录纵密装置</h2><p>纵密账号和会话独立管理，不复用平台、上位机或 SSH 身份。</p></header>
    <div className="security-login-context"><span>纵密目标 <strong>11.22.33.44</strong></span><span>当前路径：{mode === 'direct' ? '101 口直连 · 经 DSP 108 口' : `平台远程 · ${deviceLabel || deviceId || '尚未选择 DSP'}`}</span></div>
    <div className="security-access-columns">
      <Card title="装置身份认证" extra={<Tag color={session ? 'success' : busy ? 'processing' : 'default'}>{session ? '已登录' : busy ? '认证中' : '未登录'}</Tag>}>
        {session ? <>
          <Alert type="success" showIcon title="已登录纵密装置" description="当前会话仅用于身份认证；纵密业务入口尚未接入。" />
          <dl className="security-login-session"><dt>当前账号</dt><dd>{session.username}</dd><dt>当前角色</dt><dd>{ROLE_OPTIONS.find(item => item.value === session.role)?.label}</dd><dt>装置地址</dt><dd>{session.target_ip}</dd><dt>装置版本</dt><dd>{session.device_version || '未提供'}</dd><dt>上次登录</dt><dd>{session.last_login_at || '未提供'}</dd></dl>
          <Button icon={<LogoutOutlined />} loading={logoutBusy} onClick={() => void logout()}>退出纵密登录</Button>
        </> : mustChangePassword ? <>
          <Alert type="warning" showIcon title="需要修改纵密密码" description={result?.message} />
          {!capabilities?.password_change_available || !challenge ? <Alert className="security-access-notice" type="info" title="密码修改流程尚未验证，当前不可修改" description="此状态不代表已经登录纵密装置。" /> : <div className="security-login-fields"><label>新密码<Input.Password aria-label="纵密新密码" value={newPassword} maxLength={32} autoComplete="off" disabled={changeBusy} onChange={event => setNewPassword(event.target.value)} /></label><label>确认新密码<Input.Password aria-label="确认纵密新密码" value={confirmPassword} maxLength={32} autoComplete="off" disabled={changeBusy} onChange={event => setConfirmPassword(event.target.value)} /></label><Button type="primary" loading={changeBusy} onClick={() => void changePassword()}>修改并重新登录</Button></div>}
          <Button className="security-access-notice" disabled={changeBusy} onClick={() => void dismissChallenge()}>取消并返回登录</Button>
        </> : <>
          <div className="security-login-fields">
            <label htmlFor="vertical-security-role">登录角色<Select id="vertical-security-role" aria-label="纵密登录角色" value={role} disabled={locked || accessBusy} options={ROLE_OPTIONS} onChange={value => { clearSecrets(); setRole(value); setUsername(''); setResult(null); setError(null); setNotice(null); }} /></label>
            <Typography.Text type="secondary">{ROLE_HINTS[role]}</Typography.Text>
            <label htmlFor="vertical-security-username">用户名<Input id="vertical-security-username" aria-label="纵密用户名" value={username} maxLength={32} autoComplete="off" disabled={locked || accessBusy} placeholder="输入纵密账号" onChange={event => setUsername(event.target.value)} /></label>
            <label htmlFor="vertical-security-password">密码<Input.Password id="vertical-security-password" aria-label="纵密密码" value={password} maxLength={32} autoComplete="off" disabled={locked || accessBusy} placeholder="输入纵密密码" onChange={event => setPassword(event.target.value)} onPressEnter={() => void login()} ref={node => { secretInputs.current[0] = node?.input ?? null; }} /></label>
          </div>
          <details className="security-login-certificate"><summary>连接证书 <span>{profile?.configured ? profile.source === 'builtin' ? '内置配套证书 · 自动加载' : '已配置 · 当前进程有效' : initializing ? '读取中' : '尚未配置'}</span></summary>
            {profile?.source === 'builtin' && profile.configured && <p>{profile.label || '内置配套证书'}已由上位机加载，无需手动选择证书。</p>}
            <details className="security-login-custom-certificate" open={profile?.source !== 'builtin'}><summary>自定义证书替换（高级）</summary>
            <p>客户端证书使用 PKCS12（.p12 / .pfx），装置信任证书使用 PEM / DER。原 JKS 需先转换，不能直接导入。自定义配置仅在当前进程内有效，重启恢复内置配套证书。</p>
            <Form layout="vertical" onFinish={() => void saveCertificate()} disabled={locked || accessBusy || initializing}>
              <Form.Item label="客户端证书"><Space.Compact block><Input aria-label="客户端证书路径" value={clientPath} readOnly placeholder="选择 .p12 或 .pfx 文件" /><Button icon={<FileOutlined />} onClick={() => void selectCertificate('client')}>选择客户端证书</Button></Space.Compact></Form.Item>
              <Form.Item label="装置信任证书"><Space.Compact block><Input aria-label="信任证书路径" value={trustPath} readOnly placeholder="选择 PEM / DER 证书" /><Button icon={<FileOutlined />} onClick={() => void selectCertificate('trust')}>选择信任证书</Button></Space.Compact></Form.Item>
              <Form.Item label="证书口令"><Input.Password aria-label="纵密证书口令" value={certificatePassword} autoComplete="off" onChange={event => setCertificatePassword(event.target.value)} ref={node => { secretInputs.current[1] = node?.input ?? null; }} /></Form.Item>
              <details className="security-login-advanced"><summary>高级证书校验设置</summary><Form.Item label="服务端证书名称" extra="须与装置证书中的 IP 或 DNS 名称匹配；不会关闭证书验证。"><Input aria-label="服务端证书名称" value={serverName} onChange={event => setServerName(event.target.value)} /></Form.Item></details>
              <Space wrap><Button htmlType="submit" loading={certificateBusy} disabled={locked || accessBusy || initializing || !clientPath || !trustPath || !serverName.trim()}>应用连接证书</Button><Button htmlType="button" disabled={locked || accessBusy || initializing} onClick={() => void restoreBuiltinCertificate()}>使用内置配套证书</Button></Space>
            </Form>
            </details>
          </details>
          {initializing && <p role="status">正在读取登录能力与证书配置…</p>}
          {!initializing && capabilities?.reason && <Alert className="security-access-notice" type="info" title="当前登录能力" description={capabilities.reason} />}
          {!initializing && (!capabilities || !(mode === 'direct' ? capabilities.direct_available : capabilities.remote_available)) && <Alert className="security-access-notice" type="info" title={mode === 'remote' ? '远程纵密登录待网络通道接入' : '当前环境暂不支持纵密登录'} description={capabilities?.reason} />}
          {!initializing && profile && !profile.configured && <p className="security-login-hint">请展开连接证书，配置后再登录。</p>}
          <Space wrap className="security-access-notice"><Button type="primary" icon={<LoginOutlined />} loading={busy} disabled={!allowed || locked || accessBusy || !username.trim() || !password} onClick={() => void login()}>登录纵密</Button>{busy && <Button loading={cancelling} onClick={() => void cancelLogin()}>取消登录</Button>}</Space>
        </>}
        {error && <Alert className="security-access-notice" type="error" showIcon title={error} />}
        {notice && <Alert className="security-access-notice" type="info" showIcon title={notice} />}
        {result && !session && !mustChangePassword && <Alert className="security-access-notice" type={result.state === 'failed' ? 'error' : 'warning'} showIcon title={result.state === 'unverified_response' ? '装置应答尚未验证，未建立登录会话' : '纵密尚未登录'} description={<>{result.message}{result.lock_seconds !== null && <p>装置返回锁定时间：{result.lock_seconds} 秒</p>}</>} />}
      </Card>
      <Card title="登录进度" className="security-login-progress"><div aria-live="polite">{LOGIN_STAGES.map(stage => {
        const step = result?.steps.find(item => item.id === stage.id);
        return <div className="security-access-step" key={stage.id}><Badge status={step?.state === 'success' ? 'success' : step?.state === 'failed' ? 'error' : step?.state === 'unsupported' ? 'warning' : 'default'} /><div><strong>{stage.name}</strong><p>{step?.message || (busy ? '等待装置返回本次检查结果' : '尚未执行')}</p></div><span>{step?.state === 'success' ? '通过' : step?.state === 'failed' ? '失败' : step?.state === 'unsupported' ? '不支持' : '待确认'}</span></div>;
      })}</div><p className="security-access-boundary">使用纵密装置账号与连接证书。网络检查与身份认证分别显示；ICMP 无响应不阻止尝试登录。</p></Card>
    </div>
  </section>;
}
