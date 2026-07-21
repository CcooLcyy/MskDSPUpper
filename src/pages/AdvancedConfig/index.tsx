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
  DownloadOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  api,
  type AppUpdateStatusKind,
  type LowerUpdateChannel,
  type LowerUpdateDownloadProgress,
  type LowerUpdateDownloadResult,
  type LowerUpdateInstallResult,
  type LowerUpdateManifest,
  type LowerUpdateSshAuth,
  type LowerUpdateUploadProgress,
  type LowerUpdateUploadResult,
} from '../../adapters';
import { useAppUpdate } from '../../components/app-update/app-update-context';
import {
  normalizeSoftwareUpdateView,
  SOFTWARE_UPDATE_VIEW_QUERY_KEY,
} from '../../components/app-update/update-view';
import { validateManagerAddress } from '../../utils/network';
import { useSearchParams } from 'react-router-dom';
import './index.css';

const { Paragraph, Text } = Typography;

type LowerUpdateAuthMethod = LowerUpdateSshAuth['method'];

type LowerUpdateStatus =
  | '未检查'
  | '检查失败'
  | '发现更新'
  | '已是最新'
  | '无法确认'
  | '下载中'
  | '校验中'
  | '下载失败'
  | '已下载到上位机'
  | '上传中'
  | '上传失败'
  | '已上传到下位机'
  | '安装中'
  | '安装失败'
  | '镜像确认中'
  | '构建不一致'
  | '镜像确认失败'
  | '升级完成';

type DownloadStage = LowerUpdateDownloadProgress['stage'] | 'idle' | 'failed';
type UploadStage = LowerUpdateUploadProgress['stage'] | 'idle' | 'failed';
type InstallStage = 'idle' | 'running' | 'succeeded' | 'failed';
type ImageVerifyStage = 'idle' | 'waiting' | 'querying' | 'succeeded' | 'mismatch' | 'failed';
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
  | 'image_mismatch'
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
  uploadAccount: 'megsky@192.168.1.219:10022',
  installDir: '/home/megsky',
};

function getDeliveryStatusColor(status: LowerUpdateStatus): string {
  switch (status) {
    case '发现更新':
      return 'gold';
    case '已是最新':
      return 'success';
    case '无法确认':
      return 'default';
    case '检查失败':
    case '下载失败':
    case '上传失败':
    case '安装失败':
    case '构建不一致':
    case '镜像确认失败':
      return 'error';
    case '下载中':
    case '校验中':
    case '上传中':
    case '安装中':
    case '镜像确认中':
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

function getImageVerifyStageLabel(stage: ImageVerifyStage): string {
  switch (stage) {
    case 'waiting':
      return '等待恢复';
    case 'querying':
      return '查询运行镜像中';
    case 'succeeded':
      return '确认成功';
    case 'mismatch':
      return '构建不一致';
    case 'failed':
      return '确认失败';
    default:
      return '待确认';
  }
}

function getImageVerifyStageTagColor(stage: ImageVerifyStage): string {
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
      return '确认运行镜像中';
    case 'verify_failed':
      return '确认失败';
    case 'image_mismatch':
      return '构建不一致';
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
    case 'image_mismatch':
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
    case 'image_mismatch':
      return 88;
    default:
      return 0;
  }
}

function isSameImageId(expectedImageId: string, actualImageId: string): boolean {
  return expectedImageId.trim().toLowerCase() === actualImageId.trim().toLowerCase();
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

function formatReleaseDate(value?: string): string {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function getAppUpdateTagColor(kind: AppUpdateStatusKind): string {
  switch (kind) {
    case 'checking':
      return 'processing';
    case 'up-to-date':
      return 'success';
    case 'available':
      return 'gold';
    case 'installing':
      return 'blue';
    case 'ready-to-restart':
      return 'cyan';
    case 'error':
      return 'error';
    default:
      return 'default';
  }
}

function getAppUpdateTagLabel(kind: AppUpdateStatusKind): string {
  switch (kind) {
    case 'checking':
      return '检查中';
    case 'up-to-date':
      return '已是最新';
    case 'available':
      return '发现更新';
    case 'installing':
      return '安装中';
    case 'ready-to-restart':
      return '待重启';
    case 'error':
      return '异常';
    default:
      return '未检查';
  }
}

function formatLowerUpdateCheckError(channel: LowerUpdateChannel, error: unknown): string {
  const message = formatErrorMessage(error);
  if (/\bHTTP 404\b/i.test(message)) {
    return `${UPDATE_CHANNEL_LABELS[channel]} 通道还没有发布下位机更新清单，请切换到已有清单的通道，或先发布该通道的下位机安装包`;
  }

  return message;
}

const AdvancedConfigPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const activeUpdateTab = normalizeSoftwareUpdateView(searchParams.get(SOFTWARE_UPDATE_VIEW_QUERY_KEY));
  const [channel, setChannel] = useState<LowerUpdateChannel>(DEFAULT_LOWER_UPDATE_CHANNEL);
  const [currentLowerImageId, setCurrentLowerImageId] = useState('-');
  const [latestLowerImageId, setLatestLowerImageId] = useState('-');
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
  const [imageVerifyStage, setImageVerifyStage] = useState<ImageVerifyStage>('idle');
  const [expectedImageId, setExpectedImageId] = useState('-');
  const [actualImageId, setActualImageId] = useState('-');
  const [imageVerifyMessage, setImageVerifyMessage] = useState('-');
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
  const [messageApi, contextHolder] = message.useMessage();
  const [isLoadingSavedSshPassword, setIsLoadingSavedSshPassword] = useState(false);
  const {
    appVersion,
    availableUpdate,
    updateStatus,
    isCheckingUpdate,
    isInstallingUpdate,
    downloadedBytes: appDownloadedBytes,
    totalBytes: appTotalBytes,
    checkForUpdate,
    installUpdate,
    relaunchAfterUpdate,
  } = useAppUpdate();
  const targetUploadAccountValidation = validateUploadAccount(targetUploadAccount);
  const targetInstallDirValidation = validateInstallDir(targetInstallDir);
  const hasSshPasswordValidationError = lowerUpdateAuthMethod === 'password' && targetSshPassword.length === 0;
  const hasRuntimeQueryValidationError = !targetUploadAccountValidation.ok || hasSshPasswordValidationError;
  const hasDeployTargetValidationError = hasRuntimeQueryValidationError || !targetInstallDirValidation.ok;
  const hasCheckedPackage = activeManifest !== null;
  const hasVerifiableManifest = Boolean(activeManifest?.image_id?.trim());
  const hasDownloadedPackage = downloadResult !== null;
  const isDeployingLowerUpdate = isUploadingLowerUpdate || isInstallingLowerUpdate || isVerifyingLowerUpdate;
  const deployTaskProgress = getDeployTaskProgress(deployTaskStep, uploadModalProgress);
  const isDeployTaskFailed =
    deployTaskStep === 'upload_failed'
    || deployTaskStep === 'install_failed'
    || deployTaskStep === 'verify_failed'
    || deployTaskStep === 'image_mismatch';
  const canReinstall = Boolean(downloadResult && uploadResult);
  const canReverifyImage = installResult?.success === true;
  const appDownloadPercent =
    appTotalBytes && appTotalBytes > 0 ? Math.min(100, Math.round((appDownloadedBytes / appTotalBytes) * 100)) : 0;

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

  const handleCheckAppUpdate = async (): Promise<void> => {
    try {
      const update = await checkForUpdate();
      messageApi.success(update ? `发现客户端新版本 ${update.version}` : '当前客户端已经是最新版本');
    } catch (error) {
      messageApi.error(`检查更新失败: ${error}`);
    }
  };

  const handleInstallAppUpdate = async (): Promise<void> => {
    try {
      const update = await installUpdate();
      messageApi.success(`客户端 ${update.version} 已下载安装完成`);
    } catch (error) {
      messageApi.error(`安装更新失败: ${error}`);
    }
  };

  const handleRelaunchApp = async (): Promise<void> => {
    try {
      await relaunchAfterUpdate();
    } catch (error) {
      messageApi.error(`重启客户端失败: ${error}`);
    }
  };

  const resetImageVerifyState = (): void => {
    setImageVerifyStage('idle');
    setExpectedImageId('-');
    setActualImageId('-');
    setImageVerifyMessage('-');
  };

  const resetInstallState = (): void => {
    setInstallStage('idle');
    setInstallCommand('-');
    setInstallExitCode(null);
    setInstallStdout('');
    setInstallStderr('');
    setInstallResult(null);
    resetImageVerifyState();
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
    setCurrentLowerImageId('-');
    setLatestLowerImageId('-');
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

  const invalidateRuntimeCheck = (): void => {
    setCurrentLowerImageId('-');
    resetUploadState();
    setDeliveryStatus(downloadResult ? '已下载到上位机' : '未检查');
  };

  const applyLowerUpdateManifest = (manifest: LowerUpdateManifest): void => {
    setLatestLowerImageId(manifest.image_id?.trim() || '-');
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

      if (!manifest.image_id?.trim()) {
        setCurrentLowerImageId('-');
        setDeliveryStatus('无法确认');
        messageApi.warning('已获取更新清单，但该清单未包含镜像 ID，无法确认目标机是否为最新构建');
        return;
      }

      try {
        const runtime = await api.getLowerUpdateRuntimeInfo({
          upload_account: targetUploadAccount.trim(),
          auth: lowerUpdateAuthMethod === 'password'
            ? { method: 'password', password: targetSshPassword }
            : { method: 'certificate' },
        });
        const actualImageId = runtime.image_id?.trim() || '-';

        if (!runtime.exists) {
          setCurrentLowerImageId('-');
          setDeliveryStatus('无法确认');
          messageApi.warning(`已获取更新清单，但目标机不存在 ${runtime.container_name} 容器`);
          return;
        }
        if (!runtime.running) {
          setCurrentLowerImageId('-');
          setDeliveryStatus('无法确认');
          messageApi.warning(`已获取更新清单，但目标机 ${runtime.container_name} 容器未运行`);
          return;
        }
        if (actualImageId === '-') {
          setCurrentLowerImageId('-');
          setDeliveryStatus('无法确认');
          messageApi.warning('已获取更新清单，但目标机未返回有效的运行镜像 ID');
          return;
        }

        setCurrentLowerImageId(actualImageId);
        if (isSameImageId(manifest.image_id, actualImageId)) {
          setDeliveryStatus('已是最新');
          messageApi.success(`目标机已经运行 ${UPDATE_CHANNEL_LABELS[channel]} 通道的最新构建`);
        } else {
          setDeliveryStatus('发现更新');
          messageApi.info(`发现 ${UPDATE_CHANNEL_LABELS[channel]} 通道的新构建 ${manifest.version}`);
        }
      } catch (error) {
        setCurrentLowerImageId('-');
        setDeliveryStatus('无法确认');
        messageApi.warning(`已获取更新清单，但查询目标机运行镜像失败: ${formatErrorMessage(error)}`);
      }
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

  const verifyRunningImage = async (expectedImageId: string): Promise<'succeeded' | 'mismatch' | 'failed'> => {
    setCurrentLowerImageId('-');
    setExpectedImageId(expectedImageId);
    setActualImageId('-');
    setImageVerifyStage('waiting');
    setImageVerifyMessage('等待下位机容器恢复');
    await sleep(5000);

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      setImageVerifyStage('querying');
      setImageVerifyMessage(`查询运行镜像中 (${attempt}/6)`);

      try {
        const runtime = await api.getLowerUpdateRuntimeInfo({
          upload_account: targetUploadAccount.trim(),
          auth: lowerUpdateAuthMethod === 'password'
            ? { method: 'password', password: targetSshPassword }
            : { method: 'certificate' },
        });
        const runtimeImageId = runtime.image_id?.trim() || '-';
        setActualImageId(runtimeImageId);

        if (!runtime.exists) {
          throw new Error(`未找到 ${runtime.container_name} 容器`);
        }
        if (!runtime.running) {
          throw new Error(`${runtime.container_name} 容器未运行`);
        }
        if (runtimeImageId === '-') {
          throw new Error(`${runtime.container_name} 容器未返回有效的镜像 ID`);
        }

        setCurrentLowerImageId(runtimeImageId);
        if (!isSameImageId(expectedImageId, runtimeImageId)) {
          setImageVerifyStage('mismatch');
          setImageVerifyMessage(`期望 ${expectedImageId}，实际 ${runtimeImageId}`);
          return 'mismatch';
        }

        setImageVerifyStage('succeeded');
        setImageVerifyMessage(`运行镜像已确认: ${runtimeImageId}`);
        return 'succeeded';
      } catch (error) {
        lastError = error;
        if (attempt < 6) {
          await sleep(3000);
        }
      }
    }

    setImageVerifyStage('failed');
    setImageVerifyMessage(formatErrorMessage(lastError));
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
    setCurrentLowerImageId('-');
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

  const runImageVerifyStep = async (): Promise<boolean> => {
    setDeployTaskStep('verifying');
    setDeliveryStatus('镜像确认中');
    setIsVerifyingLowerUpdate(true);

    try {
      const expectedImageId = activeManifest?.image_id?.trim();
      if (!expectedImageId) {
        throw new Error('当前更新清单未包含镜像 ID，无法确认安装结果');
      }
      const verifyResult = await verifyRunningImage(expectedImageId);
      if (verifyResult === 'succeeded') {
        setDeployTaskStep('succeeded');
        setDeliveryStatus('升级完成');
        messageApi.success('下位机运行镜像已确认，升级完成');
        return true;
      }

      if (verifyResult === 'mismatch') {
        setDeployTaskStep('image_mismatch');
        setDeliveryStatus('构建不一致');
        messageApi.error('安装命令已执行，但下位机运行镜像与清单构建不一致');
        return false;
      }

      setDeployTaskStep('verify_failed');
      setDeliveryStatus('镜像确认失败');
      messageApi.error('安装命令已执行，但运行镜像确认失败');
      return false;
    } catch (error) {
      setCurrentLowerImageId('-');
      setImageVerifyStage('failed');
      setImageVerifyMessage(formatErrorMessage(error));
      setDeployTaskStep('verify_failed');
      setDeliveryStatus('镜像确认失败');
      messageApi.error(`运行镜像确认失败: ${formatErrorMessage(error)}`);
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
    if (!activeManifest?.image_id?.trim()) {
      messageApi.warning('当前更新清单未包含镜像 ID，不能执行无法验证结果的安装');
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

    await runImageVerifyStep();
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
      await runImageVerifyStep();
    }
  };

  const handleReverifyImage = async (): Promise<void> => {
    if (!installResult?.success) {
      messageApi.warning('请先完成安装命令');
      return;
    }

    setIsUploadModalOpen(true);
    await runImageVerifyStep();
  };

  const renderAppUpdateCard = (): React.ReactNode => (
    <Card title="上位机更新" size="small" bordered>
      <Descriptions size="small" column={2}>
        <Descriptions.Item label="客户端版本">{appVersion}</Descriptions.Item>
        <Descriptions.Item label="更新状态">
          <Tag color={getAppUpdateTagColor(updateStatus.kind)}>{getAppUpdateTagLabel(updateStatus.kind)}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="可用版本">{availableUpdate?.version || '-'}</Descriptions.Item>
        <Descriptions.Item label="发布时间">{formatReleaseDate(availableUpdate?.date)}</Descriptions.Item>
      </Descriptions>

      <Paragraph
        type={updateStatus.kind === 'error' ? 'danger' : 'secondary'}
        style={{ marginTop: 12, marginBottom: 12 }}
      >
        {updateStatus.message}
      </Paragraph>

      {availableUpdate?.body ? (
        <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>
          {availableUpdate.body}
        </Paragraph>
      ) : null}

      {isInstallingUpdate && appTotalBytes !== null ? (
        <Progress percent={appDownloadPercent} size="small" status="active" style={{ marginBottom: 12 }} />
      ) : null}

      <Space wrap>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => void handleCheckAppUpdate()}
          loading={isCheckingUpdate}
        >
          检查上位机更新
        </Button>
        <Button
          type="primary"
          onClick={() => void handleInstallAppUpdate()}
          disabled={!availableUpdate}
          loading={isInstallingUpdate}
        >
          下载安装
        </Button>
        <Button onClick={() => void handleRelaunchApp()} disabled={updateStatus.kind !== 'ready-to-restart'}>
          重启上位机
        </Button>
      </Space>
    </Card>
  );

  return (
      <>
        {contextHolder}
        <div className="advanced-config-page">
        {activeUpdateTab === 'upper' ? renderAppUpdateCard() : (
          <>

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
                  label="上传账号"
                  validateStatus={targetUploadAccountValidation.ok ? undefined : 'error'}
                  help={targetUploadAccountValidation.ok ? undefined : targetUploadAccountValidation.error}
                >
                  <Input
                    value={targetUploadAccount}
                    disabled={isCheckingLowerUpdate || isDeployingLowerUpdate}
                    onChange={(event) => {
                      setTargetUploadAccount(event.target.value);
                      setTargetSshPassword('');
                      invalidateRuntimeCheck();
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
                    disabled={isCheckingLowerUpdate || isDeployingLowerUpdate}
                    onChange={(value) => {
                      setLowerUpdateAuthMethod(value);
                      invalidateRuntimeCheck();
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
                      disabled={isCheckingLowerUpdate || isDeployingLowerUpdate || isLoadingSavedSshPassword}
                      autoComplete="current-password"
                      onChange={(event) => {
                        setTargetSshPassword(event.target.value);
                        invalidateRuntimeCheck();
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
              <div className="advanced-config-section-title">发布来源</div>
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
                  disabled={hasRuntimeQueryValidationError}
                  loading={isCheckingLowerUpdate}
                >
                  检查更新
                </Button>
                <Button
                  icon={<DownloadOutlined />}
                  onClick={() => void handleDownload()}
                  disabled={
                    !hasCheckedPackage
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
                    hasDeployTargetValidationError
                    || !hasDownloadedPackage
                    || !hasVerifiableManifest
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
              <span>构建与校验</span>
            </Space>
          }
        >
          <Descriptions size="small" column={2}>
            <Descriptions.Item label="当前运行镜像 ID">
              <Text code className="advanced-config-hash">{currentLowerImageId}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="可用镜像 ID">
              <Text code className="advanced-config-hash">{latestLowerImageId}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="安装包名称">{packageName}</Descriptions.Item>
            <Descriptions.Item label="包大小">{packageSize}</Descriptions.Item>
            <Descriptions.Item label="发布时间">{publishedAt}</Descriptions.Item>
            <Descriptions.Item label="下发状态">
              <Tag color={getDeliveryStatusColor(deliveryStatus)}>{deliveryStatus}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="SHA256" span={2}>
              <Text code className="advanced-config-hash">{sha256}</Text>
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
              <Descriptions.Item label="确认目标">mskdsp 容器</Descriptions.Item>
              <Descriptions.Item label="期望镜像 ID">{expectedImageId}</Descriptions.Item>
              <Descriptions.Item label="实际镜像 ID">{actualImageId}</Descriptions.Item>
              <Descriptions.Item label="确认状态">
                <Tag color={getImageVerifyStageTagColor(imageVerifyStage)}>
                  {getImageVerifyStageLabel(imageVerifyStage)}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="确认说明">{imageVerifyMessage}</Descriptions.Item>
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
                onClick={() => void handleReverifyImage()}
                disabled={!canReverifyImage || isDeployingLowerUpdate}
              >
                重新确认镜像
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
            <Text type="secondary">安装命令执行成功后，会自动查询 mskdsp 容器的运行镜像 ID 确认升级结果。</Text>
          </Space>
        </Modal>
          </>
        )}
        </div>
      </>
    );
};

export default AdvancedConfigPage;
