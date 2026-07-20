import React, { useState } from 'react';
import {
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  message,
  Modal,
  Progress,
  Segmented,
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
  ReloadOutlined,
  SafetyCertificateOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  authorizeAdvancedConfigSession,
  isAdvancedConfigAuthorized,
  isAdvancedConfigPasswordValid,
  revokeAdvancedConfigSession,
} from '../../utils/advanced-config-auth';
import {
  api,
  type LowerUpdateChannel,
  type LowerUpdateDownloadProgress,
  type LowerUpdateDownloadResult,
  type LowerUpdateInstallResult,
  type LowerUpdateManifest,
  type LowerUpdateSshAuth,
  type LowerUpdateUploadProgress,
  type LowerUpdateUploadResult,
  type ModuleInfo,
} from '../../adapters';
import { validateManagerAddress } from '../../utils/network';
import './index.css';

const { Text } = Typography;

type AdvancedConfigAuthFormValues = {
  password: string;
};

type LowerUpdateAuthMethod = LowerUpdateSshAuth['method'];

type LowerUpdateStatus =
  | '未检查'
  | '检查失败'
  | '发现更新'
  | '下载中'
  | '校验中'
  | '下载失败'
  | '已下载到上位机'
  | '上传中'
  | '上传失败'
  | '已上传到下位机'
  | '安装中'
  | '安装失败'
  | '版本确认中'
  | '版本不一致'
  | '版本确认失败'
  | '升级完成';

type DownloadStage = LowerUpdateDownloadProgress['stage'] | 'idle' | 'failed';
type UploadStage = LowerUpdateUploadProgress['stage'] | 'idle' | 'failed';
type InstallStage = 'idle' | 'running' | 'succeeded' | 'failed';
type VersionVerifyStage = 'idle' | 'waiting' | 'querying' | 'succeeded' | 'mismatch' | 'failed';
type DeployTaskStep =
  | 'idle'
  | 'uploading'
  | 'uploaded'
  | 'upload_failed'
  | 'installing'
  | 'installed'
  | 'install_failed'
  | 'verifying'
  | 'verify_failed'
  | 'version_mismatch'
  | 'succeeded';

const SSH_ACCOUNT_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*)@([^@:]+):(\d+)$/;
const LINUX_ABSOLUTE_PATH_PATTERN = /^\/[^\s]*$/;

const UPDATE_CHANNEL_OPTIONS: Array<{ label: string; value: LowerUpdateChannel }> = [
  { label: 'Stable', value: 'stable' },
  { label: 'Beta', value: 'beta' },
  { label: 'Nightly', value: 'nightly' },
  { label: 'CI', value: 'ci' },
];

const DEFAULT_LOWER_UPDATE_CHANNEL: LowerUpdateChannel = 'ci';
const DEFAULT_LOWER_UPDATE_AUTH_METHOD: LowerUpdateAuthMethod = 'password';
const DEFAULT_LOWER_UPDATE_SSH_PASSWORD = 'Meg@admin123';
const UPDATE_CHANNEL_LABELS: Record<LowerUpdateChannel, string> = UPDATE_CHANNEL_OPTIONS.reduce(
  (labels, option) => ({
    ...labels,
    [option.value]: option.label,
  }),
  {} as Record<LowerUpdateChannel, string>,
);

const LOWER_UPDATE_AUTH_METHOD_LABELS: Record<LowerUpdateAuthMethod, string> = {
  password: '密码',
  certificate: '证书',
};

const LOWER_UPDATE_MOCK_TARGET = {
  managerAddr: '192.168.1.219:17000',
  uploadAccount: 'megsky@192.168.1.219:10022',
  installDir: '/home/megsky',
};

function getDeliveryStatusColor(status: LowerUpdateStatus): string {
  switch (status) {
    case '发现更新':
      return 'gold';
    case '检查失败':
    case '下载失败':
    case '上传失败':
    case '安装失败':
    case '版本不一致':
    case '版本确认失败':
      return 'error';
    case '下载中':
    case '校验中':
    case '上传中':
    case '安装中':
    case '版本确认中':
    case '已下载到上位机':
      return 'blue';
    case '已上传到下位机':
      return 'blue';
    case '升级完成':
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

function formatPackageSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) {
    return '-';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function getDownloadStageLabel(stage: DownloadStage): string {
  switch (stage) {
    case 'started':
      return '准备下载';
    case 'downloading':
      return '下载中';
    case 'verifying':
      return '校验中';
    case 'finished':
      return '校验通过';
    case 'failed':
      return '失败';
    default:
      return '未开始';
  }
}

function getDownloadStageTagColor(stage: DownloadStage): string {
  switch (stage) {
    case 'finished':
      return 'success';
    case 'failed':
      return 'error';
    case 'started':
    case 'downloading':
    case 'verifying':
      return 'processing';
    default:
      return 'default';
  }
}

function getUploadStageLabel(stage: UploadStage): string {
  switch (stage) {
    case 'started':
      return '准备上传';
    case 'uploading':
      return '上传中';
    case 'finished':
      return '上传完成';
    case 'failed':
      return '失败';
    default:
      return '未开始';
  }
}

function getUploadStageTagColor(stage: UploadStage): string {
  switch (stage) {
    case 'finished':
      return 'success';
    case 'failed':
      return 'error';
    case 'started':
    case 'uploading':
      return 'processing';
    default:
      return 'default';
  }
}

function getInstallStageLabel(stage: InstallStage): string {
  switch (stage) {
    case 'running':
      return '执行中';
    case 'succeeded':
      return '执行成功';
    case 'failed':
      return '执行失败';
    default:
      return '待执行';
  }
}

function getInstallStageTagColor(stage: InstallStage): string {
  switch (stage) {
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'error';
    case 'running':
      return 'processing';
    default:
      return 'default';
  }
}

function getVersionVerifyStageLabel(stage: VersionVerifyStage): string {
  switch (stage) {
    case 'waiting':
      return '等待恢复';
    case 'querying':
      return '查询版本中';
    case 'succeeded':
      return '确认成功';
    case 'mismatch':
      return '版本不一致';
    case 'failed':
      return '确认失败';
    default:
      return '待确认';
  }
}

function getVersionVerifyStageTagColor(stage: VersionVerifyStage): string {
  switch (stage) {
    case 'succeeded':
      return 'success';
    case 'mismatch':
    case 'failed':
      return 'error';
    case 'waiting':
    case 'querying':
      return 'processing';
    default:
      return 'default';
  }
}

function getDeployTaskStepLabel(step: DeployTaskStep): string {
  switch (step) {
    case 'uploading':
      return '上传中';
    case 'uploaded':
      return '上传完成';
    case 'upload_failed':
      return '上传失败';
    case 'installing':
      return '安装中';
    case 'installed':
      return '安装完成';
    case 'install_failed':
      return '安装失败';
    case 'verifying':
      return '确认版本中';
    case 'verify_failed':
      return '确认失败';
    case 'version_mismatch':
      return '版本不一致';
    case 'succeeded':
      return '升级完成';
    default:
      return '未开始';
  }
}

function getDeployTaskStepTagColor(step: DeployTaskStep): string {
  switch (step) {
    case 'succeeded':
      return 'success';
    case 'upload_failed':
    case 'install_failed':
    case 'verify_failed':
    case 'version_mismatch':
      return 'error';
    case 'uploading':
    case 'installing':
    case 'verifying':
      return 'processing';
    case 'uploaded':
    case 'installed':
      return 'blue';
    default:
      return 'default';
  }
}

function getDeployTaskProgress(step: DeployTaskStep, uploadProgress: number): number {
  switch (step) {
    case 'uploading':
      return Math.min(45, Math.round(uploadProgress * 0.45));
    case 'uploaded':
      return 45;
    case 'installing':
      return 65;
    case 'installed':
      return 75;
    case 'verifying':
      return 88;
    case 'succeeded':
      return 100;
    case 'upload_failed':
      return Math.min(45, Math.round(uploadProgress * 0.45));
    case 'install_failed':
      return 65;
    case 'verify_failed':
    case 'version_mismatch':
      return 88;
    default:
      return 0;
  }
}

function normalizeVersionForCompare(version: string): string {
  return version.trim().replace(/^v/i, '');
}

function isSameVersion(expectedVersion: string, actualVersion: string): boolean {
  return normalizeVersionForCompare(expectedVersion) === normalizeVersionForCompare(actualVersion);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatPublishedAt(value: string): string {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatLowerUpdateCheckError(channel: LowerUpdateChannel, error: unknown): string {
  const message = formatErrorMessage(error);
  if (/\bHTTP 404\b/i.test(message)) {
    return `${UPDATE_CHANNEL_LABELS[channel]} 通道还没有发布下位机更新清单，请切换到已有清单的通道，或先发布该通道的下位机安装包`;
  }

  return message;
}

const AdvancedConfigPage: React.FC = () => {
  const [authorized, setAuthorized] = useState(isAdvancedConfigAuthorized);
  const [channel, setChannel] = useState<LowerUpdateChannel>(DEFAULT_LOWER_UPDATE_CHANNEL);
  const [currentLowerVersion, setCurrentLowerVersion] = useState('0.2.3');
  const [latestLowerVersion, setLatestLowerVersion] = useState('-');
  const [packageName, setPackageName] = useState('-');
  const [packageSize, setPackageSize] = useState('-');
  const [publishedAt, setPublishedAt] = useState('-');
  const [sha256, setSha256] = useState('-');
  const [deliveryStatus, setDeliveryStatus] = useState<LowerUpdateStatus>('未检查');
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false);
  const [downloadModalProgress, setDownloadModalProgress] = useState(0);
  const [downloadStage, setDownloadStage] = useState<DownloadStage>('idle');
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [downloadTotalBytes, setDownloadTotalBytes] = useState(0);
  const [downloadedPackagePath, setDownloadedPackagePath] = useState('-');
  const [downloadedPackageSha256, setDownloadedPackageSha256] = useState('-');
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [uploadModalProgress, setUploadModalProgress] = useState(0);
  const [deployTaskStep, setDeployTaskStep] = useState<DeployTaskStep>('idle');
  const [uploadStage, setUploadStage] = useState<UploadStage>('idle');
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [uploadTotalBytes, setUploadTotalBytes] = useState(0);
  const [uploadedRemotePath, setUploadedRemotePath] = useState('-');
  const [installStage, setInstallStage] = useState<InstallStage>('idle');
  const [installCommand, setInstallCommand] = useState('-');
  const [installExitCode, setInstallExitCode] = useState<number | null>(null);
  const [installStdout, setInstallStdout] = useState('');
  const [installStderr, setInstallStderr] = useState('');
  const [versionVerifyStage, setVersionVerifyStage] = useState<VersionVerifyStage>('idle');
  const [versionVerifyModuleName, setVersionVerifyModuleName] = useState('ModuleManager');
  const [expectedVerifyVersion, setExpectedVerifyVersion] = useState('-');
  const [actualVerifyVersion, setActualVerifyVersion] = useState('-');
  const [versionVerifyMessage, setVersionVerifyMessage] = useState('-');
  const [targetManagerAddr, setTargetManagerAddr] = useState(LOWER_UPDATE_MOCK_TARGET.managerAddr);
  const [targetUploadAccount, setTargetUploadAccount] = useState(LOWER_UPDATE_MOCK_TARGET.uploadAccount);
  const [targetInstallDir, setTargetInstallDir] = useState(LOWER_UPDATE_MOCK_TARGET.installDir);
  const [targetSshPassword, setTargetSshPassword] = useState(DEFAULT_LOWER_UPDATE_SSH_PASSWORD);
  const [lowerUpdateAuthMethod, setLowerUpdateAuthMethod] = useState<LowerUpdateAuthMethod>(
    DEFAULT_LOWER_UPDATE_AUTH_METHOD,
  );
  const [isCheckingLowerUpdate, setIsCheckingLowerUpdate] = useState(false);
  const [isDownloadingLowerUpdate, setIsDownloadingLowerUpdate] = useState(false);
  const [isUploadingLowerUpdate, setIsUploadingLowerUpdate] = useState(false);
  const [isInstallingLowerUpdate, setIsInstallingLowerUpdate] = useState(false);
  const [isVerifyingLowerUpdate, setIsVerifyingLowerUpdate] = useState(false);
  const [activeManifest, setActiveManifest] = useState<LowerUpdateManifest | null>(null);
  const [downloadResult, setDownloadResult] = useState<LowerUpdateDownloadResult | null>(null);
  const [uploadResult, setUploadResult] = useState<LowerUpdateUploadResult | null>(null);
  const [installResult, setInstallResult] = useState<LowerUpdateInstallResult | null>(null);
  const [form] = Form.useForm<AdvancedConfigAuthFormValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const [isLoadingSavedSshPassword, setIsLoadingSavedSshPassword] = useState(false);
  const targetManagerAddrValidation = validateManagerAddress(targetManagerAddr);
  const targetUploadAccountValidation = validateUploadAccount(targetUploadAccount);
  const targetInstallDirValidation = validateInstallDir(targetInstallDir);
  const hasSshPasswordValidationError = lowerUpdateAuthMethod === 'password' && targetSshPassword.length === 0;
  const hasTargetValidationError =
    !targetManagerAddrValidation.ok
    || !targetUploadAccountValidation.ok
    || !targetInstallDirValidation.ok
    || hasSshPasswordValidationError;
  const hasCheckedPackage = activeManifest !== null;
  const hasDownloadedPackage = downloadResult !== null;
  const isDeployingLowerUpdate = isUploadingLowerUpdate || isInstallingLowerUpdate || isVerifyingLowerUpdate;
  const deployTaskProgress = getDeployTaskProgress(deployTaskStep, uploadModalProgress);
  const isDeployTaskFailed =
    deployTaskStep === 'upload_failed'
    || deployTaskStep === 'install_failed'
    || deployTaskStep === 'verify_failed'
    || deployTaskStep === 'version_mismatch';
  const canReinstall = Boolean(downloadResult && uploadResult);
  const canReverifyVersion = installResult?.success === true;

  React.useEffect(() => {
    if (lowerUpdateAuthMethod !== 'password' || !targetUploadAccount.trim()) {
      return;
    }
    let cancelled = false;
    setIsLoadingSavedSshPassword(true);
    void api.getLowerUpdatePassword(targetUploadAccount.trim())
      .then((password) => {
        if (!cancelled && password !== null) {
          setTargetSshPassword(password);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setIsLoadingSavedSshPassword(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [lowerUpdateAuthMethod, targetUploadAccount]);

  const handleSubmit = ({ password }: AdvancedConfigAuthFormValues): void => {
    if (!isAdvancedConfigPasswordValid(password)) {
      form.setFields([{ name: 'password', errors: ['密码不正确'] }]);
      return;
    }

    authorizeAdvancedConfigSession();
    setAuthorized(true);
    form.resetFields();
  };

  const resetVersionVerifyState = (): void => {
    setVersionVerifyStage('idle');
    setVersionVerifyModuleName('ModuleManager');
    setExpectedVerifyVersion('-');
    setActualVerifyVersion('-');
    setVersionVerifyMessage('-');
  };

  const resetInstallState = (): void => {
    setInstallStage('idle');
    setInstallCommand('-');
    setInstallExitCode(null);
    setInstallStdout('');
    setInstallStderr('');
    setInstallResult(null);
    resetVersionVerifyState();
  };

  const resetUploadState = (): void => {
    setIsUploadModalOpen(false);
    setUploadModalProgress(0);
    setDeployTaskStep('idle');
    setUploadStage('idle');
    setUploadedBytes(0);
    setUploadTotalBytes(0);
    setUploadedRemotePath('-');
    setUploadResult(null);
    resetInstallState();
  };

  const resetUpdateState = (): void => {
    setCurrentLowerVersion('0.2.3');
    setLatestLowerVersion('-');
    setPackageName('-');
    setPackageSize('-');
    setPublishedAt('-');
    setSha256('-');
    setDeliveryStatus('未检查');
    setDownloadModalProgress(0);
    setDownloadStage('idle');
    setDownloadedBytes(0);
    setDownloadTotalBytes(0);
    setDownloadedPackagePath('-');
    setDownloadedPackageSha256('-');
    setIsDownloadModalOpen(false);
    resetUploadState();
    setActiveManifest(null);
    setDownloadResult(null);
  };

  const applyLowerUpdateManifest = (manifest: LowerUpdateManifest): void => {
    setLatestLowerVersion(manifest.version);
    setPackageName(manifest.asset.name);
    setPackageSize(formatPackageSize(manifest.asset.size));
    setPublishedAt(formatPublishedAt(manifest.published_at));
    setSha256(manifest.asset.sha256);
  };

  const handleCheckUpdate = async (): Promise<void> => {
    setIsCheckingLowerUpdate(true);
    try {
      const manifest = await api.checkLowerUpdate(channel);
      applyLowerUpdateManifest(manifest);
      setActiveManifest(manifest);
      setDownloadResult(null);
      setDownloadedPackagePath('-');
      setDownloadedPackageSha256('-');
      setDownloadStage('idle');
      setDownloadModalProgress(0);
      setDownloadedBytes(0);
      setDownloadTotalBytes(manifest.asset.size);
      resetUploadState();
      setDeliveryStatus('发现更新');
      messageApi.success(`发现下位机版本 ${manifest.version}`);
    } catch (error) {
      setDeliveryStatus('检查失败');
      messageApi.error(`检查更新失败: ${formatLowerUpdateCheckError(channel, error)}`);
    } finally {
      setIsCheckingLowerUpdate(false);
    }
  };

  const handleDownload = async (): Promise<void> => {
    if (!activeManifest) {
      messageApi.warning('请先检查更新');
      return;
    }

    setIsDownloadModalOpen(true);
    setIsDownloadingLowerUpdate(true);
    setDownloadStage('started');
    setDownloadModalProgress(0);
    setDownloadedBytes(0);
    setDownloadTotalBytes(activeManifest.asset.size);
    setDownloadedPackagePath('-');
    setDownloadedPackageSha256('-');
    setDownloadResult(null);
    resetUploadState();
    setDeliveryStatus('下载中');

    try {
      const result = await api.downloadLowerUpdate(activeManifest, (progress) => {
        setDownloadStage(progress.stage);
        setDownloadModalProgress(progress.percent);
        setDownloadedBytes(progress.downloaded_bytes);
        setDownloadTotalBytes(progress.total_bytes || activeManifest.asset.size);
        setDeliveryStatus(progress.stage === 'verifying' ? '校验中' : '下载中');
      });
      setDownloadResult(result);
      setDownloadedPackagePath(result.package_path);
      setDownloadedPackageSha256(result.sha256);
      setDownloadedBytes(result.downloaded_bytes);
      setDownloadTotalBytes(activeManifest.asset.size);
      setDownloadModalProgress(100);
      setDownloadStage('finished');
      setDeliveryStatus('已下载到上位机');
      messageApi.success('下位机更新包已下载并校验通过');
    } catch (error) {
      setDownloadStage('failed');
      setDeliveryStatus('下载失败');
      messageApi.error(`下载失败: ${formatErrorMessage(error)}`);
    } finally {
      setIsDownloadingLowerUpdate(false);
    }
  };

  const verifyInstalledVersion = async (expectedVersion: string): Promise<'succeeded' | 'mismatch' | 'failed'> => {
    const moduleName = 'ModuleManager';
    const managerAddrValidation = validateManagerAddress(targetManagerAddr);

    if (!managerAddrValidation.ok) {
      throw new Error(managerAddrValidation.error);
    }

    setVersionVerifyModuleName(moduleName);
    setExpectedVerifyVersion(expectedVersion);
    setActualVerifyVersion('-');
    setVersionVerifyStage('waiting');
    setVersionVerifyMessage('等待下位机服务恢复');
    await sleep(5000);

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      setVersionVerifyStage('querying');
      setVersionVerifyMessage(`查询 ${moduleName} 版本中 (${attempt}/6)`);

      try {
        await api.setManagerAddr(managerAddrValidation.normalized);
        const moduleInfo = await api.getModuleInfo();
        const targetModule = moduleInfo.find((item: ModuleInfo) => item.module_name === moduleName);

        if (!targetModule) {
          throw new Error(`未找到 ${moduleName} 模块`);
        }

        const actualVersion = targetModule.version?.version?.trim() || '-';
        setActualVerifyVersion(actualVersion);
        setCurrentLowerVersion(actualVersion);

        if (!targetModule.version || actualVersion === '-') {
          throw new Error(`${moduleName} 未上报版本号`);
        }

        if (!isSameVersion(expectedVersion, actualVersion)) {
          setVersionVerifyStage('mismatch');
          setVersionVerifyMessage(`期望 ${expectedVersion}，实际 ${actualVersion}`);
          return 'mismatch';
        }

        setVersionVerifyStage('succeeded');
        setVersionVerifyMessage(`版本已确认: ${actualVersion}`);
        return 'succeeded';
      } catch (error) {
        lastError = error;
        if (attempt < 6) {
          await sleep(3000);
        }
      }
    }

    setVersionVerifyStage('failed');
    setVersionVerifyMessage(formatErrorMessage(lastError));
    return 'failed';
  };

  const runUploadStep = async (packageResult: LowerUpdateDownloadResult): Promise<LowerUpdateUploadResult | null> => {
    setDeployTaskStep('uploading');
    setIsUploadingLowerUpdate(true);
    setUploadStage('started');
    setUploadModalProgress(0);
    setUploadedBytes(0);
    setUploadTotalBytes(packageResult.downloaded_bytes);
    setUploadedRemotePath('-');
    setUploadResult(null);
    resetInstallState();
    setDeliveryStatus('上传中');

    try {
      const result = await api.uploadLowerUpdatePackage(
        {
          package_name: packageResult.package_name,
          package_path: packageResult.package_path,
          package_size: packageResult.downloaded_bytes,
          upload_account: targetUploadAccount.trim(),
          install_dir: targetInstallDir.trim(),
          auth: lowerUpdateAuthMethod === 'password'
            ? { method: 'password', password: targetSshPassword }
            : { method: 'certificate' },
        },
        (progress) => {
          setUploadStage(progress.stage);
          setUploadModalProgress(progress.percent);
          setUploadedBytes(progress.uploaded_bytes);
          setUploadTotalBytes(progress.total_bytes || packageResult.downloaded_bytes);
          setUploadedRemotePath(progress.remote_path || '-');
          setDeliveryStatus('上传中');
        },
      );

      setUploadResult(result);
      setUploadedRemotePath(result.remote_path);
      setUploadedBytes(result.uploaded_bytes);
      setUploadTotalBytes(packageResult.downloaded_bytes);
      setUploadModalProgress(100);
      setUploadStage('finished');
      setDeployTaskStep('uploaded');
      setDeliveryStatus('已上传到下位机');
      return result;
    } catch (error) {
      setUploadStage('failed');
      setDeployTaskStep('upload_failed');
      setDeliveryStatus('上传失败');
      messageApi.error(`上传失败: ${formatErrorMessage(error)}`);
      return null;
    } finally {
      setIsUploadingLowerUpdate(false);
    }
  };

  const runInstallStep = async (packageResult: LowerUpdateDownloadResult): Promise<boolean> => {
    resetInstallState();
    setDeployTaskStep('installing');
    setDeliveryStatus('安装中');
    setInstallStage('running');
    setIsInstallingLowerUpdate(true);

    try {
      const result = await api.installLowerUpdatePackage({
        package_name: packageResult.package_name,
        upload_account: targetUploadAccount.trim(),
        install_dir: targetInstallDir.trim(),
        auth: lowerUpdateAuthMethod === 'password'
          ? { method: 'password', password: targetSshPassword }
          : { method: 'certificate' },
      });

      setInstallResult(result);
      setInstallCommand(result.command);
      setInstallExitCode(result.exit_code);
      setInstallStdout(result.stdout);
      setInstallStderr(result.stderr);
      setUploadedRemotePath(result.remote_path);

      if (!result.success) {
        setInstallStage('failed');
        setDeployTaskStep('install_failed');
        setDeliveryStatus('安装失败');
        messageApi.error(`安装命令执行失败，退出码: ${result.exit_code ?? '-'}`);
        return false;
      }

      setInstallStage('succeeded');
      setDeployTaskStep('installed');
      return true;
    } catch (error) {
      setInstallStage('failed');
      setDeployTaskStep('install_failed');
      setDeliveryStatus('安装失败');
      messageApi.error(`安装失败: ${formatErrorMessage(error)}`);
      return false;
    } finally {
      setIsInstallingLowerUpdate(false);
    }
  };

  const runVersionVerifyStep = async (): Promise<boolean> => {
    setDeployTaskStep('verifying');
    setDeliveryStatus('版本确认中');
    setIsVerifyingLowerUpdate(true);

    try {
      const expectedVersion = activeManifest?.version ?? latestLowerVersion;
      const verifyResult = await verifyInstalledVersion(expectedVersion);
      if (verifyResult === 'succeeded') {
        setDeployTaskStep('succeeded');
        setDeliveryStatus('升级完成');
        messageApi.success('下位机版本已确认，升级完成');
        return true;
      }

      if (verifyResult === 'mismatch') {
        setDeployTaskStep('version_mismatch');
        setDeliveryStatus('版本不一致');
        messageApi.error('安装命令已执行，但下位机实际版本与清单版本不一致');
        return false;
      }

      setDeployTaskStep('verify_failed');
      setDeliveryStatus('版本确认失败');
      messageApi.error('安装命令已执行，但版本确认失败');
      return false;
    } catch (error) {
      setVersionVerifyStage('failed');
      setVersionVerifyMessage(formatErrorMessage(error));
      setDeployTaskStep('verify_failed');
      setDeliveryStatus('版本确认失败');
      messageApi.error(`版本确认失败: ${formatErrorMessage(error)}`);
      return false;
    } finally {
      setIsVerifyingLowerUpdate(false);
    }
  };

  const runDeployFlow = async ({ forceUpload = false }: { forceUpload?: boolean } = {}): Promise<void> => {
    if (!downloadResult) {
      messageApi.warning('请先下载到上位机');
      return;
    }

    setIsUploadModalOpen(true);

    let activeUploadResult = forceUpload ? null : uploadResult;
    if (forceUpload) {
      setUploadResult(null);
      setUploadedRemotePath('-');
      setUploadedBytes(0);
      setUploadModalProgress(0);
      setUploadStage('idle');
    }

    if (!activeUploadResult) {
      activeUploadResult = await runUploadStep(downloadResult);
      if (!activeUploadResult) {
        return;
      }
    } else {
      setUploadedRemotePath(activeUploadResult.remote_path);
      setUploadedBytes(activeUploadResult.uploaded_bytes);
      setUploadTotalBytes(downloadResult.downloaded_bytes);
      setUploadModalProgress(100);
      setUploadStage('finished');
      setDeployTaskStep('uploaded');
    }

    const installed = await runInstallStep(downloadResult);
    if (!installed) {
      return;
    }

    await runVersionVerifyStep();
  };

  const handleDeployPackage = async (): Promise<void> => {
    await runDeployFlow();
  };

  const handleRetryDeploy = async (): Promise<void> => {
    await runDeployFlow({ forceUpload: deployTaskStep === 'upload_failed' || !uploadResult });
  };

  const handleReuploadAndInstall = async (): Promise<void> => {
    await runDeployFlow({ forceUpload: true });
  };

  const handleReinstall = async (): Promise<void> => {
    if (!downloadResult || !uploadResult) {
      messageApi.warning('请先完成上传');
      return;
    }

    setIsUploadModalOpen(true);
    setUploadedRemotePath(uploadResult.remote_path);
    setUploadedBytes(uploadResult.uploaded_bytes);
    setUploadTotalBytes(downloadResult.downloaded_bytes);
    setUploadModalProgress(100);
    setUploadStage('finished');
    setDeployTaskStep('uploaded');

    const installed = await runInstallStep(downloadResult);
    if (installed) {
      await runVersionVerifyStep();
    }
  };

  const handleReverifyVersion = async (): Promise<void> => {
    if (!installResult?.success) {
      messageApi.warning('请先完成安装命令');
      return;
    }

    setIsUploadModalOpen(true);
    await runVersionVerifyStep();
  };

  const handleLogout = (): void => {
    revokeAdvancedConfigSession();
    setAuthorized(false);
    setTargetSshPassword('');
    form.resetFields();
  };

  if (authorized) {
    return (
      <>
        {contextHolder}
        <div className="advanced-config-page">
        <div className="advanced-config-page-header">
          <Space size={8}>
            <CloudDownloadOutlined />
            <Text strong className="advanced-config-page-title">
              下位机更新下发
            </Text>
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
                    disabled={isDeployingLowerUpdate}
                    onChange={(event) => {
                      setTargetManagerAddr(event.target.value);
                      resetUploadState();
                      if (downloadResult) {
                        setDeliveryStatus('已下载到上位机');
                      }
                    }}
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
                    disabled={isDeployingLowerUpdate}
                    onChange={(event) => {
                      setTargetUploadAccount(event.target.value);
                      setTargetSshPassword('');
                      resetUploadState();
                      if (downloadResult) {
                        setDeliveryStatus('已下载到上位机');
                      }
                    }}
                    placeholder="例如 megsky@192.168.1.219:10022"
                  />
                </Form.Item>
                <Form.Item label="SSH 认证方式">
                  <Segmented<LowerUpdateAuthMethod>
                    block
                    value={lowerUpdateAuthMethod}
                    options={Object.entries(LOWER_UPDATE_AUTH_METHOD_LABELS).map(([value, label]) => ({
                      value: value as LowerUpdateAuthMethod,
                      label,
                    }))}
                    disabled={isDeployingLowerUpdate}
                    onChange={(value) => {
                      setLowerUpdateAuthMethod(value);
                      if (value === 'certificate') {
                        setTargetSshPassword('');
                      }
                      resetUploadState();
                      if (downloadResult) {
                        setDeliveryStatus('已下载到上位机');
                      }
                    }}
                  />
                </Form.Item>
                {lowerUpdateAuthMethod === 'password' ? (
                  <Form.Item
                    label="SSH 密码"
                    required
                    validateStatus={hasSshPasswordValidationError ? 'error' : undefined}
                    help={hasSshPasswordValidationError ? '请输入 SSH 登录密码' : undefined}
                  >
                    <Input.Password
                      value={targetSshPassword}
                      disabled={isDeployingLowerUpdate || isLoadingSavedSshPassword}
                      autoComplete="current-password"
                      onChange={(event) => {
                        setTargetSshPassword(event.target.value);
                        resetUploadState();
                        if (downloadResult) {
                          setDeliveryStatus('已下载到上位机');
                        }
                      }}
                      placeholder="请输入 SSH 登录密码"
                    />
                  </Form.Item>
                ) : null}
                <Form.Item
                  label="安装目录"
                  validateStatus={targetInstallDirValidation.ok ? undefined : 'error'}
                  help={targetInstallDirValidation.ok ? undefined : targetInstallDirValidation.error}
                >
                  <Input
                    value={targetInstallDir}
                    disabled={isDeployingLowerUpdate}
                    onChange={(event) => {
                      setTargetInstallDir(event.target.value);
                      resetUploadState();
                      if (downloadResult) {
                        setDeliveryStatus('已下载到上位机');
                      }
                    }}
                    placeholder="例如 /home/megsky"
                  />
                </Form.Item>
              </Form>
            </div>

            <div className="advanced-config-section">
              <div className="advanced-config-section-title">版本来源</div>
              <Form layout="vertical" size="small">
                <Form.Item label="发布通道">
                  <Select<LowerUpdateChannel>
                    value={channel}
                    options={UPDATE_CHANNEL_OPTIONS}
                    disabled={isCheckingLowerUpdate || isDownloadingLowerUpdate || isDeployingLowerUpdate}
                    onChange={(value) => {
                      setChannel(value);
                      resetUpdateState();
                    }}
                  />
                </Form.Item>
              </Form>
              <Text type="secondary">
                上位机从静态源获取更新包，再下发到下位机执行安装。
              </Text>
              <Space wrap className="advanced-config-action-row">
                <Button
                  icon={<FileSearchOutlined />}
                  onClick={() => void handleCheckUpdate()}
                  disabled={hasTargetValidationError}
                  loading={isCheckingLowerUpdate}
                >
                  检查更新
                </Button>
                <Button
                  icon={<DownloadOutlined />}
                  onClick={() => void handleDownload()}
                  disabled={
                    hasTargetValidationError
                    || !hasCheckedPackage
                    || isCheckingLowerUpdate
                    || isDownloadingLowerUpdate
                    || isDeployingLowerUpdate
                  }
                  loading={isDownloadingLowerUpdate}
                >
                  下载到上位机
                </Button>
                <Button
                  type="primary"
                  icon={<UploadOutlined />}
                  onClick={() => void handleDeployPackage()}
                  disabled={
                    hasTargetValidationError
                    || !hasDownloadedPackage
                    || isCheckingLowerUpdate
                    || isDownloadingLowerUpdate
                    || isDeployingLowerUpdate
                  }
                  loading={isDeployingLowerUpdate}
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
          okButtonProps={{ disabled: isDownloadingLowerUpdate }}
          cancelButtonProps={{ style: { display: 'none' } }}
          maskClosable={!isDownloadingLowerUpdate}
          onOk={() => setIsDownloadModalOpen(false)}
          onCancel={() => {
            if (!isDownloadingLowerUpdate) {
              setIsDownloadModalOpen(false);
            }
          }}
        >
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="安装包">{packageName}</Descriptions.Item>
              <Descriptions.Item label="包大小">{packageSize}</Descriptions.Item>
              <Descriptions.Item label="已下载">
                {formatPackageSize(downloadedBytes)} / {formatPackageSize(downloadTotalBytes || activeManifest?.asset.size || 0)}
              </Descriptions.Item>
              <Descriptions.Item label="本地路径">{downloadedPackagePath}</Descriptions.Item>
              <Descriptions.Item label="校验文件">{activeManifest?.checksum.name ?? 'SHA256SUMS'}</Descriptions.Item>
              <Descriptions.Item label="校验状态">
                <Tag color={getDownloadStageTagColor(downloadStage)}>{getDownloadStageLabel(downloadStage)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="实际 SHA256">{downloadedPackageSha256}</Descriptions.Item>
            </Descriptions>
            <Progress
              percent={downloadModalProgress}
              status={downloadStage === 'failed' ? 'exception' : downloadStage === 'finished' ? 'success' : 'active'}
            />
            <Text type="secondary">下载完成后会自动校验 SHA256，通过后可继续下发安装。</Text>
          </Space>
        </Modal>

        <Modal
          open={isUploadModalOpen}
          title="下发并安装"
          okText="完成"
          okButtonProps={{ disabled: isDeployingLowerUpdate }}
          cancelButtonProps={{ style: { display: 'none' } }}
          maskClosable={!isDeployingLowerUpdate}
          onOk={() => setIsUploadModalOpen(false)}
          onCancel={() => {
            if (!isDeployingLowerUpdate) {
              setIsUploadModalOpen(false);
            }
          }}
        >
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="目标下位机">{targetUploadAccount}</Descriptions.Item>
              <Descriptions.Item label="SSH 认证方式">
                {LOWER_UPDATE_AUTH_METHOD_LABELS[lowerUpdateAuthMethod]}
              </Descriptions.Item>
              <Descriptions.Item label="安装目录">{targetInstallDir}</Descriptions.Item>
              <Descriptions.Item label="安装包">{packageName}</Descriptions.Item>
              <Descriptions.Item label="本地路径">{downloadResult?.package_path ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="远端路径">{uploadedRemotePath}</Descriptions.Item>
              <Descriptions.Item label="已上传">
                {formatPackageSize(uploadedBytes)} / {formatPackageSize(uploadTotalBytes || downloadResult?.downloaded_bytes || 0)}
              </Descriptions.Item>
              <Descriptions.Item label="任务阶段">
                <Tag color={getDeployTaskStepTagColor(deployTaskStep)}>{getDeployTaskStepLabel(deployTaskStep)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="上传状态">
                <Tag color={getUploadStageTagColor(uploadStage)}>{getUploadStageLabel(uploadStage)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="安装状态">
                <Tag color={getInstallStageTagColor(installStage)}>{getInstallStageLabel(installStage)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="确认模块">{versionVerifyModuleName}</Descriptions.Item>
              <Descriptions.Item label="期望版本">{expectedVerifyVersion}</Descriptions.Item>
              <Descriptions.Item label="实际版本">{actualVerifyVersion}</Descriptions.Item>
              <Descriptions.Item label="确认状态">
                <Tag color={getVersionVerifyStageTagColor(versionVerifyStage)}>
                  {getVersionVerifyStageLabel(versionVerifyStage)}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="确认说明">{versionVerifyMessage}</Descriptions.Item>
              <Descriptions.Item label="退出码">{installExitCode ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="执行命令">
                <Text code>{installCommand}</Text>
              </Descriptions.Item>
            </Descriptions>
            <Progress
              percent={deployTaskProgress}
              status={
                isDeployTaskFailed
                  ? 'exception'
                  : deployTaskStep === 'succeeded'
                    ? 'success'
                    : 'active'
              }
            />
            <Space wrap>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => void handleRetryDeploy()}
                disabled={!isDeployTaskFailed || !downloadResult || isDeployingLowerUpdate}
              >
                重试流程
              </Button>
              <Button
                size="small"
                icon={<UploadOutlined />}
                onClick={() => void handleReuploadAndInstall()}
                disabled={!downloadResult || isDeployingLowerUpdate}
              >
                重新上传并安装
              </Button>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => void handleReinstall()}
                disabled={!canReinstall || isDeployingLowerUpdate}
              >
                重新安装
              </Button>
              <Button
                size="small"
                icon={<SafetyCertificateOutlined />}
                onClick={() => void handleReverifyVersion()}
                disabled={!canReverifyVersion || isDeployingLowerUpdate}
              >
                重新确认版本
              </Button>
            </Space>
            <Input.TextArea
              value={installStdout || '-'}
              readOnly
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="stdout"
            />
            <Input.TextArea
              value={installStderr || '-'}
              readOnly
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="stderr"
            />
            <Text type="secondary">安装命令执行成功后，会自动查询 ModuleManager 版本确认升级结果。</Text>
          </Space>
        </Modal>
        </div>
      </>
    );
  }

  return (
    <>
      {contextHolder}
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
    </>
  );
};

export default AdvancedConfigPage;
