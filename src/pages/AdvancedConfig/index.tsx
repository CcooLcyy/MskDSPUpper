import React, { useState } from 'react';
import {
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  CloudDownloadOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  LogoutOutlined,
  SafetyCertificateOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  authorizeAdvancedConfigSession,
  isAdvancedConfigAuthorized,
  isAdvancedConfigPasswordValid,
  revokeAdvancedConfigSession,
} from '../../utils/advanced-config-auth';
import { validateManagerAddress } from '../../utils/network';
import './index.css';

const { Text } = Typography;

type AdvancedConfigAuthFormValues = {
  password: string;
};

type UpdateChannel = 'stable' | 'beta' | 'nightly' | 'ci';
type LowerUpdateStatus = '未检查' | '发现更新' | '已下载到上位机' | '模拟安装完成';

type LowerUpdateMockManifest = {
  version: string;
  packageName: string;
  packageSize: string;
  publishedAt: string;
  sha256: string;
};

const SSH_ACCOUNT_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*)@([^@:]+):(\d+)$/;
const LINUX_ABSOLUTE_PATH_PATTERN = /^\/[^\s]*$/;

const UPDATE_CHANNEL_OPTIONS: Array<{ label: string; value: UpdateChannel }> = [
  { label: 'Stable', value: 'stable' },
  { label: 'Beta', value: 'beta' },
  { label: 'Nightly', value: 'nightly' },
  { label: 'CI', value: 'ci' },
];

const LOWER_UPDATE_MOCK_MANIFESTS: Record<UpdateChannel, LowerUpdateMockManifest> = {
  stable: {
    version: '0.2.4',
    packageName: 'mskdsp-v0.2.4-linux-arm64',
    packageSize: '438 MB',
    publishedAt: '2026-07-05 10:20:00',
    sha256: '0d5a6bb7b18f4aa672217e5c52e6cfe4332079da6c4c1da2b2a3bc0df86a12c4',
  },
  beta: {
    version: '0.2.5-beta.20260705',
    packageName: 'mskdsp-0.2.5-beta.20260705-linux-arm64',
    packageSize: '441 MB',
    publishedAt: '2026-07-05 13:40:00',
    sha256: '6a2d916b9f0d4e66be681bdacaa02e4cbeb2ee408c88001cdcb94987219ec8f1',
  },
  nightly: {
    version: '0.2.5-nightly.20260705',
    packageName: 'mskdsp-0.2.5-nightly.20260705-linux-arm64',
    packageSize: '442 MB',
    publishedAt: '2026-07-05 02:15:00',
    sha256: 'd3b4032d8c4c4f2f9a6f7424b6f1565d709c222ef052cc79d0cc1bd13f4a0cb5',
  },
  ci: {
    version: '0.2.5-master-ci-20260705-a1b2c3d',
    packageName: 'mskdsp-0.2.5-master-ci-20260705-a1b2c3d-linux-arm64',
    packageSize: '443 MB',
    publishedAt: '2026-07-05 15:05:00',
    sha256: 'f3b8d8ef1b8b45d8b80bff16b3c7d778ac3ed51e6eeb4e1dfc7e6dc9249a5160',
  },
};

const LOWER_UPDATE_MOCK_TARGET = {
  managerAddr: '192.168.1.219:17000',
  uploadAccount: 'root@192.168.1.219:22',
  installDir: '/root',
};

function getDeliveryStatusColor(status: LowerUpdateStatus): string {
  switch (status) {
    case '发现更新':
      return 'gold';
    case '已下载到上位机':
      return 'blue';
    case '模拟安装完成':
      return 'success';
    default:
      return 'default';
  }
}

function validateUploadAccount(value: string): { ok: true } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: '请输入上传账号' };
  }

  const match = trimmed.match(SSH_ACCOUNT_PATTERN);
  if (!match) {
    return { ok: false, error: '上传账号格式应为 user@host:port' };
  }

  const host = match[2];
  const portText = match[3];
  const hostValidation = validateManagerAddress(`${host}:${portText}`);
  if (!hostValidation.ok) {
    return { ok: false, error: hostValidation.error };
  }

  return { ok: true };
}

function validateInstallDir(value: string): { ok: true } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: '请输入安装目录' };
  }

  if (!LINUX_ABSOLUTE_PATH_PATTERN.test(trimmed)) {
    return { ok: false, error: '安装目录必须是 Linux 绝对路径' };
  }

  if (trimmed.includes('..')) {
    return { ok: false, error: '安装目录不能包含 ..' };
  }

  return { ok: true };
}

const AdvancedConfigPage: React.FC = () => {
  const [authorized, setAuthorized] = useState(isAdvancedConfigAuthorized);
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [currentLowerVersion, setCurrentLowerVersion] = useState('0.2.3');
  const [latestLowerVersion, setLatestLowerVersion] = useState('-');
  const [packageName, setPackageName] = useState('-');
  const [packageSize, setPackageSize] = useState('-');
  const [publishedAt, setPublishedAt] = useState('-');
  const [sha256, setSha256] = useState('-');
  const [deliveryStatus, setDeliveryStatus] = useState<LowerUpdateStatus>('未检查');
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false);
  const [downloadModalProgress, setDownloadModalProgress] = useState(0);
  const [isInstallModalOpen, setIsInstallModalOpen] = useState(false);
  const [installModalProgress, setInstallModalProgress] = useState(0);
  const [targetManagerAddr, setTargetManagerAddr] = useState(LOWER_UPDATE_MOCK_TARGET.managerAddr);
  const [targetUploadAccount, setTargetUploadAccount] = useState(LOWER_UPDATE_MOCK_TARGET.uploadAccount);
  const [targetInstallDir, setTargetInstallDir] = useState(LOWER_UPDATE_MOCK_TARGET.installDir);
  const [form] = Form.useForm<AdvancedConfigAuthFormValues>();
  const targetManagerAddrValidation = validateManagerAddress(targetManagerAddr);
  const targetUploadAccountValidation = validateUploadAccount(targetUploadAccount);
  const targetInstallDirValidation = validateInstallDir(targetInstallDir);
  const hasTargetValidationError =
    !targetManagerAddrValidation.ok || !targetUploadAccountValidation.ok || !targetInstallDirValidation.ok;

  const handleSubmit = ({ password }: AdvancedConfigAuthFormValues): void => {
    if (!isAdvancedConfigPasswordValid(password)) {
      form.setFields([{ name: 'password', errors: ['密码不正确'] }]);
      return;
    }

    authorizeAdvancedConfigSession();
    setAuthorized(true);
    form.resetFields();
  };

  const resetMockState = (): void => {
    setCurrentLowerVersion('0.2.3');
    setLatestLowerVersion('-');
    setPackageName('-');
    setPackageSize('-');
    setPublishedAt('-');
    setSha256('-');
    setDeliveryStatus('未检查');
    setDownloadModalProgress(0);
    setIsDownloadModalOpen(false);
    setInstallModalProgress(0);
    setIsInstallModalOpen(false);
  };

  const getActiveMockManifest = (): LowerUpdateMockManifest => LOWER_UPDATE_MOCK_MANIFESTS[channel];

  const applyMockManifest = (manifest: LowerUpdateMockManifest): void => {
    setLatestLowerVersion(manifest.version);
    setPackageName(manifest.packageName);
    setPackageSize(manifest.packageSize);
    setPublishedAt(manifest.publishedAt);
    setSha256(manifest.sha256);
  };

  const handleMockCheckUpdate = (): void => {
    const manifest = getActiveMockManifest();

    applyMockManifest(manifest);
    setDeliveryStatus('发现更新');
  };

  const handleMockDownload = (): void => {
    const manifest = getActiveMockManifest();

    applyMockManifest(manifest);
    setIsDownloadModalOpen(true);
    setDownloadModalProgress(100);
    setDeliveryStatus('已下载到上位机');
  };

  const handleMockDeploy = (): void => {
    const manifest = getActiveMockManifest();

    applyMockManifest(manifest);
    setCurrentLowerVersion(manifest.version);
    setIsInstallModalOpen(true);
    setInstallModalProgress(100);
    setDeliveryStatus('模拟安装完成');
  };

  const handleLogout = (): void => {
    revokeAdvancedConfigSession();
    setAuthorized(false);
    form.resetFields();
  };

  if (authorized) {
    return (
      <div className="advanced-config-page">
        <div className="advanced-config-page-header">
          <Space size={8}>
            <CloudDownloadOutlined />
            <Text strong className="advanced-config-page-title">
              下位机更新下发
            </Text>
            <Tag color="processing">模拟数据</Tag>
            <Tag color="warning">真实接口待接入</Tag>
          </Space>
          <Button size="small" icon={<LogoutOutlined />} onClick={handleLogout}>
            退出
          </Button>
        </div>

        <Card
          size="small"
          bordered
          title="更新参数"
        >
          <div className="advanced-config-parameter-grid">
            <div className="advanced-config-section">
              <div className="advanced-config-section-title">目标下位机</div>
              <Form layout="vertical" size="small">
                <Form.Item
                  label="ModuleManager 地址"
                  validateStatus={targetManagerAddrValidation.ok ? undefined : 'error'}
                  help={targetManagerAddrValidation.ok ? undefined : targetManagerAddrValidation.error}
                >
                  <Input
                    value={targetManagerAddr}
                    onChange={(event) => setTargetManagerAddr(event.target.value)}
                    placeholder="例如 192.168.1.219:17000"
                  />
                </Form.Item>
                <Form.Item
                  label="上传账号"
                  validateStatus={targetUploadAccountValidation.ok ? undefined : 'error'}
                  help={targetUploadAccountValidation.ok ? undefined : targetUploadAccountValidation.error}
                >
                  <Input
                    value={targetUploadAccount}
                    onChange={(event) => setTargetUploadAccount(event.target.value)}
                    placeholder="例如 root@192.168.1.219:22"
                  />
                </Form.Item>
                <Form.Item
                  label="安装目录"
                  validateStatus={targetInstallDirValidation.ok ? undefined : 'error'}
                  help={targetInstallDirValidation.ok ? undefined : targetInstallDirValidation.error}
                >
                  <Input
                    value={targetInstallDir}
                    onChange={(event) => setTargetInstallDir(event.target.value)}
                    placeholder="例如 /root"
                  />
                </Form.Item>
              </Form>
            </div>

            <div className="advanced-config-section">
              <div className="advanced-config-section-title">版本来源</div>
              <Form layout="vertical" size="small">
                <Form.Item label="发布通道">
                  <Select<UpdateChannel>
                    value={channel}
                    options={UPDATE_CHANNEL_OPTIONS}
                    onChange={(value) => {
                      setChannel(value);
                      resetMockState();
                    }}
                  />
                </Form.Item>
              </Form>
              <Text type="secondary">
                上位机从静态源获取更新包，再下发到下位机安装。
              </Text>
              <Space wrap className="advanced-config-action-row">
                <Button
                  icon={<FileSearchOutlined />}
                  onClick={handleMockCheckUpdate}
                  disabled={hasTargetValidationError}
                >
                  检查更新
                </Button>
                <Button
                  icon={<DownloadOutlined />}
                  onClick={handleMockDownload}
                  disabled={hasTargetValidationError || deliveryStatus === '未检查'}
                >
                  下载到上位机
                </Button>
                <Button
                  type="primary"
                  icon={<UploadOutlined />}
                  onClick={handleMockDeploy}
                  disabled={hasTargetValidationError || deliveryStatus !== '已下载到上位机'}
                >
                  下发并安装
                </Button>
              </Space>
            </div>
          </div>
        </Card>

        <Card
          size="small"
          bordered
          title={
            <Space size={8}>
              <SafetyCertificateOutlined />
              <span>版本与校验</span>
            </Space>
          }
        >
          <Descriptions size="small" column={2}>
            <Descriptions.Item label="当前下位机版本">{currentLowerVersion}</Descriptions.Item>
            <Descriptions.Item label="可用版本">{latestLowerVersion}</Descriptions.Item>
            <Descriptions.Item label="安装包名称">{packageName}</Descriptions.Item>
            <Descriptions.Item label="包大小">{packageSize}</Descriptions.Item>
            <Descriptions.Item label="发布时间">{publishedAt}</Descriptions.Item>
            <Descriptions.Item label="下发状态">
              <Tag color={getDeliveryStatusColor(deliveryStatus)}>{deliveryStatus}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="SHA256" span={2}>
              <Text code>{sha256}</Text>
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <Modal
          open={isDownloadModalOpen}
          title="下载到上位机"
          okText="完成"
          cancelButtonProps={{ style: { display: 'none' } }}
          onOk={() => setIsDownloadModalOpen(false)}
          onCancel={() => setIsDownloadModalOpen(false)}
        >
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="安装包">{packageName}</Descriptions.Item>
              <Descriptions.Item label="包大小">{packageSize}</Descriptions.Item>
              <Descriptions.Item label="校验文件">SHA256SUMS</Descriptions.Item>
              <Descriptions.Item label="校验状态">
                <Tag color="success">模拟校验通过</Tag>
              </Descriptions.Item>
            </Descriptions>
            <Progress percent={downloadModalProgress} status="success" />
            <Text type="secondary">模拟下载已完成，真实接口接入后这里会显示实际下载进度。</Text>
          </Space>
        </Modal>

        <Modal
          open={isInstallModalOpen}
          title="下发并安装"
          okText="完成"
          cancelButtonProps={{ style: { display: 'none' } }}
          onOk={() => setIsInstallModalOpen(false)}
          onCancel={() => setIsInstallModalOpen(false)}
        >
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="目标下位机">{targetUploadAccount}</Descriptions.Item>
              <Descriptions.Item label="安装目录">{targetInstallDir}</Descriptions.Item>
              <Descriptions.Item label="安装包">{packageName}</Descriptions.Item>
              <Descriptions.Item label="执行命令">
                <Text code>{`cd ${targetInstallDir} && chmod +x ./${packageName} && ./${packageName} start`}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="安装状态">
                <Tag color="success">模拟安装完成</Tag>
              </Descriptions.Item>
            </Descriptions>
            <Progress percent={installModalProgress} status="success" />
            <Text type="secondary">模拟下发与安装已完成，真实接口接入后这里会显示上传、执行和恢复验证进度。</Text>
          </Space>
        </Modal>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ width: 360, maxWidth: '100%' }}>
        <Text strong style={{ display: 'block', color: '#fff', fontSize: 16, marginBottom: 16 }}>
          高级配置验证
        </Text>
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoFocus autoComplete="current-password" placeholder="请输入密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            进入
          </Button>
        </Form>
      </div>
    </div>
  );
};

export default AdvancedConfigPage;
