import { useEffect } from 'react';
import { Alert, Button, Checkbox, Collapse, Form, Input, Space, Spin, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { SOFTWARE_PLATFORM_ENDPOINT } from '../utils/software-platform';
import { isPlatformDesktop } from './platform-auth-api.ts';
import { usePlatformAuth } from './platform-auth-context.ts';

interface LoginFields { username: string; password: string; auto_login: boolean }

export function PlatformLogin() {
  const { controller, snapshot } = usePlatformAuth();
  const [form] = Form.useForm<LoginFields>();
  const [connectionForm] = Form.useForm<{ grpc_endpoint: string }>();
  const desktop = isPlatformDesktop();
  const busy = ['booting', 'authenticating', 'initializing'].includes(snapshot.phase) || snapshot.endingSession;

  useEffect(() => {
    form.setFieldsValue({ username: snapshot.owner || snapshot.settings?.username || '', auto_login: snapshot.settings?.auto_login ?? false, password: '' });
    connectionForm.setFieldsValue({ grpc_endpoint: snapshot.settings?.grpc_endpoint || SOFTWARE_PLATFORM_ENDPOINT });
  }, [snapshot.settings, snapshot.owner, form, connectionForm]);
  useEffect(() => {
    if (snapshot.phase !== 'signed_out' && snapshot.phase !== 'locked') form.setFieldValue('password', '');
  }, [snapshot.phase, form]);
  useEffect(() => () => { form.setFieldValue('password', ''); }, [form]);

  return (
    <main className="platform-login-screen" onKeyDown={event => event.stopPropagation()}>
      <section className="platform-login-panel" aria-label="平台账号登录">
        <aside className="platform-login-brand">
          <div className="platform-login-mark" aria-hidden="true">M</div>
          <Typography.Title level={2} className="platform-login-brand-title">MskDSP</Typography.Title>
          <Typography.Paragraph className="platform-login-brand-description">设备配置与调试</Typography.Paragraph>
          {!desktop ? <Alert type="info" showIcon title="请使用桌面版上位机" description="浏览器预览无法登录或进入配置工作台。" className="platform-login-browser-notice" /> : null}
          <Typography.Paragraph className="platform-login-brand-note">账号由平台管理员在 Web 中创建。</Typography.Paragraph>
        </aside>
        <div className="platform-login-form-panel">
        <Typography.Title level={3} className="platform-login-form-title">登录平台</Typography.Title>
        <Typography.Paragraph type="secondary" className="platform-login-form-description">登录后进入配置工作台</Typography.Paragraph>
        {snapshot.workspaceReady ? <Alert type="info" showIcon title="工作台已锁定" description={`页面草稿保留在本次程序内存中，请使用 ${snapshot.owner} 重新登录后继续。关闭程序可能丢失未保存草稿；切换账号需重启程序。`} style={{ marginBottom: 18 }} /> : null}
        {desktop && snapshot.error ? <Alert type="error" showIcon title={snapshot.error} style={{ marginBottom: 18 }} /> : null}
        {snapshot.phase === 'initialization_failed' ? (
          <Space wrap>
            <Button type="primary" onClick={() => { void controller.retryInitialization(); }}>重试加载配置</Button>
            <Button onClick={() => { void controller.logout(); }}>退出登录</Button>
          </Space>
        ) : (
          <Form form={form} layout="vertical" disabled={busy || snapshot.savingSettings || !desktop} initialValues={{ auto_login: false }} onFinish={(values: LoginFields) => {
            const request = controller.login(values.username, values.password, values.auto_login);
            form.setFieldValue('password', '');
            void request;
          }}>
            <Form.Item name="username" label="账号" rules={[{ required: true, whitespace: true, message: '请输入平台账号' }]}>
              <Input prefix={<UserOutlined />} autoComplete="username" placeholder="平台账号" size="large" readOnly={!!snapshot.owner} autoFocus={!snapshot.owner} />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} autoComplete="current-password" placeholder="请输入密码" size="large" autoFocus={!!snapshot.owner} />
            </Form.Item>
            <Form.Item name="auto_login" valuePropName="checked" style={{ marginBottom: 20 }}>
              <Checkbox>下次自动登录</Checkbox>
            </Form.Item>
            <Button type="primary" htmlType="submit" block size="large" loading={busy}>
              {snapshot.endingSession ? '正在退出登录' : snapshot.phase === 'booting' ? '正在读取登录设置' : snapshot.phase === 'initializing' ? '正在加载工作台' : snapshot.phase === 'authenticating' ? '正在验证账号' : '登录'}
            </Button>
          </Form>
        )}
        <Collapse ghost size="small" className="platform-login-connection" items={[{
          key: 'connection', label: '平台连接设置', forceRender: true, children: (
            <Form form={connectionForm} layout="vertical" initialValues={{ grpc_endpoint: SOFTWARE_PLATFORM_ENDPOINT }} disabled={busy || snapshot.savingSettings || !desktop} onFinish={(values: { grpc_endpoint: string }) => {
              void controller.saveSettings({ grpc_endpoint: values.grpc_endpoint.trim(), username: form.getFieldValue('username')?.trim().toLowerCase() || '', auto_login: form.getFieldValue('auto_login') ?? false });
            }}>
              <Form.Item name="grpc_endpoint" label="平台 gRPC 地址" rules={[{ required: true, whitespace: true, message: '请输入平台 gRPC 地址' }, { pattern: /^https?:\/\/\S+$/, message: '使用 http:// 或 https:// 开头的 gRPC 地址' }]}>
                <Input placeholder="https://platform.example:50000" readOnly={snapshot.workspaceReady} />
              </Form.Item>
              <Button htmlType="submit" loading={snapshot.savingSettings}>保存连接设置</Button>
              <Typography.Paragraph type="secondary" style={{ margin: '12px 0 0', fontSize: 12 }}>HTTP/HTTPS 表示 gRPC 的传输地址，请填写平台的 gRPC 服务端口。</Typography.Paragraph>
              {snapshot.workspaceReady ? <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>工作台草稿保留期间不可更换平台。更换前请先重启程序。</Typography.Paragraph> : null}
            </Form>
          ),
        }]} />
        <Typography.Paragraph type="secondary" className="platform-login-credential-note">自动登录凭据由桌面系统安全保存。</Typography.Paragraph>
        {snapshot.phase === 'initializing' ? <Spin className="platform-login-initializing" /> : null}
        </div>
      </section>
    </main>
  );
}
