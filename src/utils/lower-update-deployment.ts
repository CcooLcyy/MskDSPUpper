import type {
  LowerUpdateDownloadResult,
  LowerUpdateInstallRequest,
  LowerUpdateInstallResult,
  LowerUpdateManifest,
  LowerUpdatePackageCleanupResult,
  LowerUpdateRuntimeInfo,
  LowerUpdateRuntimeInfoRequest,
  LowerUpdateSshAuth,
  LowerUpdateUploadProgress,
  LowerUpdateUploadRequest,
  LowerUpdateUploadResult,
} from '../adapters/types';
import { compareLowerUpdateImages } from './lower-update-deploy.ts';
import { assertLowerUpdateManifest } from './lower-update-platform.ts';
import { snapshotLowerUpdateConnection } from './lower-update-connection.ts';

export type LowerUpdateDeploymentStage =
  | 'checking' | 'uploading' | 'installing' | 'verifying' | 'cleaning' | 'succeeded'
  | 'check_failed' | 'upload_failed' | 'install_failed' | 'verify_failed' | 'image_mismatch';
export type LowerUpdateDeploymentRetryMode = 'retry' | 'reupload' | 'reinstall' | 'reverify';

export interface LowerUpdateDeploymentInput {
  manifest: LowerUpdateManifest;
  packageResult: LowerUpdateDownloadResult;
  connection: {
    upload_account: string;
    install_dir: string;
    auth: LowerUpdateSshAuth;
    sudo_password: string;
  };
  reuseSshPasswordForSudo: boolean;
  rememberPassword: boolean;
}

export interface LowerUpdateDeploymentTask {
  id: string;
  version: string;
  packageName: string;
  packagePath: string;
  uploadAccount: string;
  installDir: string;
  authMethod: LowerUpdateSshAuth['method'];
  stage: LowerUpdateDeploymentStage;
  status: string;
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  remotePath: string;
  uploadResult: LowerUpdateUploadResult | null;
  installResult: LowerUpdateInstallResult | null;
  expectedImageId: string;
  actualImageId: string;
  verificationMessage: string;
  cleanupMessage: string;
  error: string | null;
  cleanupError: string | null;
  alreadyCurrent: boolean;
  connectionWarning: string | null;
}

export interface LowerUpdateDeploymentSnapshot {
  task: LowerUpdateDeploymentTask | null;
  isRunning: boolean;
  detailOpen: boolean;
  resultOpen: boolean;
}

export interface LowerUpdateDeploymentOperations {
  queryRuntime(request: LowerUpdateRuntimeInfoRequest): Promise<LowerUpdateRuntimeInfo>;
  upload(request: LowerUpdateUploadRequest, progress: (value: LowerUpdateUploadProgress) => void): Promise<LowerUpdateUploadResult>;
  install(request: LowerUpdateInstallRequest): Promise<LowerUpdateInstallResult>;
  cleanup(request: LowerUpdateInstallRequest): Promise<LowerUpdatePackageCleanupResult>;
  saveConnection(snapshot: ReturnType<typeof snapshotLowerUpdateConnection>, revision: number): Promise<void>;
  credentialRevision(account: string): number;
  sleep(duration: number): Promise<void>;
  log?(message: string): void;
}

const runningStages = new Set<LowerUpdateDeploymentStage>(['checking', 'uploading', 'installing', 'verifying', 'cleaning']);

/** 流程独立于 React 和路由；私有输入仅保留在内存，公开快照不包含连接凭据。 */
export function createLowerUpdateDeploymentController(operations: LowerUpdateDeploymentOperations) {
  let snapshot: LowerUpdateDeploymentSnapshot = { task: null, isRunning: false, detailOpen: false, resultOpen: false };
  let privateInput: LowerUpdateDeploymentInput | null = null;
  let credentialRevision = 0;
  let sequence = 0;
  const listeners = new Set<() => void>();

  const redact = (value: string): string => {
    const auth = privateInput?.connection.auth;
    const secrets = [auth?.method === 'password' ? auth.password : '', privateInput?.connection.sudo_password ?? ''];
    return secrets.filter(Boolean).sort((a, b) => b.length - a.length)
      .reduce((text, secret) => text.split(secret).join('[已隐藏]'), value);
  };
  const errorText = (error: unknown): string => redact(error instanceof Error ? error.message : String(error));
  const publish = (changes: Partial<LowerUpdateDeploymentSnapshot>): void => {
    snapshot = { ...snapshot, ...changes };
    for (const listener of listeners) listener();
  };
  const update = (changes: Partial<LowerUpdateDeploymentTask>): void => {
    if (!snapshot.task) return;
    const task = { ...snapshot.task, ...changes };
    publish({ task, isRunning: runningStages.has(task.stage) });
    if (changes.stage) operations.log?.(`下位机更新任务：${task.status}`);
  };
  const finish = (changes: Partial<LowerUpdateDeploymentTask>): void => {
    update(changes);
    publish({ detailOpen: false, resultOpen: true });
  };
  const connection = () => {
    const value = privateInput!.connection;
    return { ...value, auth: { ...value.auth } };
  };
  const installRequest = (): LowerUpdateInstallRequest => ({
    ...connection(), package_name: privateInput!.packageResult.package_name,
    expected_image_id: privateInput!.manifest.image_id!.trim(),
  });
  const persistConnection = async (): Promise<void> => {
    try {
      await operations.saveConnection(snapshotLowerUpdateConnection(connection(), privateInput!.reuseSshPasswordForSudo, privateInput!.rememberPassword), credentialRevision);
      update({ connectionWarning: null });
    } catch {
      // 保存失败不改变已成功的更新结果，也不公开凭据存储错误。
      update({ connectionWarning: '下发成功，但连接信息或密码保存失败，请下次重新输入' });
      operations.log?.('下发成功，但连接信息或密码保存失败，请下次重新输入');
    }
  };
  const validate = (): void => {
    const { manifest, packageResult } = privateInput!;
    if (manifest.platform !== 'linux-arm64' && manifest.platform !== 'linux-x64') throw new Error('下位机更新架构不支持');
    assertLowerUpdateManifest(manifest, manifest.platform, manifest.channel);
    if (!manifest.image_id?.trim() || manifest.image_id.trim() === '-') throw new Error('当前更新清单未包含有效的期望镜像 ID');
    if (!packageResult.package_path || packageResult.package_name !== manifest.asset.name
      || packageResult.downloaded_bytes !== manifest.asset.size
      || !packageResult.sha256 || packageResult.sha256.toLowerCase() !== manifest.asset.sha256.toLowerCase()) {
      throw new Error('安装包与清单的名称、大小或校验信息不一致，已停止下发');
    }
  };

  const verifyAndCleanup = async (): Promise<void> => {
    update({ stage: 'verifying', status: '镜像确认中', progress: 85, actualImageId: '-', verificationMessage: '等待下位机容器恢复', cleanupMessage: '等待运行镜像确认' });
    await operations.sleep(5000);
    let lastError: unknown = new Error('无法确认运行镜像');
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      update({ verificationMessage: `查询运行镜像中 (${attempt}/6)` });
      try {
        const runtime = await operations.queryRuntime(connection());
        const actualImageId = runtime.image_id?.trim() || '-';
        update({ actualImageId: redact(actualImageId) });
        if (!runtime.exists) throw new Error(`未找到 ${runtime.container_name} 容器`);
        if (!runtime.running) throw new Error(`${runtime.container_name} 容器未运行`);
        if (actualImageId === '-') throw new Error(`${runtime.container_name} 容器未返回有效的镜像 ID`);
        if (compareLowerUpdateImages(privateInput!.manifest.image_id, actualImageId) !== 'same') {
          const message = redact(`期望 ${snapshot.task!.expectedImageId}，实际 ${actualImageId}`);
          finish({ stage: 'image_mismatch', status: '构建不一致', verificationMessage: message, error: message, cleanupMessage: '未清理，运行镜像尚未确认，保留所有安装包' });
          return;
        }
        update({ verificationMessage: redact(`运行镜像已确认: ${actualImageId}`) });
        update({ stage: 'cleaning', status: '清理历史安装包中', progress: 95, cleanupMessage: '正在清理历史安装包' });
        try {
          const result = await operations.cleanup(installRequest());
          update({ cleanupMessage: `已删除 ${result.removed_files} 个旧包，释放 ${result.reclaimed_bytes} 字节，保留本次安装包`, cleanupError: null });
        } catch (error) {
          const detail = errorText(error);
          update({ cleanupMessage: `清理失败，可重新确认镜像后重试：${detail}`, cleanupError: detail });
          operations.log?.('下位机升级已完成，历史安装包清理失败');
        }
        finish({ stage: 'succeeded', status: snapshot.task!.alreadyCurrent ? '已是最新' : '升级完成', progress: 100, error: null });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 6) await operations.sleep(3000);
      }
    }
    const detail = errorText(lastError);
    finish({ stage: 'verify_failed', status: '镜像确认失败', verificationMessage: detail, error: detail, cleanupMessage: '未清理，运行镜像尚未确认，保留所有安装包' });
  };

  const execute = async (mode: LowerUpdateDeploymentRetryMode | 'start'): Promise<void> => {
    try {
      validate();
      if (mode === 'reverify') {
        await verifyAndCleanup();
        return;
      }
      const runtime = await operations.queryRuntime(connection());
      const actualImageId = runtime.image_id?.trim() || '-';
      update({ actualImageId: redact(actualImageId) });
      if (runtime.exists && runtime.running && compareLowerUpdateImages(privateInput!.manifest.image_id, actualImageId) === 'same') {
        update({ alreadyCurrent: true });
        // 普通重试保留成功安装上下文，允许继续补齐失败的镜像确认或清理。
        if (mode === 'retry' && snapshot.task!.installResult?.success) {
          await verifyAndCleanup();
          return;
        }
        finish({ stage: 'succeeded', status: '已是最新', progress: 100, verificationMessage: '目标机已运行待下发构建，无需重复安装', cleanupMessage: '已跳过重复上传和安装，未执行历史包清理', error: null });
        return;
      }
      if (!snapshot.task!.uploadResult) {
        update({ stage: 'uploading', status: '上传中', progress: 0 });
        const packageResult = privateInput!.packageResult;
        const expectedRemotePath = `${privateInput!.connection.install_dir.replace(/\/+$/, '')}/${packageResult.package_name}`;
        let acceptProgress = true;
        let result: LowerUpdateUploadResult;
        try {
          result = await operations.upload({ ...connection(), package_name: packageResult.package_name, package_path: packageResult.package_path, package_size: packageResult.downloaded_bytes, package_sha256: packageResult.sha256 }, (progress) => {
            if (!acceptProgress || progress.package_name !== packageResult.package_name
              || (progress.remote_path && progress.remote_path !== expectedRemotePath)) return;
            update({ progress: Math.max(0, Math.min(60, progress.percent * 0.6)), uploadedBytes: progress.uploaded_bytes, totalBytes: progress.total_bytes || packageResult.downloaded_bytes, remotePath: redact(progress.remote_path || '-') });
          });
        } finally {
          // 已结束上传的迟到事件不得覆盖安装阶段或下一次任务状态。
          acceptProgress = false;
        }
        update({ uploadResult: { package_name: redact(result.package_name), remote_path: redact(result.remote_path), uploaded_bytes: result.uploaded_bytes }, remotePath: redact(result.remote_path), uploadedBytes: result.uploaded_bytes, progress: 60 });
        await persistConnection();
      }
      update({ stage: 'installing', status: '安装中', progress: 65, actualImageId: '-', installResult: null });
      const result = await operations.install(installRequest());
      update({ installResult: {
        package_name: redact(result.package_name), remote_path: redact(result.remote_path), command: redact(result.command),
        already_current: result.already_current, success: result.success, exit_code: result.exit_code,
        stdout: redact(result.stdout), stderr: redact(result.stderr),
      }, remotePath: redact(result.remote_path), alreadyCurrent: result.already_current });
      if (!result.success) {
        finish({ stage: 'install_failed', status: '安装失败', error: `安装命令执行失败，退出码: ${result.exit_code ?? '-'}` });
        return;
      }
      await persistConnection();
      await verifyAndCleanup();
    } catch (error) {
      const stage = snapshot.task!.stage;
      const detail = errorText(error);
      if (stage === 'uploading') finish({ stage: 'upload_failed', status: '上传失败', error: detail });
      else if (stage === 'installing') finish({ stage: 'install_failed', status: '安装失败', error: detail });
      else if (stage === 'verifying' || stage === 'cleaning') finish({ stage: 'verify_failed', status: '镜像确认失败', error: detail, verificationMessage: detail });
      else finish({ stage: 'check_failed', status: '下发前预检失败', error: detail, verificationMessage: detail });
    }
  };

  return {
    getSnapshot: (): LowerUpdateDeploymentSnapshot => snapshot,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async start(input: LowerUpdateDeploymentInput): Promise<void> {
      if (snapshot.isRunning) throw new Error('已有下位机更新任务正在执行，请查看当前任务');
      privateInput = structuredClone(input);
      privateInput.connection.upload_account = privateInput.connection.upload_account.trim();
      privateInput.connection.install_dir = privateInput.connection.install_dir.trim().replace(/\/+$/, '') || '/';
      credentialRevision = operations.credentialRevision(privateInput.connection.upload_account);
      const task: LowerUpdateDeploymentTask = {
        id: `lower-update-${Date.now()}-${++sequence}`, version: redact(input.manifest.version),
        packageName: redact(input.packageResult.package_name), packagePath: redact(input.packageResult.package_path),
        uploadAccount: redact(privateInput.connection.upload_account), installDir: redact(privateInput.connection.install_dir), authMethod: input.connection.auth.method,
        stage: 'checking', status: '下发前预检中', progress: 0, uploadedBytes: 0, totalBytes: input.packageResult.downloaded_bytes,
        remotePath: '-', uploadResult: null, installResult: null, expectedImageId: redact(input.manifest.image_id?.trim() || '-'), actualImageId: '-',
        verificationMessage: '下发前查询目标机运行镜像', cleanupMessage: '未执行', error: null, cleanupError: null, alreadyCurrent: false, connectionWarning: null,
      };
      // 必须先同步发布占用状态，再进行任何异步预检。
      publish({ task, isRunning: true, detailOpen: true, resultOpen: false });
      operations.log?.('开始执行下位机更新后台任务');
      await execute('start');
    },
    async retry(mode: LowerUpdateDeploymentRetryMode): Promise<void> {
      if (snapshot.isRunning) throw new Error('已有下位机更新任务正在执行，请查看当前任务');
      if (!privateInput || !snapshot.task) throw new Error('没有可重试的下位机更新任务');
      if (mode === 'reinstall' && !snapshot.task.uploadResult) throw new Error('请先完成上传');
      if (mode === 'reverify' && !snapshot.task.installResult?.success) throw new Error('请先完成安装命令');
      const uploadResult = mode === 'reupload' ? null : snapshot.task.uploadResult;
      update({ stage: mode === 'reverify' ? 'verifying' : 'checking', status: mode === 'reverify' ? '镜像确认中' : '下发前预检中',
        uploadResult,
        uploadedBytes: uploadResult?.uploaded_bytes ?? 0, remotePath: uploadResult?.remote_path ?? '-', progress: uploadResult ? 60 : 0,
        error: null, cleanupError: null, alreadyCurrent: mode === 'reverify' && snapshot.task.alreadyCurrent, cleanupMessage: '未执行', verificationMessage: '下发前查询目标机运行镜像',
      });
      publish({ detailOpen: true, resultOpen: false });
      await execute(mode);
    },
    openDetails(): void { if (snapshot.task) publish({ detailOpen: true, resultOpen: false }); },
    closeDetails(): void { publish({ detailOpen: false }); },
    dismissResult(): void { publish({ resultOpen: false }); },
  };
}

export type LowerUpdateDeploymentController = ReturnType<typeof createLowerUpdateDeploymentController>;
