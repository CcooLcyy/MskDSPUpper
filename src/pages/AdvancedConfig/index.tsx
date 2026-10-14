import React, { useState } from 'react';
import {
  AutoComplete,
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
  Switch,
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
  type LowerUpdatePlatform,
  type LowerUpdateCachedPackage,
  type LowerUpdateDownloadProgress,
  type LowerUpdateDownloadResult,
  type LowerUpdateManifest,
  type LowerUpdateRuntimeInfo,
  type LowerUpdateSshAuth,
} from '../../adapters';
import { useAppUpdate, type AppUpdateInstallResult } from '../../components/app-update/app-update-context';
import { useLowerUpdateAuto } from '../../components/lower-update/lower-update-auto-context';
import { useLowerUpdateDeployment } from '../../components/lower-update/lower-update-deployment-context';
import {
  normalizeSoftwareUpdateView,
  SOFTWARE_UPDATE_VIEW_QUERY_KEY,
} from '../../components/app-update/update-view';
import { validateManagerAddress } from '../../utils/network';
import { resolveLowerUpdateSudoPassword } from '../../utils/lower-update-auth';
import {
  cacheAppSetting,
  getAppSetting,
  LOWER_UPDATE_CONNECTION_HISTORY_SETTING_KEY,
} from '../../utils/app-settings';
import { LOWER_UPDATE_CONNECTION_SETTING_KEY } from '../../utils/app-settings-core';
import {
  clearLowerUpdateConnectionHistoryRememberPassword,
  createLowerUpdateCredentialReadGuard,
  lowerUpdateCredentialCoordinator,
  lowerUpdateCredentialAccountKey,
  readLowerUpdateConnectionHistory,
  readLowerUpdateConnectionSettings,
} from '../../utils/lower-update-connection';
import {
  assessLowerUpdateCacheFreshness,
  compareLowerUpdateImages,
  matchesLowerUpdateSelection,
  resolveLowerUpdateDownloadResult,
  type LowerUpdateCacheFreshness,
} from '../../utils/lower-update-deploy';
import { getLowerUpdateChannel, getLowerUpdateChannels } from '../../utils/lower-update-platform';
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
  | '已缓存'
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
const SSH_ACCOUNT_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*)@([^@:]+):(\d+)$/;
const LINUX_ABSOLUTE_PATH_PATTERN = /^\/[^\s]*$/;

const UPDATE_CHANNEL_OPTIONS: Array<{ label: string; value: LowerUpdateChannel }> = [
  { label: 'Stable', value: 'stable' },
  { label: 'Beta', value: 'beta' },
  { label: 'CI', value: 'ci' },
];

const DEFAULT_LOWER_UPDATE_CHANNEL: LowerUpdateChannel = 'ci';
const DEFAULT_LOWER_UPDATE_AUTH_METHOD: LowerUpdateAuthMethod = 'password';
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

function getDeliveryStatusColor(status: string): string {
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
    case '下发前预检失败':
      return 'error';
    case '下载中':
    case '校验中':
    case '上传中':
    case '安装中':
    case '镜像确认中':
    case '下发前预检中':
    case '清理历史安装包中':
    case '已下载到上位机':
      return 'blue';
    case '已上传到下位机':
      return 'blue';
    case '已缓存':
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

function isSameImageId(expectedImageId: string, actualImageId: string): boolean {
  return compareLowerUpdateImages(expectedImageId, actualImageId) === 'same';
}

function formatPublishedAt(value: string): string {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDownloadedAt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '-';
  }

  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function summarizeCachedPackageFreshness(
  onlineManifest: LowerUpdateManifest | null,
  cachedPackages: LowerUpdateCachedPackage[],
): LowerUpdateCacheFreshness {
  if (!onlineManifest) {
    return 'unknown';
  }
  if (cachedPackages.length === 0) {
    return 'unavailable';
  }
  if (cachedPackages.some((cachedPackage) =>
    assessLowerUpdateCacheFreshness(onlineManifest, cachedPackage) === 'current')) {
    return 'current';
  }
  if (cachedPackages.some((cachedPackage) =>
    assessLowerUpdateCacheFreshness(onlineManifest, cachedPackage) === 'stale')) {
    return 'stale';
  }
  return 'unknown';
}

function getCacheFreshnessTag(freshness: LowerUpdateCacheFreshness): { color: string; label: string } {
  switch (freshness) {
    case 'current':
      return { color: 'success', label: '已确认一致' };
    case 'stale':
      return { color: 'warning', label: '已确认落后' };
    case 'unavailable':
      return { color: 'default', label: '无可用缓存' };
    default:
      return { color: 'default', label: '未校验线上版本' };
  }
}

function getCacheFreshnessMessage(
  freshness: LowerUpdateCacheFreshness,
  onlineVersion: string | null,
  checkedAt: number | null,
): string {
  switch (freshness) {
    case 'current':
      return `缓存包与线上最新版本一致（检查于 ${checkedAt ? formatDownloadedAt(checkedAt / 1000) : '-'}）`;
    case 'stale':
      return `缓存版本不是线上最新版本${onlineVersion ? `，线上版本：${onlineVersion}` : ''}`;
    case 'unavailable':
      return '当前没有可用于线上校验的缓存包';
    default:
      return '无法确认线上最新版本，缓存版本可能不是最新';
  }
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
    case 'downloading':
      return 'blue';
    case 'ready-to-install':
      return 'cyan';
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
    case 'downloading':
      return '下载中';
    case 'ready-to-install':
      return '待安装';
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
  const [connectionHistory, setConnectionHistory] = useState(() => readLowerUpdateConnectionHistory(
    getAppSetting(LOWER_UPDATE_CONNECTION_HISTORY_SETTING_KEY),
    getAppSetting(LOWER_UPDATE_CONNECTION_SETTING_KEY),
  ));
  const [savedConnection] = useState(() => connectionHistory[0]
    ?? readLowerUpdateConnectionSettings(getAppSetting(LOWER_UPDATE_CONNECTION_SETTING_KEY)));
  const [connectionHistorySearch, setConnectionHistorySearch] = useState('');
  const [credentialReadRevision, setCredentialReadRevision] = useState(0);
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
  const [targetUploadAccount, setTargetUploadAccount] = useState(savedConnection?.upload_account ?? LOWER_UPDATE_MOCK_TARGET.uploadAccount);
  const [targetInstallDir, setTargetInstallDir] = useState(savedConnection?.install_dir ?? LOWER_UPDATE_MOCK_TARGET.installDir);
  const [targetSshPassword, setTargetSshPassword] = useState('');
  const [reuseSshPasswordForSudo, setReuseSshPasswordForSudo] = useState(savedConnection?.reuse_ssh_password_for_sudo ?? true);
  const [rememberPassword, setRememberPassword] = useState(savedConnection?.remember_password ?? true);
  const [isClearingSavedCredentials, setIsClearingSavedCredentials] = useState(false);
  const credentialReadGuardRef = React.useRef(createLowerUpdateCredentialReadGuard());
  const [targetSudoPassword, setTargetSudoPassword] = useState('');
  const [lowerUpdateAuthMethod, setLowerUpdateAuthMethod] = useState<LowerUpdateAuthMethod>(
    savedConnection?.auth_method ?? DEFAULT_LOWER_UPDATE_AUTH_METHOD,
  );
  const [isCheckingLowerUpdate, setIsCheckingLowerUpdate] = useState(false);
  const [isImportingLocalUpdate, setIsImportingLocalUpdate] = useState(false);
  const [isDownloadingLowerUpdate, setIsDownloadingLowerUpdate] = useState(false);
  const [activeManifest, setActiveManifest] = useState<LowerUpdateManifest | null>(null);
  const [downloadResult, setDownloadResult] = useState<LowerUpdateDownloadResult | null>(null);
  const [cachedPackages, setCachedPackages] = useState<LowerUpdateCachedPackage[]>([]);
  const [cacheFreshness, setCacheFreshness] = useState<LowerUpdateCacheFreshness>('unknown');
  const [onlineLowerUpdateManifest, setOnlineLowerUpdateManifest] = useState<LowerUpdateManifest | null>(null);
  const [onlineLowerUpdateCheckedAt, setOnlineLowerUpdateCheckedAt] = useState<number | null>(null);
  const [isLoadingCachedPackages, setIsLoadingCachedPackages] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const { platform, setPlatform, channels: lowerUpdateAutoChannels, ensureDownloaded } = useLowerUpdateAuto();
  const cacheReadRequestRef = React.useRef(0);
  const lowerUpdateSelectionRef = React.useRef({ platform, channel });
  const deploymentPageMountedRef = React.useRef(true);
  React.useEffect(() => {
    deploymentPageMountedRef.current = true;
    return () => { deploymentPageMountedRef.current = false; };
  }, []);
  const lowerUpdateAutoChannelStatus = lowerUpdateAutoChannels[channel];
  const isSelectingLowerUpdate = isCheckingLowerUpdate || isImportingLocalUpdate;
  const isLocalPackageSelected = activeManifest?.local_import === true;
  const isDownloadTaskActive = isDownloadingLowerUpdate || (!isLocalPackageSelected && lowerUpdateAutoChannelStatus.kind === 'downloading');
  const autoDownloadProgress = !isLocalPackageSelected ? lowerUpdateAutoChannelStatus.progress : null;
  const effectiveDownloadedBytes = autoDownloadProgress?.downloaded_bytes ?? downloadedBytes;
  const effectiveDownloadTotalBytes = autoDownloadProgress?.total_bytes || downloadTotalBytes;
  const effectiveDownloadResult = resolveLowerUpdateDownloadResult(
    activeManifest, downloadResult, lowerUpdateAutoChannelStatus.manifest, lowerUpdateAutoChannelStatus.downloadResult,
  );
  const [isLoadingSavedSshPassword, setIsLoadingSavedSshPassword] = useState(false);
  const {
    appVersion,
    availableUpdate,
    downloadedVersion,
    supersededUpdate,
    updateStatus,
    isCheckingUpdate,
    isDownloadingUpdate,
    isInstallingUpdate,
    isUpdateDownloaded,
    downloadedBytes: appDownloadedBytes,
    totalBytes: appTotalBytes,
    checkForUpdate,
    installUpdate,
    installDownloadedUpdate,
    acceptLatestUpdate,
    relaunchAfterUpdate,
  } = useAppUpdate();
  const targetUploadAccountValidation = validateUploadAccount(targetUploadAccount);
  const targetInstallDirValidation = validateInstallDir(targetInstallDir);
  const hasSshPasswordValidationError = lowerUpdateAuthMethod === 'password' && targetSshPassword.length === 0;
  const resolvedSudoPassword = resolveLowerUpdateSudoPassword({
    sshAuthMethod: lowerUpdateAuthMethod,
    sshPassword: targetSshPassword,
    reuseSshPassword: reuseSshPasswordForSudo,
    sudoPassword: targetSudoPassword,
  });
  const hasSudoPasswordValidationError = resolvedSudoPassword.length === 0;
  const hasRuntimeQueryValidationError =
    !targetUploadAccountValidation.ok || hasSshPasswordValidationError || hasSudoPasswordValidationError;
  const hasDeployTargetValidationError = hasRuntimeQueryValidationError || !targetInstallDirValidation.ok;
  const hasCheckedPackage = matchesLowerUpdateSelection(activeManifest, platform, channel);
  const hasVerifiableManifest = hasCheckedPackage && Boolean(activeManifest?.image_id?.trim());
  const hasDownloadedPackage = effectiveDownloadResult !== null;
  const {
    task: deploymentTask,
    isRunning: isDeployingLowerUpdate,
    start: startDeployment,
    openDetails: openDeploymentDetails,
  } = useLowerUpdateDeployment();
  // 只把同一目标与构建的任务结果用于当前表单，其他任务仍在独立入口展示。
  const hasCurrentDeploymentTask = Boolean(deploymentTask && activeManifest
    && lowerUpdateCredentialAccountKey(deploymentTask.uploadAccount) === lowerUpdateCredentialAccountKey(targetUploadAccount)
    && deploymentTask.installDir === (targetInstallDir.trim().replace(/\/+$/, '') || '/')
    && deploymentTask.packageName === activeManifest.asset.name
    && deploymentTask.version === activeManifest.version
    && isSameImageId(deploymentTask.expectedImageId, activeManifest.image_id ?? ''));
  const displayedLowerImageId = hasCurrentDeploymentTask ? deploymentTask!.actualImageId : currentLowerImageId;
  const displayedDeliveryStatus = hasCurrentDeploymentTask ? deploymentTask!.status : deliveryStatus;
  const appDownloadPercent =
    appTotalBytes && appTotalBytes > 0 ? Math.min(100, Math.round((appDownloadedBytes / appTotalBytes) * 100)) : 0;

  const refreshCachedLowerUpdates = React.useCallback(async (): Promise<void> => {
    const requestId = ++cacheReadRequestRef.current;
    setIsLoadingCachedPackages(true);
    try {
      const packages = await api.listCachedLowerUpdates(channel, platform);
      if (requestId !== cacheReadRequestRef.current) return;
      setCachedPackages(packages.filter((item) => matchesLowerUpdateSelection(item.manifest, platform, channel)));
    } catch (error) {
      if (requestId !== cacheReadRequestRef.current) return;
      setCachedPackages([]);
      messageApi.warning(`读取已缓存下位机更新包失败: ${formatErrorMessage(error)}`);
    } finally {
      if (requestId === cacheReadRequestRef.current) setIsLoadingCachedPackages(false);
    }
  }, [channel, platform, messageApi]);

  React.useEffect(() => {
    void refreshCachedLowerUpdates();
    return () => { cacheReadRequestRef.current += 1; };
  }, [refreshCachedLowerUpdates]);

  React.useEffect(() => {
    if (activeManifest?.local_import || isImportingLocalUpdate) return;
    const autoManifest = lowerUpdateAutoChannelStatus.manifest;
    if (!autoManifest || !matchesLowerUpdateSelection(autoManifest, platform, channel)) {
      return;
    }
    if (activeManifest
      && activeManifest.asset.sha256.toLowerCase() !== autoManifest.asset.sha256.toLowerCase()) {
      return;
    }
    applyLowerUpdateManifest(autoManifest);
    setActiveManifest(autoManifest);
    const autoProgress = lowerUpdateAutoChannelStatus.progress;
    if (autoProgress) {
      setDownloadStage(autoProgress.stage);
      setDownloadModalProgress(autoProgress.percent);
      setDownloadedBytes(autoProgress.downloaded_bytes);
      setDownloadTotalBytes(autoProgress.total_bytes || autoManifest.asset.size);
      setDeliveryStatus(autoProgress.stage === 'verifying' ? '校验中' : '下载中');
    }
    const restoredResult = lowerUpdateAutoChannelStatus.downloadResult;
    const restoredPackage = lowerUpdateAutoChannelStatus.cachedPackage;
    if (restoredPackage) {
      setCachedPackages((previous) => previous.some((item) => item.package_path === restoredPackage.package_path)
        ? previous
        : [...previous, restoredPackage]);
    }
    if (restoredResult && restoredResult.package_path !== downloadedPackagePath) {
      setDownloadResult(restoredResult);
      setDownloadedPackagePath(restoredResult.package_path);
      setDownloadedPackageSha256(restoredResult.sha256);
      setDownloadedBytes(restoredResult.downloaded_bytes);
      setDownloadTotalBytes(autoManifest.asset.size);
      setDownloadModalProgress(100);
      setDownloadStage('finished');
      setDeliveryStatus('已缓存');
    }
  }, [activeManifest, downloadedPackagePath, lowerUpdateAutoChannelStatus, platform, channel, isImportingLocalUpdate]);

  React.useEffect(() => {
    setCacheFreshness(summarizeCachedPackageFreshness(onlineLowerUpdateManifest, cachedPackages));
  }, [cachedPackages, onlineLowerUpdateManifest]);

  React.useEffect(() => {
    if (lowerUpdateAutoChannelStatus.downloadResult) {
      void refreshCachedLowerUpdates();
    }
  }, [lowerUpdateAutoChannelStatus.downloadResult, refreshCachedLowerUpdates]);

  React.useEffect(() => {
    if (!rememberPassword || !targetUploadAccountValidation.ok) {
      setIsLoadingSavedSshPassword(false);
      return;
    }
    let cancelled = false;
    const guard = credentialReadGuardRef.current;
    const token = guard.begin();
    setIsLoadingSavedSshPassword(true);
    void api.getLowerUpdateCredentials(targetUploadAccount.trim())
      .then((credentials) => {
        if (cancelled) return;
        if (lowerUpdateAuthMethod === 'password' && credentials.ssh_password !== null && guard.canApply(token, 'ssh')) {
          setTargetSshPassword((current) => current || credentials.ssh_password || '');
        }
        if ((lowerUpdateAuthMethod === 'certificate' || !reuseSshPasswordForSudo)
          && credentials.sudo_password !== null && guard.canApply(token, 'sudo')) {
          setTargetSudoPassword((current) => current || credentials.sudo_password || '');
        }
      })
      .catch(() => {
        if (!cancelled) messageApi.warning('读取已保存密码失败，请手动输入');
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingSavedSshPassword(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [credentialReadRevision, lowerUpdateAuthMethod, targetUploadAccount, rememberPassword, reuseSshPasswordForSudo, targetUploadAccountValidation.ok, messageApi]);

  const handleClearSavedCredentials = async (): Promise<void> => {
    if (isDeployingLowerUpdate || isCheckingLowerUpdate || isClearingSavedCredentials) return;
    const account = targetUploadAccount.trim();
    credentialReadGuardRef.current.invalidate();
    lowerUpdateCredentialCoordinator.revoke(account);
    setRememberPassword(false);
    setTargetSshPassword('');
    setTargetSudoPassword('');
    invalidateRuntimeCheck();
    setIsClearingSavedCredentials(true);
    try {
      await lowerUpdateCredentialCoordinator.run(account, async () => {
        await api.clearLowerUpdateCredentials(account);
        const history = clearLowerUpdateConnectionHistoryRememberPassword(readLowerUpdateConnectionHistory(
          getAppSetting(LOWER_UPDATE_CONNECTION_HISTORY_SETTING_KEY),
          getAppSetting(LOWER_UPDATE_CONNECTION_SETTING_KEY),
        ), account);
        cacheAppSetting(LOWER_UPDATE_CONNECTION_HISTORY_SETTING_KEY, history);
        if (deploymentPageMountedRef.current) setConnectionHistory(history);
        const previous = readLowerUpdateConnectionSettings(getAppSetting(LOWER_UPDATE_CONNECTION_SETTING_KEY));
        if (previous && lowerUpdateCredentialAccountKey(previous.upload_account) === lowerUpdateCredentialAccountKey(account)) {
          cacheAppSetting(LOWER_UPDATE_CONNECTION_SETTING_KEY, { ...previous, remember_password: false });
        }
      });
      messageApi.success('已清除当前目标保存的密码，并关闭记住密码');
    } catch {
      messageApi.warning('清除已保存密码失败，请重试；记住密码已关闭');
    } finally {
      setIsClearingSavedCredentials(false);
    }
  };

  const handleSelectConnectionHistory = (account: string): void => {
    const connection = connectionHistory.find((item) => item.upload_account === account);
    if (!connection) return;
    credentialReadGuardRef.current.invalidate();
    lowerUpdateCredentialCoordinator.revoke(targetUploadAccount);
    setTargetSshPassword('');
    setTargetSudoPassword('');
    setTargetUploadAccount(connection.upload_account);
    setTargetInstallDir(connection.install_dir);
    setLowerUpdateAuthMethod(connection.auth_method);
    setReuseSshPasswordForSudo(connection.reuse_ssh_password_for_sudo);
    setRememberPassword(connection.remember_password);
    setCredentialReadRevision((revision) => revision + 1);
    setConnectionHistorySearch('');
    invalidateRuntimeCheck();
  };

  const handleCheckAppUpdate = async (): Promise<void> => {
    try {
      const update = await checkForUpdate();
      messageApi.success(update ? `发现客户端新版本 ${update.version}` : '当前客户端已经是最新版本');
    } catch (error) {
      messageApi.error(`检查更新失败: ${error}`);
    }
  };

  const reportAppInstallResult = (result: AppUpdateInstallResult): void => {
    if (result.kind === 'installed') {
      messageApi.success(`客户端 ${result.update.version} 已安装完成`);
      return;
    }

    messageApi.warning(`已下载 ${result.downloaded.version}，通道已有 ${result.latest.version}，请选择要安装的版本`);
  };

  const handleInstallAppUpdate = async (): Promise<void> => {
    try {
      reportAppInstallResult(await installUpdate());
    } catch (error) {
      messageApi.error(`安装客户端更新失败: ${error}`);
    }
  };

  const handleInstallDownloadedAppUpdate = async (): Promise<void> => {
    try {
      reportAppInstallResult(await installDownloadedUpdate());
    } catch (error) {
      messageApi.error(`安装客户端更新失败: ${error}`);
    }
  };

  const handleAcceptLatestAppUpdate = async (): Promise<void> => {
    try {
      reportAppInstallResult(await acceptLatestUpdate());
    } catch (error) {
      messageApi.error(`下载并安装最新客户端更新失败: ${error}`);
    }
  };

  const handleRelaunchApp = async (): Promise<void> => {
    try {
      await relaunchAfterUpdate();
    } catch (error) {
      messageApi.error(`重启客户端失败: ${error}`);
    }
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
    setActiveManifest(null);
    setDownloadResult(null);
    setCacheFreshness('unknown');
    setOnlineLowerUpdateManifest(null);
    setOnlineLowerUpdateCheckedAt(null);
  };

  const invalidateRuntimeCheck = (): void => {
    setCurrentLowerImageId('-');
    setDeliveryStatus(downloadResult ? '已下载到上位机' : '未检查');
  };

  const applyLowerUpdateManifest = (manifest: LowerUpdateManifest): void => {
    setLatestLowerImageId(manifest.image_id?.trim() || '-');
    setPackageName(manifest.asset.name);
    setPackageSize(formatPackageSize(manifest.asset.size));
    setPublishedAt(formatPublishedAt(manifest.published_at));
    setSha256(manifest.asset.sha256);
  };

  const applyCachedPackage = (cachedPackage: LowerUpdateCachedPackage): LowerUpdateDownloadResult => {
    const restoredDownloadResult: LowerUpdateDownloadResult = {
      package_name: cachedPackage.manifest.asset.name,
      package_path: cachedPackage.package_path,
      downloaded_bytes: cachedPackage.package_size,
      sha256: cachedPackage.sha256,
    };
    applyLowerUpdateManifest(cachedPackage.manifest);
    setActiveManifest(cachedPackage.manifest);
    setDownloadResult(restoredDownloadResult);
    setDownloadedPackagePath(cachedPackage.package_path);
    setDownloadedPackageSha256(cachedPackage.sha256);
    setDownloadedBytes(cachedPackage.package_size);
    setDownloadTotalBytes(cachedPackage.manifest.asset.size);
    setDownloadModalProgress(100);
    setDownloadStage('finished');
    setDeliveryStatus('已缓存');
    return restoredDownloadResult;
  };

  const handleImportLocalUpdate = async (): Promise<void> => {
    setIsImportingLocalUpdate(true);
    try {
      const imported = await api.importLocalLowerUpdate();
      if (!imported || !deploymentPageMountedRef.current) return;
      const importedPlatform = imported.manifest.platform as LowerUpdatePlatform;
      if (!imported.manifest.local_import || !getLowerUpdateChannels(importedPlatform).includes(imported.manifest.channel)) {
        throw new Error('导入结果缺少本地来源或有效架构');
      }
      cacheReadRequestRef.current += 1;
      setIsLoadingCachedPackages(false);
      lowerUpdateSelectionRef.current = { platform: importedPlatform, channel: imported.manifest.channel };
      setPlatform(importedPlatform);
      setChannel(imported.manifest.channel);
      resetUpdateState();
      setCachedPackages((previous) => [imported, ...previous.filter((item) =>
        item.package_path !== imported.package_path
        && matchesLowerUpdateSelection(item.manifest, importedPlatform, imported.manifest.channel))]);
      applyCachedPackage(imported);
      console.info('已选择本地下位机安装包', { version: imported.manifest.version, platform: importedPlatform, sha256: imported.sha256 });
      messageApi.success(`已导入本地版本 ${imported.manifest.version}，可点击下发并安装`);
    } catch (error) {
      if (!deploymentPageMountedRef.current) return;
      console.warn('导入本地下位机安装包失败', formatErrorMessage(error));
      messageApi.error(`导入失败: ${formatErrorMessage(error)}`);
    } finally {
      if (deploymentPageMountedRef.current) setIsImportingLocalUpdate(false);
    }
  };

  const queryLowerUpdateRuntimeInfo = async (): Promise<LowerUpdateRuntimeInfo> => api.getLowerUpdateRuntimeInfo({
    upload_account: targetUploadAccount.trim(),
    auth: lowerUpdateAuthMethod === 'password'
      ? { method: 'password', password: targetSshPassword }
      : { method: 'certificate' },
    sudo_password: resolvedSudoPassword,
  });

  const handleCheckUpdate = async (): Promise<void> => {
    setIsCheckingLowerUpdate(true);
    setCacheFreshness('unknown');
    setOnlineLowerUpdateManifest(null);
    setOnlineLowerUpdateCheckedAt(null);
    try {
      const manifest = await api.checkLowerUpdate(channel, platform);
      if (!matchesLowerUpdateSelection(manifest, platform, channel)) {
        throw new Error('更新清单与所选架构或通道不一致');
      }
      applyLowerUpdateManifest(manifest);
      setActiveManifest(manifest);
      setOnlineLowerUpdateManifest(manifest);
      setOnlineLowerUpdateCheckedAt(Date.now());
      const nextCacheFreshness = summarizeCachedPackageFreshness(manifest, cachedPackages);
      setCacheFreshness(nextCacheFreshness);
      if (nextCacheFreshness === 'stale') {
        messageApi.warning(`本地缓存版本不是线上最新版本，线上版本为 ${manifest.version}`);
      } else if (nextCacheFreshness === 'unknown' && cachedPackages.length > 0) {
        messageApi.warning('无法确认本地缓存是否为线上最新版本');
      }
      const matchingCachedPackage = cachedPackages.find((cachedPackage) =>
        assessLowerUpdateCacheFreshness(manifest, cachedPackage) === 'current');
      if (matchingCachedPackage) {
        applyCachedPackage(matchingCachedPackage);
        messageApi.info('已找到相同的本地缓存包，可直接下发');
      } else if (lowerUpdateAutoChannelStatus.manifest
        && lowerUpdateAutoChannelStatus.manifest.asset.sha256.toLowerCase() === manifest.asset.sha256.toLowerCase()
        && lowerUpdateAutoChannelStatus.downloadResult) {
        setDownloadResult(lowerUpdateAutoChannelStatus.downloadResult);
        setDownloadedPackagePath(lowerUpdateAutoChannelStatus.downloadResult.package_path);
        setDownloadedPackageSha256(lowerUpdateAutoChannelStatus.downloadResult.sha256);
        setDownloadedBytes(lowerUpdateAutoChannelStatus.downloadResult.downloaded_bytes);
        setDownloadTotalBytes(manifest.asset.size);
        setDownloadModalProgress(100);
        setDownloadStage('finished');
        setDeliveryStatus('已缓存');
      } else if (lowerUpdateAutoChannelStatus.manifest
        && lowerUpdateAutoChannelStatus.manifest.asset.sha256.toLowerCase() === manifest.asset.sha256.toLowerCase()
        && lowerUpdateAutoChannelStatus.kind === 'downloading') {
        setDownloadTotalBytes(manifest.asset.size);
      } else {
        setDownloadResult(null);
        setDownloadedPackagePath('-');
        setDownloadedPackageSha256('-');
        setDownloadStage('idle');
        setDownloadModalProgress(0);
        setDownloadedBytes(0);
        setDownloadTotalBytes(manifest.asset.size);
      }

      if (!manifest.image_id?.trim()) {
        setCurrentLowerImageId('-');
        setDeliveryStatus('无法确认');
        messageApi.warning('已获取更新清单，但该清单未包含镜像 ID，无法确认目标机是否为最新构建');
        return;
      }

      try {
        const runtime = await queryLowerUpdateRuntimeInfo();
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
      setCacheFreshness('unknown');
      setOnlineLowerUpdateManifest(null);
      setOnlineLowerUpdateCheckedAt(null);
      setDeliveryStatus('检查失败');
      messageApi.error(`检查更新失败: ${formatLowerUpdateCheckError(channel, error)}`);
    } finally {
      setIsCheckingLowerUpdate(false);
    }
  };

  const handleDownload = async (): Promise<void> => {
    if (activeManifest?.local_import) {
      messageApi.info('本地安装包已导入，无需下载');
      return;
    }
    if (!activeManifest) {
      messageApi.warning('请先检查更新');
      return;
    }
    if (!matchesLowerUpdateSelection(activeManifest, platform, channel)) {
      messageApi.warning('更新包与所选架构或通道不一致，请重新检查更新');
      return;
    }
    const downloadingManifest = activeManifest;

    setIsDownloadModalOpen(true);
    setIsDownloadingLowerUpdate(true);
    setDownloadStage('started');
    setDownloadModalProgress(0);
    setDownloadedBytes(0);
    setDownloadTotalBytes(activeManifest.asset.size);
    setDownloadedPackagePath('-');
    setDownloadedPackageSha256('-');
    setDownloadResult(null);
    setDeliveryStatus('下载中');

    try {
      const result = await ensureDownloaded(downloadingManifest);
      setDownloadResult(result);
      setDownloadedPackagePath(result.package_path);
      setDownloadedPackageSha256(result.sha256);
      setDownloadedBytes(result.downloaded_bytes);
      setDownloadTotalBytes(activeManifest.asset.size);
      setDownloadModalProgress(100);
      setDownloadStage('finished');
      setDeliveryStatus('已下载到上位机');
      if (onlineLowerUpdateManifest) {
        setCacheFreshness(assessLowerUpdateCacheFreshness(onlineLowerUpdateManifest, {
          manifest: downloadingManifest,
          sha256: result.sha256,
        }));
      }
      void refreshCachedLowerUpdates();
      messageApi.success('下位机更新包已下载并校验通过');
    } catch (error) {
      setDownloadStage('failed');
      setDeliveryStatus('下载失败');
      messageApi.error(`下载失败: ${formatErrorMessage(error)}`);
    } finally {
      setIsDownloadingLowerUpdate(false);
    }
  };

  const closeDownloadModal = (): void => {
    if (isDownloadTaskActive) {
      console.info('下位机更新下载已切换到后台运行');
    }
    setIsDownloadModalOpen(false);
  };

  const runDeployFlow = async ({
    cachedPackage,
  }: { cachedPackage?: LowerUpdateCachedPackage } = {}): Promise<void> => {
    if (!deploymentPageMountedRef.current) return;
    if (isDeployingLowerUpdate) {
      openDeploymentDetails();
      return;
    }
    const selectedManifest = cachedPackage?.manifest ?? activeManifest;
    const selectedDownloadResult = cachedPackage
      ? {
          package_name: cachedPackage.manifest.asset.name,
          package_path: cachedPackage.package_path,
          downloaded_bytes: cachedPackage.package_size,
          sha256: cachedPackage.sha256,
        }
      : effectiveDownloadResult;
    if (!selectedDownloadResult) {
      messageApi.warning('请先下载到上位机');
      return;
    }
    if (!selectedManifest?.image_id?.trim()) {
      messageApi.warning('当前更新清单未包含镜像 ID，不能执行无法验证结果的安装');
      return;
    }
    const selection = lowerUpdateSelectionRef.current;
    if (!matchesLowerUpdateSelection(selectedManifest, selection.platform, selection.channel)) {
      messageApi.error('更新包与所选架构或通道不一致，已停止下发');
      return;
    }
    if (hasDeployTargetValidationError) {
      messageApi.warning('请补全有效的目标地址、安装目录和认证信息');
      return;
    }
    if (cachedPackage) applyCachedPackage(cachedPackage);
    try {
      // 全局任务在首次等待之前固定目标与包文件，后续步骤不依赖页面生命周期。
      await startDeployment({
        manifest: selectedManifest,
        packageResult: selectedDownloadResult,
        connection: {
          upload_account: targetUploadAccount.trim(),
          install_dir: targetInstallDir.trim(),
          auth: lowerUpdateAuthMethod === 'password'
            ? { method: 'password', password: targetSshPassword }
            : { method: 'certificate' },
          sudo_password: resolvedSudoPassword,
        },
        reuseSshPasswordForSudo,
        rememberPassword,
      });
      if (deploymentPageMountedRef.current) {
        setConnectionHistory(readLowerUpdateConnectionHistory(
          getAppSetting(LOWER_UPDATE_CONNECTION_HISTORY_SETTING_KEY),
          getAppSetting(LOWER_UPDATE_CONNECTION_SETTING_KEY),
        ));
      }
    } catch (error) {
      if (deploymentPageMountedRef.current) messageApi.error(`无法开始下发安装: ${formatErrorMessage(error)}`);
    }
  };

  const handleDeployPackage = async (): Promise<void> => {
    await runDeployFlow();
  };

  const handleDeployCachedPackage = async (cachedPackage: LowerUpdateCachedPackage): Promise<void> => {
    const cachedFreshness = !cachedPackage.manifest.local_import && onlineLowerUpdateManifest
      ? assessLowerUpdateCacheFreshness(onlineLowerUpdateManifest, cachedPackage)
      : 'unknown';
    const freshnessMessage = cachedPackage.manifest.local_import ? '将安装指定的本地导入版本' : getCacheFreshnessMessage(
      cachedFreshness,
      onlineLowerUpdateManifest?.version ?? null,
      onlineLowerUpdateCheckedAt,
    );
    Modal.confirm({
      title: `下发已缓存版本 ${cachedPackage.manifest.version}`,
      content: `${freshnessMessage}。该操作不会检查线上最新版本，将按缓存的指定版本下发。确认继续吗？`,
      okText: '继续下发',
      cancelText: '取消',
      onOk: () => runDeployFlow({ cachedPackage }),
    });
  };

  const renderAppUpdateCard = (): React.ReactNode => (
    <Card title="上位机更新" size="small" bordered>
      <Descriptions size="small" column={2}>
        <Descriptions.Item label="客户端版本">{appVersion}</Descriptions.Item>
        <Descriptions.Item label="更新状态">
          <Tag color={getAppUpdateTagColor(updateStatus.kind)}>{getAppUpdateTagLabel(updateStatus.kind)}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="可用版本">{availableUpdate?.version || '-'}</Descriptions.Item>
        <Descriptions.Item label="已下载版本">{downloadedVersion || '-'}</Descriptions.Item>
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

      {supersededUpdate && downloadedVersion ? (
        <Paragraph type="warning" style={{ marginBottom: 12 }}>
          {`安装前检查发现通道已有 ${supersededUpdate.version}，晚于已下载的 ${downloadedVersion}。请选择仍安装已下载的版本，或改为下载并安装通道最新版本。`}
        </Paragraph>
      ) : null}

      {isDownloadingUpdate && appTotalBytes !== null ? (
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
          disabled={!isUpdateDownloaded || isDownloadingUpdate}
          loading={isInstallingUpdate}
        >
          安装更新
        </Button>
        <Button onClick={() => void handleRelaunchApp()} disabled={updateStatus.kind !== 'ready-to-restart'}>
          重启上位机
        </Button>
      </Space>

      {supersededUpdate && downloadedVersion ? (
        <Space wrap style={{ marginTop: 12 }}>
          <Button onClick={() => void handleInstallDownloadedAppUpdate()} loading={isInstallingUpdate}>
            {`仍安装已下载的 ${downloadedVersion}`}
          </Button>
          <Button type="primary" onClick={() => void handleAcceptLatestAppUpdate()} loading={isInstallingUpdate}>
            {`改为下载并安装 ${supersededUpdate.version}`}
          </Button>
        </Space>
      ) : null}
    </Card>
  );

  const cacheFreshnessTag = getCacheFreshnessTag(cacheFreshness);

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
                  extra="可输入新账号，或从下拉列表选择最近成功下发的地址"
                >
                  <AutoComplete
                    value={targetUploadAccount}
                    style={{ width: '100%' }}
                    options={connectionHistory
                      .filter((item) => item.upload_account.toLowerCase().includes(connectionHistorySearch.toLowerCase()))
                      .map((item) => ({ value: item.upload_account }))}
                    filterOption={false}
                    onFocus={() => {
                      setConnectionHistorySearch('');
                      setConnectionHistory(readLowerUpdateConnectionHistory(
                        getAppSetting(LOWER_UPDATE_CONNECTION_HISTORY_SETTING_KEY),
                        getAppSetting(LOWER_UPDATE_CONNECTION_SETTING_KEY),
                      ));
                    }}
                    onSearch={setConnectionHistorySearch}
                    onSelect={handleSelectConnectionHistory}
                    disabled={isSelectingLowerUpdate || isDeployingLowerUpdate || isClearingSavedCredentials}
                    onChange={(value) => {
                      credentialReadGuardRef.current.invalidate();
                      lowerUpdateCredentialCoordinator.revoke(targetUploadAccount);
                      setTargetUploadAccount(value);
                      setTargetSshPassword('');
                      setTargetSudoPassword('');
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
                    disabled={isSelectingLowerUpdate || isDeployingLowerUpdate || isClearingSavedCredentials}
                    onChange={(value) => {
                      credentialReadGuardRef.current.invalidate();
                      lowerUpdateCredentialCoordinator.revoke(targetUploadAccount);
                      setTargetSshPassword('');
                      setTargetSudoPassword('');
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
                      disabled={isSelectingLowerUpdate || isDeployingLowerUpdate || isClearingSavedCredentials}
                      autoComplete="off"
                      onChange={(event) => {
                        credentialReadGuardRef.current.markEdited('ssh');
                        setTargetSshPassword(event.target.value);
                        invalidateRuntimeCheck();
                      }}
                      placeholder="请输入 SSH 登录密码"
                    />
                  </Form.Item>
                ) : null}
                <Form.Item label="sudo 密码">
                  <Space>
                    <Switch
                      checked={lowerUpdateAuthMethod === 'password' && reuseSshPasswordForSudo}
                      disabled={
                        lowerUpdateAuthMethod === 'certificate'
                        || isSelectingLowerUpdate
                        || isDeployingLowerUpdate
                        || isClearingSavedCredentials
                      }
                      onChange={(checked) => {
                        credentialReadGuardRef.current.markEdited('sudo');
                        lowerUpdateCredentialCoordinator.revoke(targetUploadAccount);
                        setTargetSudoPassword('');
                        setReuseSshPasswordForSudo(checked);
                        invalidateRuntimeCheck();
                      }}
                    />
                    <Text>与 SSH 密码相同</Text>
                  </Space>
                </Form.Item>
                {lowerUpdateAuthMethod === 'certificate' || !reuseSshPasswordForSudo ? (
                  <Form.Item
                    label="独立 sudo 密码"
                    required
                    validateStatus={hasSudoPasswordValidationError ? 'error' : undefined}
                    help={hasSudoPasswordValidationError ? '请输入 sudo 密码' : undefined}
                  >
                    <Input.Password
                      value={targetSudoPassword}
                      disabled={isSelectingLowerUpdate || isDeployingLowerUpdate || isClearingSavedCredentials}
                      autoComplete="off"
                      onChange={(event) => {
                        credentialReadGuardRef.current.markEdited('sudo');
                        setTargetSudoPassword(event.target.value);
                        invalidateRuntimeCheck();
                      }}
                      placeholder="请输入 sudo 密码"
                    />
                  </Form.Item>
                ) : null}
                <Form.Item label="记住密码" extra="成功下发后保存连接信息。密码由 Windows 凭据管理器加密保存，仅供当前 Windows 用户使用。">
                  <Space wrap>
                    <Switch
                      checked={rememberPassword}
                      disabled={isSelectingLowerUpdate || isDeployingLowerUpdate || isClearingSavedCredentials}
                      onChange={(checked) => {
                        credentialReadGuardRef.current.invalidate();
                        lowerUpdateCredentialCoordinator.revoke(targetUploadAccount);
                        setRememberPassword(checked);
                        setTargetSshPassword('');
                        setTargetSudoPassword('');
                        invalidateRuntimeCheck();
                      }}
                    />
                    <Text>记住 SSH 和独立 sudo 密码</Text>
                    <Button
                      size="small"
                      loading={isClearingSavedCredentials}
                      disabled={!targetUploadAccountValidation.ok || isSelectingLowerUpdate || isDeployingLowerUpdate}
                      onClick={() => void handleClearSavedCredentials()}
                    >清除已保存密码</Button>
                    {isLoadingSavedSshPassword ? <Text type="secondary">正在读取已保存密码…</Text> : null}
                  </Space>
                </Form.Item>
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
                <Form.Item label="目标架构">
                  <Select<LowerUpdatePlatform>
                    value={platform}
                    options={[
                      { label: 'ARM64（默认）', value: 'linux-arm64' },
                      { label: 'x64', value: 'linux-x64' },
                    ]}
                    disabled={isSelectingLowerUpdate || isDownloadTaskActive || isDeployingLowerUpdate}
                    onChange={(value) => {
                      cacheReadRequestRef.current += 1;
                      const nextChannel = getLowerUpdateChannel(value, channel);
                      lowerUpdateSelectionRef.current = { platform: value, channel: nextChannel };
                      setChannel(nextChannel);
                      setPlatform(value);
                      setCachedPackages([]);
                      resetUpdateState();
                      console.info('已切换下位机更新目标架构', { platform: value });
                    }}
                  />
                </Form.Item>
                <Form.Item label="版本来源">
                  <Select<LowerUpdateChannel | 'local'>
                    value={isLocalPackageSelected ? 'local' : channel}
                    options={[
                      ...(isLocalPackageSelected ? [{ label: '本地安装包', value: 'local' as const }] : []),
                      ...UPDATE_CHANNEL_OPTIONS.filter((option) => getLowerUpdateChannels(platform).includes(option.value)),
                    ]}
                    disabled={isSelectingLowerUpdate || isDownloadTaskActive || isDeployingLowerUpdate}
                    onChange={(value) => {
                      if (value === 'local') return;
                      cacheReadRequestRef.current += 1;
                      lowerUpdateSelectionRef.current = { platform, channel: value };
                      setChannel(value);
                      setCachedPackages([]);
                      resetUpdateState();
                      if (value === channel) void refreshCachedLowerUpdates();
                    }}
                  />
                </Form.Item>
              </Form>
              <Text type="secondary">
                {platform === 'linux-x64'
                  ? 'x64 目前仅提供 CI 通道安装包，适用于 x64 服务器。'
                  : 'ARM64 适用于 ARM 下位机设备。'}
                可从所选架构的静态源下载，也可导入本地 mskdsp-版本 安装包，再手动下发到下位机。
              </Text>
              <div className="advanced-config-cached-package">
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space wrap>
                    <Text strong>已缓存版本
                      {isLoadingCachedPackages ? ' (读取中)' : ''}
                    </Text>
                    <Tag color={cachedPackages.length > 0 ? 'blue' : 'default'}>
                      {isLoadingCachedPackages
                        ? '正在读取缓存'
                        : isDownloadTaskActive
                          ? '后台下载中'
                          : cachedPackages.length > 0
                            ? `可用 ${cachedPackages.length} 个`
                            : '无可用缓存'}
                    </Tag>
                    {cachedPackages.length > 0 ? (
                      <Tag color={cacheFreshnessTag.color}>{cacheFreshnessTag.label}</Tag>
                    ) : null}
                  </Space>
                  {cachedPackages.map((cachedPackage) => {
                    const cachedFreshness = !cachedPackage.manifest.local_import && onlineLowerUpdateManifest
                      ? assessLowerUpdateCacheFreshness(onlineLowerUpdateManifest, cachedPackage)
                      : 'unknown';
                    return (
                      <div className="advanced-config-cached-package-item" key={cachedPackage.package_path}>
                        <Descriptions size="small" column={2}>
                          <Descriptions.Item label="版本">{cachedPackage.manifest.version}</Descriptions.Item>
                          <Descriptions.Item label="来源">{cachedPackage.manifest.local_import ? '本地导入' : UPDATE_CHANNEL_LABELS[cachedPackage.manifest.channel]}</Descriptions.Item>
                          <Descriptions.Item label="安装包">{cachedPackage.manifest.asset.name}</Descriptions.Item>
                          <Descriptions.Item label="下载时间">{formatDownloadedAt(cachedPackage.downloaded_at)}</Descriptions.Item>
                          <Descriptions.Item label="镜像 ID" span={2}>
                            <Text code className="advanced-config-hash">{cachedPackage.manifest.image_id}</Text>
                          </Descriptions.Item>
                          <Descriptions.Item label="SHA256" span={2}>
                            <Text code className="advanced-config-hash">{cachedPackage.sha256}</Text>
                          </Descriptions.Item>
                        </Descriptions>
                        <Space wrap>
                          <Button
                            type="primary"
                            icon={<UploadOutlined />}
                            onClick={() => void handleDeployCachedPackage(cachedPackage)}
                            disabled={
                              hasDeployTargetValidationError
                              || isSelectingLowerUpdate
                              || isDownloadTaskActive
                              || isDeployingLowerUpdate
                            }
                          >
                            下发此缓存版本
                          </Button>
                          <Text type={cachedPackage.manifest.local_import || cachedFreshness === 'current' ? 'success' : 'warning'}>
                            {cachedPackage.manifest.local_import ? '本地导入，按指定版本下发' : getCacheFreshnessMessage(
                              cachedFreshness,
                              onlineLowerUpdateManifest?.version ?? null,
                              onlineLowerUpdateCheckedAt,
                            )}
                          </Text>
                        </Space>
                      </div>
                    );
                  })}
                </Space>
              </div>
              <Space wrap className="advanced-config-action-row">
                <Button
                  icon={<FileSearchOutlined />}
                  onClick={() => void handleImportLocalUpdate()}
                  disabled={isSelectingLowerUpdate || isDownloadingLowerUpdate || isDeployingLowerUpdate}
                  loading={isImportingLocalUpdate}
                >
                  导入本地安装包
                </Button>
                <Button
                  icon={<FileSearchOutlined />}
                  onClick={() => void handleCheckUpdate()}
                  disabled={hasRuntimeQueryValidationError || isSelectingLowerUpdate || isDownloadTaskActive || isDeployingLowerUpdate}
                  loading={isCheckingLowerUpdate}
                >
                  检查线上最新版本
                </Button>
                <Button
                  icon={<DownloadOutlined />}
                  onClick={() => void handleDownload()}
                  disabled={
                    !hasCheckedPackage
                    || isLocalPackageSelected
                    || isSelectingLowerUpdate
                    || isDownloadTaskActive
                    || isDeployingLowerUpdate
                  }
                  loading={isDownloadTaskActive}
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
                    || isSelectingLowerUpdate
                    || isDownloadTaskActive
                    || isDeployingLowerUpdate
                  }
                  loading={isDeployingLowerUpdate}
                >
                  下发并安装
                </Button>
              </Space>
              {deploymentTask ? (
                <div className="advanced-config-background-download">
                  <Space wrap size={8}>
                    <Tag color={isDeployingLowerUpdate ? 'processing' : deploymentTask.stage === 'succeeded' ? deploymentTask.cleanupError ? 'warning' : 'success' : 'error'}>
                      {deploymentTask.status}
                    </Tag>
                    <Text type="secondary">{deploymentTask.uploadAccount} · {deploymentTask.version}</Text>
                    <Button size="small" onClick={openDeploymentDetails}>查看下发安装任务</Button>
                  </Space>
                  <Progress
                    percent={deploymentTask.progress}
                    size="small"
                    status={isDeployingLowerUpdate ? 'active' : deploymentTask.stage === 'succeeded' ? 'success' : 'exception'}
                  />
                </div>
              ) : null}
              {isDownloadTaskActive ? (
                <div className="advanced-config-background-download">
                  <Space wrap size={8}>
                    <Tag color="processing">后台下载中</Tag>
                    <Text type="secondary">
                      {formatPackageSize(effectiveDownloadedBytes)} / {formatPackageSize(effectiveDownloadTotalBytes || activeManifest?.asset.size || 0)}
                    </Text>
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      onClick={() => setIsDownloadModalOpen(true)}
                    >
                      查看进度
                    </Button>
                  </Space>
                  <Progress percent={autoDownloadProgress?.percent ?? downloadModalProgress} size="small" />
                </div>
              ) : null}
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
            <Descriptions.Item label="所选版本">{activeManifest?.version || '-'}</Descriptions.Item>
            <Descriptions.Item label="安装来源">{isLocalPackageSelected ? '本地导入' : UPDATE_CHANNEL_LABELS[channel]}</Descriptions.Item>
            <Descriptions.Item label="当前运行镜像 ID">
              <Text code className="advanced-config-hash">{displayedLowerImageId}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="可用镜像 ID">
              <Text code className="advanced-config-hash">{latestLowerImageId}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="安装包名称">{packageName}</Descriptions.Item>
            <Descriptions.Item label="包大小">{packageSize}</Descriptions.Item>
            <Descriptions.Item label="发布时间">{publishedAt}</Descriptions.Item>
            <Descriptions.Item label="下发状态">
              <Tag color={getDeliveryStatusColor(displayedDeliveryStatus)}>{displayedDeliveryStatus}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="SHA256" span={2}>
              <Text code className="advanced-config-hash">{sha256}</Text>
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <Modal
          open={isDownloadModalOpen}
          title="下载到上位机"
          okText={isDownloadTaskActive ? '后台运行' : '完成'}
          okButtonProps={{ disabled: false }}
          cancelButtonProps={{ style: { display: 'none' } }}
          maskClosable
          onOk={closeDownloadModal}
          onCancel={closeDownloadModal}
        >
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="安装包">{packageName}</Descriptions.Item>
              <Descriptions.Item label="包大小">{packageSize}</Descriptions.Item>
              <Descriptions.Item label="已下载">
                {formatPackageSize(effectiveDownloadedBytes)} / {formatPackageSize(effectiveDownloadTotalBytes || activeManifest?.asset.size || 0)}
              </Descriptions.Item>
              <Descriptions.Item label="本地路径">{downloadedPackagePath}</Descriptions.Item>
              <Descriptions.Item label="校验文件">{activeManifest?.checksum.name ?? 'SHA256SUMS'}</Descriptions.Item>
              <Descriptions.Item label="校验状态">
                <Tag color={getDownloadStageTagColor(autoDownloadProgress?.stage ?? downloadStage)}>{getDownloadStageLabel(autoDownloadProgress?.stage ?? downloadStage)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="实际 SHA256">{downloadedPackageSha256}</Descriptions.Item>
            </Descriptions>
            <Progress
              percent={autoDownloadProgress?.percent ?? downloadModalProgress}
              status={(autoDownloadProgress?.stage ?? downloadStage) === 'failed' ? 'exception' : (autoDownloadProgress?.stage ?? downloadStage) === 'finished' ? 'success' : 'active'}
            />
            <Text type="secondary">下载完成后会自动校验 SHA256，通过后可继续下发安装。</Text>
          </Space>
        </Modal>

          </>
        )}
        </div>
      </>
    );
};

export default AdvancedConfigPage;
