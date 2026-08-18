import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  message,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
} from 'antd';
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  FileTextOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import './index.css';
import { api } from '../../adapters';
import type {
  VerticalSecurityDeployResult,
  VerticalSecurityStatusRequest,
  VerticalSecurityStatusResult,
  VerticalSecurityStepResult,
  VerticalSecurityStepState,
} from '../../adapters';
import {
  buildVerticalSecurityScript,
  deployVerticalSecurityScript,
} from '../../utils/vertical-security-script';

type SecurityAuthMethod = 'password' | 'certificate';

type SecurityConfigValues = {
  device?: string;
  uploadAccount: string;
  installDir: string;
  authMethod: SecurityAuthMethod;
  sshPassword?: string;
  reuseSshPasswordForSudo: boolean;
  sudoPassword?: string;
  localRtuAddress: string;
  localSecurityAddress: string;
  localGatewayAddress: string;
  remoteRtuAddress: string;
  remoteSecurityAddress: string;
  remoteGatewayAddress: string;
};

const ADDRESS_RULES = [{ required: true, whitespace: true, message: '请输入地址' }];
const DEVICE_OPTIONS = [{ value: 'MskDSP', label: 'MskDSP' }];
const DEVICE_CONNECTION_DEFAULTS: Record<string, Partial<SecurityConfigValues>> = {
  MskDSP: {
    uploadAccount: 'megsky@192.168.1.219:10022',
    authMethod: 'password',
    sshPassword: 'Meg@admin123',
    reuseSshPasswordForSudo: true,
  },
};
const SCRIPT_PREVIEW_FIELDS: Array<keyof SecurityConfigValues> = [
  'device',
  'localRtuAddress',
  'localSecurityAddress',
  'localGatewayAddress',
  'remoteRtuAddress',
  'remoteSecurityAddress',
  'remoteGatewayAddress',
];
const STATUS_POLL_INTERVAL_MS = 2000;
const EXECUTION_STEPS = [
  { id: 'precheck', name: '系统预检查' },
  { id: 'fixed_network', name: '101 固定网络' },
  { id: 'local_security', name: '107 本地纵密链路' },
  { id: 'local_rtu', name: '108 本地 RTU 链路' },
  { id: 'ppp0_wait', name: 'PPP 链路' },
  { id: 'remote_security_route', name: '远程纵密路由' },
  { id: 'dnat', name: 'DNAT 规则' },
  { id: 'conntrack', name: '连接跟踪超时' },
  { id: 'save_config', name: '配置保存' },
] as const;

type ExecutionStepState = VerticalSecurityStepState | 'pending';

const STEP_STATE_PRESENTATION: Record<ExecutionStepState, {
  label: string;
  color: string;
  icon: React.ReactNode;
}> = {
  pending: {
    label: '待执行',
    color: 'default',
    icon: <MinusCircleOutlined />,
  },
  running: {
    label: '执行中',
    color: 'processing',
    icon: <LoadingOutlined spin />,
  },
  waiting: {
    label: '等待中',
    color: 'warning',
    icon: <ClockCircleOutlined />,
  },
  success: {
    label: '成功',
    color: 'success',
    icon: <CheckCircleFilled />,
  },
  failed: {
    label: '失败',
    color: 'error',
    icon: <CloseCircleFilled />,
  },
};

function formatStepTimestamp(timestamp: number): string {
  if (!timestamp) {
    return '--';
  }

  const milliseconds = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }
  return date.toLocaleString('zh-CN', { hour12: false });
}

function getExecutionOutcome(status: VerticalSecurityStatusResult | null) {
  const failedStep = status?.steps.find((step) => step.state === 'failed') ?? null;
  const serviceFailed = status !== null && (
    status.active_state === 'failed'
    || status.sub_state === 'failed'
    || (status.exit_code !== null && status.exit_code !== 0)
  );
  const completed = status !== null && EXECUTION_STEPS.every((expectedStep) => (
    status.steps.some((step) => step.step_id === expectedStep.id && step.state === 'success')
  ));

  return {
    completed: completed && !failedStep && !serviceFailed,
    failed: Boolean(failedStep || serviceFailed),
    failedStep,
  };
}

const SecurityConfig: React.FC = () => {
  const [form] = Form.useForm<SecurityConfigValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const selectedDevice = Form.useWatch('device', form);
  const authMethod = Form.useWatch('authMethod', form) ?? 'password';
  const reuseSshPasswordForSudo = Form.useWatch('reuseSshPasswordForSudo', form) ?? true;
  const [isGenerating, setIsGenerating] = useState(false);
  const [deployResult, setDeployResult] = useState<VerticalSecurityDeployResult | null>(null);
  const [executionStatus, setExecutionStatus] = useState<VerticalSecurityStatusResult | null>(null);
  const [statusQueryError, setStatusQueryError] = useState<string | null>(null);
  const [isPollingStatus, setIsPollingStatus] = useState(false);
  const [scriptPreview, setScriptPreview] = useState<string | null>(null);
  const statusPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusPollGenerationRef = useRef(0);

  const executionOutcome = useMemo(
    () => getExecutionOutcome(executionStatus),
    [executionStatus],
  );
  const executionSteps = useMemo(() => {
    const resultsById = new Map(
      executionStatus?.steps.map((step) => [step.step_id, step]) ?? [],
    );
    return EXECUTION_STEPS.map((step) => ({
      ...step,
      result: resultsById.get(step.id),
    }));
  }, [executionStatus]);

  useEffect(() => () => {
    statusPollGenerationRef.current += 1;
    if (statusPollTimerRef.current !== null) {
      clearTimeout(statusPollTimerRef.current);
    }
  }, []);

  const stopStatusPolling = () => {
    statusPollGenerationRef.current += 1;
    if (statusPollTimerRef.current !== null) {
      clearTimeout(statusPollTimerRef.current);
      statusPollTimerRef.current = null;
    }
    setIsPollingStatus(false);
  };

  const startStatusPolling = (request: VerticalSecurityStatusRequest) => {
    stopStatusPolling();
    const generation = statusPollGenerationRef.current;
    setExecutionStatus(null);
    setStatusQueryError(null);
    setIsPollingStatus(true);

    const poll = async () => {
      let keepPolling = true;
      try {
        const status = await api.getVerticalSecurityStatus(request);
        if (statusPollGenerationRef.current !== generation) {
          return;
        }

        setExecutionStatus(status);
        setStatusQueryError(null);
        const outcome = getExecutionOutcome(status);
        if (outcome.completed) {
          keepPolling = false;
          setIsPollingStatus(false);
          messageApi.success('纵密配置全部步骤执行完成');
        } else if (outcome.failed) {
          keepPolling = false;
          setIsPollingStatus(false);
          messageApi.error(outcome.failedStep
            ? `${outcome.failedStep.name}执行失败：${outcome.failedStep.message}`
            : `纵密服务执行失败，退出码：${status.exit_code ?? '未知'}`);
        }
      } catch (error) {
        if (statusPollGenerationRef.current !== generation) {
          return;
        }
        setStatusQueryError(String(error));
      } finally {
        if (keepPolling && statusPollGenerationRef.current === generation) {
          statusPollTimerRef.current = setTimeout(poll, STATUS_POLL_INTERVAL_MS);
        }
      }
    };

    void poll();
  };

  const handlePreview = async () => {
    try {
      const values = await form.validateFields(SCRIPT_PREVIEW_FIELDS);
      setScriptPreview(buildVerticalSecurityScript({
        ...values,
        device: values.device ?? '',
      }));
    } catch {
      // 表单校验错误由 Form.Item 展示。
    }
  };

  const handleDeviceChange = (device?: string) => {
    const defaults = device ? DEVICE_CONNECTION_DEFAULTS[device] : undefined;
    if (defaults) {
      form.setFieldsValue(defaults);
    }
  };

  const handleFinish = async (values: SecurityConfigValues) => {
    setIsGenerating(true);
    stopStatusPolling();
    setDeployResult(null);
    setExecutionStatus(null);
    setStatusQueryError(null);

    try {
      const sshPassword = values.sshPassword ?? '';
      const connection: VerticalSecurityStatusRequest = {
        upload_account: values.uploadAccount,
        auth: values.authMethod === 'certificate'
          ? { method: 'certificate' }
          : { method: 'password', password: sshPassword },
        sudo_password: values.authMethod === 'password' && values.reuseSshPasswordForSudo
          ? sshPassword
          : values.sudoPassword ?? '',
      };
      const result = await deployVerticalSecurityScript({
        ...values,
        device: values.device ?? '',
      }, {
        uploadAccount: values.uploadAccount,
        installDir: values.installDir,
        auth: connection.auth,
        sudoPassword: connection.sudo_password,
      });
      if (!result.success) {
        throw new Error(result.stderr || `远端服务执行失败，退出码：${result.exit_code ?? '未知'}`);
      }
      setDeployResult(result);
      messageApi.success(`纵密服务启动请求已提交: ${result.service_name}`);
      startStatusPolling(connection);
    } catch (error) {
      messageApi.error(`下发纵密配置失败: ${error}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleReset = () => {
    stopStatusPolling();
    form.resetFields();
    setDeployResult(null);
    setExecutionStatus(null);
    setStatusQueryError(null);
    setScriptPreview(null);
    messageApi.info('已重置地址输入');
  };

  return (
    <div className="security-config-page">
      {contextHolder}
      <Card title="纵密配置" size="small" className="security-config-card">
        <Alert
          className="security-config-network-alert"
          type="warning"
          showIcon
          message="执行前请确认电脑网段"
          description="电脑需使用 11.22.33.0/24 网段内的地址访问 11.22.33.44。电脑地址不属于 RTU、网关或纵密配置字段。"
        />
        {deployResult ? (
          <Alert
            className="security-config-deploy-result"
            type={executionOutcome.failed ? 'error' : executionOutcome.completed ? 'success' : 'info'}
            showIcon
            message={executionOutcome.failed
              ? '纵密配置执行失败'
              : executionOutcome.completed
                ? '纵密配置执行完成'
                : `服务已提交启动：${deployResult.service_name}`}
            description={executionOutcome.failedStep
              ? `${executionOutcome.failedStep.name}：${executionOutcome.failedStep.message}`
              : `远端脚本：${deployResult.remote_path}`}
          />
        ) : null}
        {deployResult ? (
          <section
            className="security-config-execution"
            aria-labelledby="security-config-execution-title"
          >
            <div className="security-config-execution-heading">
              <div>
                <h2 id="security-config-execution-title" className="security-config-section-title">
                  执行流程
                </h2>
                <div className="security-config-service-state">
                  systemd：{executionStatus
                    ? `${executionStatus.active_state} / ${executionStatus.sub_state}`
                    : '正在查询'}
                  {executionStatus?.restart_count
                    ? `，已重启 ${executionStatus.restart_count} 次`
                    : ''}
                </div>
              </div>
              {isPollingStatus ? <Tag color="processing" icon={<LoadingOutlined spin />}>持续刷新</Tag> : null}
            </div>
            {statusQueryError ? (
              <Alert
                className="security-config-status-error"
                type="warning"
                showIcon
                message="暂时无法获取执行状态，正在重试"
                description={statusQueryError}
              />
            ) : null}
            <div className="security-config-step-list">
              {executionSteps.map((step, index) => {
                const result: VerticalSecurityStepResult | undefined = step.result;
                const state: ExecutionStepState = result?.state ?? 'pending';
                const presentation = STEP_STATE_PRESENTATION[state];
                return (
                  <div
                    className={`security-config-step security-config-step-${state}`}
                    key={step.id}
                  >
                    <div className="security-config-step-index">{index + 1}</div>
                    <div className="security-config-step-body">
                      <div className="security-config-step-name">{result?.name ?? step.name}</div>
                      <div className="security-config-step-message">
                        {result?.message ?? '等待前一步完成'}
                      </div>
                    </div>
                    <div className="security-config-step-meta">
                      <Tag color={presentation.color} icon={presentation.icon}>
                        {presentation.label}
                      </Tag>
                      <time dateTime={result?.updated_at
                        ? new Date(result.updated_at < 1_000_000_000_000
                          ? result.updated_at * 1000
                          : result.updated_at).toISOString()
                        : undefined}
                      >
                        {formatStepTimestamp(result?.updated_at ?? 0)}
                      </time>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        <Form
          form={form}
          layout="vertical"
          size="small"
          autoComplete="off"
          initialValues={{
            authMethod: 'password',
            reuseSshPasswordForSudo: true,
            installDir: '/home/megsky',
          }}
          onFinish={handleFinish}
        >
          <div className="security-config-device">
            <Form.Item
              name="device"
              label="目标设备"
              rules={[{ required: true, message: '请选择目标设备' }]}
            >
              <Select
                allowClear
                options={DEVICE_OPTIONS}
                placeholder="请选择目标设备"
                onChange={handleDeviceChange}
              />
            </Form.Item>
          </div>
          <section className="security-config-section" aria-labelledby="security-config-connection-title">
            <h2 id="security-config-connection-title" className="security-config-section-title">目标设备连接</h2>
            <div className="security-config-grid">
              <Form.Item
                name="uploadAccount"
                label="SSH 上传账号"
                rules={[{ required: true, whitespace: true, message: '请输入 SSH 上传账号' }]}
              >
                <Input placeholder="例如 user@192.168.1.219:10022" />
              </Form.Item>
              <Form.Item
                name="installDir"
                label="远端临时目录"
                rules={[{ required: true, whitespace: true, message: '请输入远端临时目录' }]}
              >
                <Input placeholder="例如 /home/user" />
              </Form.Item>
              <Form.Item
                name="authMethod"
                label="SSH 认证方式"
                rules={[{ required: true, message: '请选择 SSH 认证方式' }]}
              >
                <Segmented
                  block
                  options={[
                    { label: '密码', value: 'password' },
                    { label: '证书', value: 'certificate' },
                  ]}
                />
              </Form.Item>
              {authMethod === 'password' ? (
                <Form.Item
                  name="sshPassword"
                  label="SSH 密码"
                  rules={[{ required: true, message: '请输入 SSH 密码' }]}
                >
                  <Input.Password autoComplete="current-password" placeholder="请输入 SSH 密码" />
                </Form.Item>
              ) : null}
              <Form.Item label="sudo 密码">
                <Space>
                  <Form.Item name="reuseSshPasswordForSudo" valuePropName="checked" noStyle>
                    <Switch disabled={authMethod === 'certificate'} />
                  </Form.Item>
                  <span>与 SSH 密码相同</span>
                </Space>
              </Form.Item>
              {(authMethod === 'certificate' || !reuseSshPasswordForSudo) ? (
                <Form.Item
                  name="sudoPassword"
                  label="独立 sudo 密码"
                  rules={[{ required: true, message: '请输入 sudo 密码' }]}
                >
                  <Input.Password autoComplete="new-password" placeholder="请输入 sudo 密码" />
                </Form.Item>
              ) : null}
            </div>
          </section>
          <section className="security-config-section" aria-labelledby="security-config-local-title">
            <h2 id="security-config-local-title" className="security-config-section-title">本地侧</h2>
            <div className="security-config-grid">
              <Form.Item name="localRtuAddress" label="本地 RTU 地址" rules={ADDRESS_RULES}>
                <Input placeholder="请输入本地 RTU 地址" />
              </Form.Item>
              <Form.Item name="localSecurityAddress" label="本地纵密地址" rules={ADDRESS_RULES}>
                <Input placeholder="请输入本地纵密地址" />
              </Form.Item>
              <Form.Item name="localGatewayAddress" label="本地网关地址" rules={ADDRESS_RULES}>
                <Input placeholder="请输入本地网关地址" />
              </Form.Item>
            </div>
          </section>
          <section className="security-config-section" aria-labelledby="security-config-remote-title">
            <h2 id="security-config-remote-title" className="security-config-section-title">远程侧</h2>
            <div className="security-config-grid">
              <Form.Item name="remoteRtuAddress" label="远程 RTU 地址" rules={ADDRESS_RULES}>
                <Input placeholder="请输入远程 RTU 地址" />
              </Form.Item>
              <Form.Item name="remoteSecurityAddress" label="远程纵密地址" rules={ADDRESS_RULES}>
                <Input placeholder="请输入远程纵密地址" />
              </Form.Item>
              <Form.Item name="remoteGatewayAddress" label="远程网关地址" rules={ADDRESS_RULES}>
                <Input placeholder="请输入远程网关地址" />
              </Form.Item>
            </div>
          </section>
          <div className="security-config-actions">
            <Space>
              <Button htmlType="button" onClick={handleReset}>
                重置
              </Button>
              <Button
                htmlType="button"
                icon={<FileTextOutlined />}
                onClick={handlePreview}
              >
                查看脚本
              </Button>
                <Button
                  type="primary"
                  htmlType="submit"
                  icon={<PlayCircleOutlined />}
                  loading={isGenerating}
                  disabled={!selectedDevice}
                >
                执行
              </Button>
            </Space>
          </div>
        </Form>
      </Card>
      <Modal
        title="纵密配置脚本预览"
        open={scriptPreview !== null}
        onCancel={() => setScriptPreview(null)}
        footer={null}
        width={860}
        destroyOnClose
      >
        <pre className="security-config-script-preview">{scriptPreview}</pre>
      </Modal>
    </div>
  );
};

export default SecurityConfig;
