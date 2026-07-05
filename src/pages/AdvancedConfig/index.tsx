import React, { useState } from 'react';
import {
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Progress,
  Segmented,
  Select,
  Space,
  Steps,
  Table,
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
import type { ColumnsType } from 'antd/es/table';
import {
  authorizeAdvancedConfigSession,
  isAdvancedConfigAuthorized,
  isAdvancedConfigPasswordValid,
  revokeAdvancedConfigSession,
} from '../../utils/advanced-config-auth';
import './index.css';

const { Text } = Typography;

type AdvancedConfigAuthFormValues = {
  password: string;
};

type UpdateMode = 'static-source' | 'offline-package';
type UpdateChannel = 'stable' | 'beta' | 'nightly' | 'ci';
type LowerUpdateStatus = '未检查' | '发现更新' | '已下载到上位机' | '模拟安装完成';
type LowerUpdateAssetStatus = '待获取' | '已发现' | '已校验' | '已下发';

type LowerUpdateAsset = {
  key: string;
  name: string;
  source: string;
  status: LowerUpdateAssetStatus;
};

type LowerUpdateMockManifest = {
  version: string;
  packageName: string;
  packageSize: string;
  publishedAt: string;
  sha256: string;
};

const LOWER_UPDATE_BASE_URL = 'https://update.clsclear.top/mskdsp-lower';

const UPDATE_MODE_OPTIONS: Array<{ label: string; value: UpdateMode }> = [
  { label: '静态源获取', value: 'static-source' },
  { label: '离线包导入', value: 'offline-package' },
];

const UPDATE_CHANNEL_OPTIONS: Array<{ label: string; value: UpdateChannel }> = [
  { label: 'Stable', value: 'stable' },
  { label: 'Beta', value: 'beta' },
  { label: 'Nightly', value: 'nightly' },
  { label: 'CI', value: 'ci' },
];

const LOWER_UPDATE_STEP_TITLES = [
  '读取清单',
  '下载校验',
  '上传下位机',
  '执行安装',
  '验证恢复',
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

const LOWER_UPDATE_OFFLINE_MANIFEST: LowerUpdateMockManifest = {
  version: '0.2.4-offline',
  packageName: 'mskdsp-0.2.4-offline-linux-arm64',
  packageSize: '438 MB',
  publishedAt: '2026-07-05 09:30:00',
  sha256: 'b2b5b0ed0b70468d8611b46365186b2fe7ccf1a6b0bdcd746fbbf2de740aa515',
};

const LOWER_UPDATE_MOCK_TARGET = {
  managerAddr: '192.168.1.219:17000',
  uploadAccount: 'root@192.168.1.219:22',
  installDir: '/root',
};

const EMPTY_ASSETS: LowerUpdateAsset[] = [
  {
    key: 'package',
    name: 'mskdsp-<version>-linux-arm64',
    source: 'linux-arm64 安装包',
    status: '待获取',
  },
  {
    key: 'checksum',
    name: 'SHA256SUMS',
    source: '校验文件',
    status: '待获取',
  },
  {
    key: 'manifest',
    name: 'latest.json',
    source: '版本清单',
    status: '待获取',
  },
];

function buildLowerUpdateAssets(manifest: LowerUpdateMockManifest, status: LowerUpdateAssetStatus): LowerUpdateAsset[] {
  return [
    {
      key: 'package',
      name: manifest.packageName,
      source: `${manifest.packageSize} 安装包`,
      status,
    },
    {
      key: 'checksum',
      name: 'SHA256SUMS',
      source: '校验文件',
      status,
    },
    {
      key: 'manifest',
      name: 'latest.json',
      source: '版本清单',
      status,
    },
  ];
}

const ASSET_COLUMNS: ColumnsType<LowerUpdateAsset> = [
  {
    title: '资产',
    dataIndex: 'name',
    key: 'name',
    width: 260,
    render: (value: string) => <Text code>{value}</Text>,
  },
  {
    title: '类型',
    dataIndex: 'source',
    key: 'source',
    width: 160,
  },
  {
    title: '状态',
    dataIndex: 'status',
    key: 'status',
    width: 120,
    render: (value: LowerUpdateAssetStatus) => <Tag color={getAssetStatusColor(value)}>{value}</Tag>,
  },
];

function buildLowerUpdateManifestUrl(channel: UpdateChannel): string {
  return `${LOWER_UPDATE_BASE_URL}/${channel}/latest.json`;
}

function getAssetStatusColor(status: LowerUpdateAssetStatus): string {
  switch (status) {
    case '已发现':
      return 'blue';
    case '已校验':
      return 'green';
    case '已下发':
      return 'success';
    default:
      return 'default';
  }
}

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

const AdvancedConfigPage: React.FC = () => {
  const [authorized, setAuthorized] = useState(isAdvancedConfigAuthorized);
  const [updateMode, setUpdateMode] = useState<UpdateMode>('static-source');
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [currentLowerVersion, setCurrentLowerVersion] = useState('0.2.3');
  const [latestLowerVersion, setLatestLowerVersion] = useState('-');
  const [packageName, setPackageName] = useState('-');
  const [packageSize, setPackageSize] = useState('-');
  const [publishedAt, setPublishedAt] = useState('-');
  const [sha256, setSha256] = useState('-');
  const [deliveryStatus, setDeliveryStatus] = useState<LowerUpdateStatus>('未检查');
  const [deliveryProgress, setDeliveryProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState(0);
  const [assets, setAssets] = useState<LowerUpdateAsset[]>(EMPTY_ASSETS);
  const [form] = Form.useForm<AdvancedConfigAuthFormValues>();
  const manifestUrl = buildLowerUpdateManifestUrl(channel);
  const stepItems = LOWER_UPDATE_STEP_TITLES.map((title, index) => {
    let description = '等待';

    if (deliveryStatus === '模拟安装完成') {
      description = '已完成';
    } else if (index < currentStep) {
      description = '已完成';
    } else if (index === currentStep) {
      description = deliveryStatus === '未检查' ? '等待操作' : '进行中';
    }

    return { title, description };
  });

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
    setDeliveryProgress(0);
    setCurrentStep(0);
    setAssets(EMPTY_ASSETS);
  };

  const getActiveMockManifest = (): LowerUpdateMockManifest =>
    updateMode === 'static-source' ? LOWER_UPDATE_MOCK_MANIFESTS[channel] : LOWER_UPDATE_OFFLINE_MANIFEST;

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
    setDeliveryProgress(20);
    setCurrentStep(1);
    setAssets(buildLowerUpdateAssets(manifest, '已发现'));
  };

  const handleMockDownload = (): void => {
    const manifest = getActiveMockManifest();

    applyMockManifest(manifest);
    setDeliveryStatus('已下载到上位机');
    setDeliveryProgress(55);
    setCurrentStep(2);
    setAssets(buildLowerUpdateAssets(manifest, '已校验'));
  };

  const handleMockDeploy = (): void => {
    const manifest = getActiveMockManifest();

    applyMockManifest(manifest);
    setCurrentLowerVersion(manifest.version);
    setDeliveryStatus('模拟安装完成');
    setDeliveryProgress(100);
    setCurrentStep(4);
    setAssets(buildLowerUpdateAssets(manifest, '已下发'));
  };

  const handleLogout = (): void => {
    revokeAdvancedConfigSession();
    setAuthorized(false);
    form.resetFields();
  };

  if (authorized) {
    return (
      <div className="advanced-config-page">
        <Card
          size="small"
          bordered
          title={
            <Space size={8}>
              <CloudDownloadOutlined />
              <span>下位机更新下发</span>
              <Tag color="processing">模拟数据</Tag>
            </Space>
          }
          extra={
            <Space size={8}>
              <Tag color="warning">真实接口待接入</Tag>
              <Button size="small" icon={<LogoutOutlined />} onClick={handleLogout}>
                退出
              </Button>
            </Space>
          }
        >
          <div className="advanced-config-update-toolbar">
            <Segmented
              options={UPDATE_MODE_OPTIONS}
              value={updateMode}
              onChange={(value) => {
                setUpdateMode(value as UpdateMode);
                resetMockState();
              }}
            />
            <Space wrap>
              <Button icon={<FileSearchOutlined />} onClick={handleMockCheckUpdate}>
                检查更新
              </Button>
              <Button
                icon={<DownloadOutlined />}
                onClick={handleMockDownload}
                disabled={deliveryStatus === '未检查'}
              >
                下载到上位机
              </Button>
              <Button
                type="primary"
                icon={<UploadOutlined />}
                onClick={handleMockDeploy}
                disabled={deliveryStatus !== '已下载到上位机'}
              >
                下发并安装
              </Button>
            </Space>
          </div>

          <div className="advanced-config-update-grid">
            <div className="advanced-config-section">
              <div className="advanced-config-section-title">更新来源</div>
              <Form layout="vertical" size="small">
                <Form.Item label="获取方式">
                  <Input value={updateMode === 'static-source' ? '上位机访问静态源' : '本地离线包'} disabled />
                </Form.Item>
                <Form.Item label="发布通道">
                  <Select<UpdateChannel>
                    value={channel}
                    options={UPDATE_CHANNEL_OPTIONS}
                    onChange={(value) => {
                      setChannel(value);
                      resetMockState();
                    }}
                    disabled={updateMode !== 'static-source'}
                  />
                </Form.Item>
                <Form.Item label="清单地址">
                  <Input
                    value={updateMode === 'static-source' ? manifestUrl : '选择离线包后读取'}
                    disabled
                  />
                </Form.Item>
              </Form>
            </div>

            <div className="advanced-config-section">
              <div className="advanced-config-section-title">目标下位机</div>
              <Form layout="vertical" size="small">
                <Form.Item label="ModuleManager 地址">
                  <Input value={LOWER_UPDATE_MOCK_TARGET.managerAddr} disabled />
                </Form.Item>
                <Form.Item label="上传账号">
                  <Input value={LOWER_UPDATE_MOCK_TARGET.uploadAccount} disabled />
                </Form.Item>
                <Form.Item label="安装目录">
                  <Input value={LOWER_UPDATE_MOCK_TARGET.installDir} disabled />
                </Form.Item>
              </Form>
            </div>
          </div>
        </Card>

        <div className="advanced-config-status-grid">
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
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="当前下位机版本">{currentLowerVersion}</Descriptions.Item>
              <Descriptions.Item label="可用版本">{latestLowerVersion}</Descriptions.Item>
              <Descriptions.Item label="安装包名称">{packageName}</Descriptions.Item>
              <Descriptions.Item label="包大小">{packageSize}</Descriptions.Item>
              <Descriptions.Item label="发布时间">{publishedAt}</Descriptions.Item>
              <Descriptions.Item label="SHA256">{sha256}</Descriptions.Item>
              <Descriptions.Item label="下发状态">
                <Tag color={getDeliveryStatusColor(deliveryStatus)}>{deliveryStatus}</Tag>
              </Descriptions.Item>
            </Descriptions>
            <Progress percent={deliveryProgress} size="small" className="advanced-config-progress" />
          </Card>

          <Card size="small" bordered title="下发流程">
            <Steps
              size="small"
              current={currentStep}
              status={deliveryStatus === '模拟安装完成' ? 'finish' : 'process'}
              items={stepItems}
            />
          </Card>
        </div>

        <Card size="small" bordered title="待下发资产">
          <Table
            rowKey="key"
            columns={ASSET_COLUMNS}
            dataSource={assets}
            pagination={false}
            size="small"
          />
        </Card>
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
