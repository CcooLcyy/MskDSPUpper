import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Form, Input, Modal, Segmented, Space, Switch, Typography } from 'antd';
import { NodeIndexOutlined } from '@ant-design/icons';
import { api } from '../../adapters';
import type { LowerUpdateSshAuth, VerticalSecurityAccessPathResult } from '../../adapters';

const DEFAULT_UPLOAD_ACCOUNT = 'megsky@192.168.1.219:10022';
const DEFAULT_SSH_PASSWORD = 'Meg@admin123';
const REQUIRED_PHASES = ['preflight', 'addresses', 'routes', 'forwarding', 'verification', 'persistence'] as const;
const STEP_PRESENTATION: Record<VerticalSecurityAccessPathResult['steps'][number]['state'], {
  label: string;
  status: 'success' | 'error' | 'warning' | 'default';
}> = {
  success: { label: '通过', status: 'success' },
  failed: { label: '失败', status: 'error' },
  pending: { label: '未执行', status: 'default' },
  unknown: { label: '未确认', status: 'warning' },
  unsupported: { label: '不支持', status: 'warning' },
};

function isVerifiedApplied(result: VerticalSecurityAccessPathResult | null): boolean {
  return result?.target_ip === '11.22.33.44' && result.applied === true && result.exit_code === 0
    && result.steps.length === REQUIRED_PHASES.length
    && REQUIRED_PHASES.every(id => result.steps.filter(step => step.id === id && step.state === 'success').length === 1);
}

export default function AccessPathConfig({ disabled, onBusyChange, onApplied }: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [uploadAccount, setUploadAccount] = useState(DEFAULT_UPLOAD_ACCOUNT);
  const [authMethod, setAuthMethod] = useState<LowerUpdateSshAuth['method']>('password');
  const [sshPassword, setSshPassword] = useState(DEFAULT_SSH_PASSWORD);
  const [reuseSshPasswordForSudo, setReuseSshPasswordForSudo] = useState(true);
  const [sudoPassword, setSudoPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerticalSecurityAccessPathResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const runningRef = useRef(false);
  const secretInputs = useRef<Array<HTMLInputElement | null>>([]);
  const verifiedApplied = isVerifiedApplied(result);

  useEffect(() => {
    mountedRef.current = true;
    const inputs = secretInputs.current;
    return () => {
      mountedRef.current = false;
      for (const input of inputs) if (input) input.value = '';
    };
  }, []);

  const clearSecrets = () => { setSshPassword(''); setSudoPassword(''); };
  const close = () => {
    if (runningRef.current) return;
    clearSecrets(); setOpen(false);
  };
  const apply = async () => {
    if (runningRef.current || disabled) return;
    const account = uploadAccount.trim();
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)@([^@:\s]+):(\d+)$/.exec(account);
    if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) {
      setError('请填写 user@设备地址:SSH端口 格式的上传账号。'); return;
    }
    if ((authMethod === 'password' && !sshPassword) || ((authMethod === 'certificate' || !reuseSshPasswordForSudo) && !sudoPassword)) {
      setError('请输入本次 SSH 认证和 sudo 所需的密码。'); return;
    }
    const request = {
      upload_account: account,
      auth: authMethod === 'password' ? { method: 'password' as const, password: sshPassword } : { method: 'certificate' as const },
      sudo_password: authMethod === 'password' && reuseSshPasswordForSudo ? sshPassword : sudoPassword,
    };
    runningRef.current = true;
    setBusy(true); onBusyChange(true); clearSecrets(); setResult(null); setError(null);
    try {
      const value = await api.configureVerticalSecurityAccessPath(request);
      if (!mountedRef.current) return;
      if (value.target_ip !== '11.22.33.44') { setError('返回结果的目标地址不匹配，请检查设备实际网络状态。'); return; }
      setResult(value);
      if (isVerifiedApplied(value)) onApplied();
      else if (value.applied) setError('配置结果的完成标记与执行状态不一致，不能确认已应用，请检查设备实际网络状态。');
    } catch {
      if (mountedRef.current) setError('无法确认访问通路配置结果。设备可能已经应用部分变更，请检查实际网络状态后再决定是否重试。');
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setBusy(false);
      onBusyChange(false);
    }
  };

  return <>
    <Button icon={<NodeIndexOutlined />} disabled={disabled || busy} onClick={() => { clearSecrets(); if (uploadAccount.trim() === DEFAULT_UPLOAD_ACCOUNT && authMethod === 'password') setSshPassword(DEFAULT_SSH_PASSWORD); setResult(null); setError(null); setOpen(true); }}>配置纵密访问通路</Button>
    <Modal title="配置纵密访问通路" open={open} width={680} centered onCancel={close} closable={!busy} mask={{ closable: !busy }} keyboard={!busy} destroyOnHidden styles={{ body: { maxHeight: 'calc(100vh - 180px)', overflowY: 'auto', paddingRight: 4 } }}
      footer={<Space>{!busy && <Button onClick={close}>关闭</Button>}<Button type="primary" loading={busy} disabled={busy || disabled} onClick={() => void apply()}>应用访问通路</Button></Space>}
    >
      <Alert type="info" showIcon title="仅配置 101 → 108 的纵密维护访问" description="本操作独立于纵密业务网络配置，不需要填写本端／对端 RTU、网关或纵密业务地址。" />
      <div className="security-path-preview"><strong>固定访问路径</strong><p>电脑（11.22.33.0/24） → DSP 101 口（11.22.33.1/32） → DSP 108 口（11.22.33.2/32） → 纵密 11.22.33.44</p><p>配置维护地址、目标及回程路由，仅为 11.22.33.44 代理 ARP，关闭 101 口原有的自动代理。启用全局 IPv4 转发，并添加限定此路径的转发和 SNAT。回包经 DSP 返回电脑，不限定纵密访问端口。</p><p>安装独立的 systemd 服务，设备开机后自动恢复此维护通路；不依赖 PPP 或纵密业务服务，不配置 107、业务 DNAT 或默认路由。配置完成不代表目标已可达，需要另行检查。</p></div>
      <Alert type="warning" showIcon title="应用后独立开机恢复维护通路" description="应用会修改目标 DSP 网络，并安装和启用维护通路开机恢复服务。首次应用及开机恢复启用均确认成功，才显示已应用。启用全局 IPv4 转发可能改变内核默认参数；失败会尽力恢复本次变更，但不能保证恢复全部状态。执行中不能关闭窗口；操作中断不代表配置已撤销。" />
      <Form layout="vertical" className="security-path-form" disabled={busy} autoComplete="off">
        <Form.Item label="DSP SSH 上传账号"><Input aria-label="访问通路 SSH 上传账号" value={uploadAccount} placeholder="user@设备地址:SSH端口" onChange={event => setUploadAccount(event.target.value)} /></Form.Item>
        <Form.Item label="SSH 认证方式"><Segmented aria-label="访问通路 SSH 认证方式" block value={authMethod} options={[{ label: '密码', value: 'password' }, { label: '证书', value: 'certificate' }]} onChange={value => { clearSecrets(); setAuthMethod(value as LowerUpdateSshAuth['method']); }} /></Form.Item>
        {authMethod === 'password' && <Form.Item label="SSH 密码"><Input.Password aria-label="访问通路 SSH 密码" value={sshPassword} autoComplete="off" onChange={event => setSshPassword(event.target.value)} ref={node => { secretInputs.current[0] = node?.input ?? null; }} /></Form.Item>}
        {authMethod === 'certificate' && <Typography.Paragraph type="secondary">使用本机已有的 SSH 密钥认证；这与纵密登录的连接证书不同。</Typography.Paragraph>}
        <Form.Item label="sudo 密码"><Space><Switch aria-label="访问通路 sudo 与 SSH 密码相同" checked={authMethod === 'password' && reuseSshPasswordForSudo} disabled={busy || authMethod === 'certificate'} onChange={value => { setReuseSshPasswordForSudo(value); setSudoPassword(''); }} /><span>与 SSH 密码相同</span></Space></Form.Item>
        {(authMethod === 'certificate' || !reuseSshPasswordForSudo) && <Form.Item label="独立 sudo 密码"><Input.Password aria-label="访问通路独立 sudo 密码" value={sudoPassword} autoComplete="off" onChange={event => setSudoPassword(event.target.value)} ref={node => { secretInputs.current[1] = node?.input ?? null; }} /></Form.Item>}
      </Form>
      {busy && <Alert type="info" showIcon title="正在应用访问通路，请等待设备返回结果" description="页面不会自动登录或运行网络检查。" />}
      {error && <Alert className="security-access-notice" type="error" showIcon title={error} />}
      {result && <section className="security-path-result" aria-label="访问通路配置结果"><Alert type={verifiedApplied ? 'success' : 'error'} showIcon title={verifiedApplied ? '访问通路已应用' : '访问通路配置未完成'} description={<>{result.message}<p>退出码：{result.exit_code ?? '未返回'}</p></>} /><div aria-live="polite">{result.steps.map((step, index) => {
        const presentation = STEP_PRESENTATION[step.state] ?? STEP_PRESENTATION.unknown;
        return <div className="security-access-step" key={`${step.id}-${index}`}><Badge status={presentation.status} /><div><strong>{step.name}</strong><p>{step.message}</p></div><span>{presentation.label}</span></div>;
      })}</div>{verifiedApplied && <p>可关闭窗口后手动检查直连或登录；页面没有自动发起检查与登录。</p>}</section>}
    </Modal>
  </>;
}
