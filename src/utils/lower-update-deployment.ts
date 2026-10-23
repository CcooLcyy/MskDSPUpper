import type {
  LowerUpdateTaskSubmitRequest,
  LowerUpdateTaskQueryRequest,
  LowerUpdateTaskCloseRequest,
  LowerUpdateRecoveryOptions,
  LowerUpdateTaskStatus,
  LowerUpdateRemoteTarget,
  LowerUpdateReconnectRequest,
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

import { readLowerUpdatePendingTask } from './lower-update-pending.ts';
import type { LowerUpdatePendingTask } from './lower-update-pending';
import type { LowerUpdateTaskArchive } from './lower-update-archive';
import { normalizeLowerUpdateRecoveryOptions } from './lower-update-recovery.ts';

export type LowerUpdateDeploymentStage =
  | 'checking' | 'uploading' | 'installing' | 'verifying' | 'cleaning' | 'reconnecting' | 'succeeded'
  | 'remote_unknown' | 'waiting_reconnect' | 'rolling_back' | 'rolled_back' | 'rollback_failed'
  | 'task_missing' | 'task_closed'
  | 'check_failed' | 'upload_failed' | 'install_failed' | 'verify_failed' | 'image_mismatch';
export type LowerUpdateDeploymentRetryMode = 'retry' | 'reupload' | 'reinstall' | 'reverify' | 'reconnect';

export interface LowerUpdateDeploymentInput {
  manifest: LowerUpdateManifest;
  packageResult: LowerUpdateDownloadResult;
  connection: {
    remote_target?: LowerUpdateRemoteTarget;
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
  remoteTarget?: LowerUpdateRemoteTarget;
  operationId?: string;
  taskLog?: string;
  taskExitCode?: number | null;
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
  runtimeRefreshMessage: string;
  runtimeRefreshError: string | null;
}

export interface LowerUpdateDeploymentSnapshot {
  task: LowerUpdateDeploymentTask | null;
  isRunning: boolean;
  detailOpen: boolean;
  resultOpen: boolean;
  canStopWaiting: boolean;
  /** 存在未解决的远程恢复记录或损坏记录，均须阻止新建更新。 */
  hasPendingRemote: boolean;
}

export interface LowerUpdateDeploymentOperations {
  submitTask?(request: LowerUpdateTaskSubmitRequest): Promise<LowerUpdateTaskStatus>;
  queryTask?(request: LowerUpdateTaskQueryRequest): Promise<LowerUpdateTaskStatus>;
  closeTask?(request: LowerUpdateTaskCloseRequest): Promise<void>;
  preflightTask?(request: LowerUpdateRuntimeInfoRequest): Promise<void>;
  archivePending?(record: LowerUpdateTaskArchive): Promise<void>;
  loadPending?(): unknown;
  savePending?(task: LowerUpdatePendingTask | null): Promise<void>;
  queryRuntime(request: LowerUpdateRuntimeInfoRequest): Promise<LowerUpdateRuntimeInfo>;
  upload(request: LowerUpdateUploadRequest, progress: (value: LowerUpdateUploadProgress) => void): Promise<LowerUpdateUploadResult>;
  install(request: LowerUpdateInstallRequest): Promise<LowerUpdateInstallResult>;
  cleanup(request: LowerUpdateInstallRequest): Promise<LowerUpdatePackageCleanupResult>;
  saveConnection(snapshot: ReturnType<typeof snapshotLowerUpdateConnection>, revision: number): Promise<void>;
  credentialRevision(account: string): number;
  reconnectRuntime(request: LowerUpdateReconnectRequest): Promise<boolean>;
  sleep(duration: number): Promise<void>;
  now?(): number;
  scheduleTimeout?(callback: () => void, duration: number): () => void;
  log?(message: string): void;
}

const runningStages = new Set<LowerUpdateDeploymentStage>(['checking', 'uploading', 'installing', 'verifying', 'cleaning', 'reconnecting', 'waiting_reconnect', 'rolling_back']);
const observationStopped = Symbol('原任务本地观测已停止');
const remoteTerminalPhases = new Set<LowerUpdateTaskStatus['phase']>(['succeeded', 'rolled_back', 'rollback_failed', 'failed']);

/** 流程独立于 React 和路由；私有输入仅保留在内存，公开快照不包含连接凭据。 */
export function createLowerUpdateDeploymentController(operations: LowerUpdateDeploymentOperations) {
  let snapshot: LowerUpdateDeploymentSnapshot = { task: null, isRunning: false, detailOpen: false, resultOpen: false, canStopWaiting: false, hasPendingRemote: false };
  let privateInput: LowerUpdateDeploymentInput | null = null;
  const loadedPending = operations.loadPending?.();
  let pendingRemote = readLowerUpdatePendingTask(loadedPending);
  let runtimeTarget: LowerUpdateReconnectRequest | null = pendingRemote ? {
    upload_account: pendingRemote.upload_account, remote_target: { ...pendingRemote.remote_target },
  } : null;
  const invalidPending = loadedPending !== null && loadedPending !== undefined && !pendingRemote;
  snapshot = { ...snapshot, hasPendingRemote: Boolean(pendingRemote) || invalidPending };
  let recoveredCredentials: { auth: LowerUpdateSshAuth; sudo_password: string } | null = null;
  let credentialRevision = 0;
  let sequence = 0;
  let observationSequence = 0;
  type Observation = { id: number; interrupted: Promise<typeof observationStopped>; stop(): void };
  let activeObservation: Observation | null = null;
  const now = operations.now ?? (() => performance.now());
  const scheduleTimeout = operations.scheduleTimeout ?? ((callback: () => void, duration: number) => {
    const timer = globalThis.setTimeout(callback, duration);
    return () => globalThis.clearTimeout(timer);
  });
  const listeners = new Set<() => void>();

  const redact = (value: string): string => {
    const auth = privateInput?.connection.auth ?? recoveredCredentials?.auth;
    const secrets = [auth?.method === 'password' ? auth.password : '', privateInput?.connection.sudo_password ?? recoveredCredentials?.sudo_password ?? ''];
    return secrets.filter(Boolean).sort((a, b) => b.length - a.length)
      .reduce((text, secret) => text.split(secret).join('[已隐藏]'), value);
  };
  const errorText = (error: unknown): string => redact(error instanceof Error ? error.message : String(error));
  const publish = (changes: Partial<LowerUpdateDeploymentSnapshot>): void => {
    snapshot = { ...snapshot, ...changes, hasPendingRemote: Boolean(pendingRemote) || invalidPending };
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
    publish({ detailOpen: false, resultOpen: true, canStopWaiting: false });
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
    if (privateInput?.connection.remote_target) return;
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
    if (privateInput!.connection.remote_target && privateInput!.connection.auth.method !== 'password') throw new Error('远程更新仅支持密码认证');
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

  const restoreRuntime = async (changes: Partial<LowerUpdateDeploymentTask>): Promise<void> => {
    update({ ...changes, stage: 'reconnecting', status: '正在恢复业务连接', progress: 97, runtimeRefreshError: null });
    let lastError = '';
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      update({ runtimeRefreshMessage: `等待设备业务连接恢复 (${attempt}/6)` });
      try {
        // 仅包含固定目标身份；恢复查询和重试连接均不需要重新读取凭据。
        const refreshed = await operations.reconnectRuntime(structuredClone(runtimeTarget!));
        update({ runtimeRefreshMessage: refreshed ? '已自动恢复连接并刷新模块信息' : '当前业务连接与更新目标不同，已跳过自动重连', runtimeRefreshError: null });
        operations.log?.(refreshed ? '下位机更新后业务连接已恢复并刷新' : '下位机更新后已跳过其他目标的业务连接');
        return;
      } catch (error) {
        lastError = errorText(error);
        operations.log?.(`下位机更新后恢复业务连接失败 (${attempt}/6)：${lastError}`);
        if (attempt < 6) await operations.sleep(3000);
      }
    }
    update({ runtimeRefreshMessage: '更新已完成，业务连接暂未恢复，可单独重试连接', runtimeRefreshError: lastError });
  };

  const finishSucceeded = async (changes: Partial<LowerUpdateDeploymentTask> = {}): Promise<void> => {
    await restoreRuntime(changes);
    finish({ stage: 'succeeded', status: snapshot.task!.alreadyCurrent ? '已是最新' : '升级完成', progress: 100, error: null });
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
        await finishSucceeded();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 6) await operations.sleep(3000);
      }
    }
    const detail = errorText(lastError);
    finish({ stage: 'verify_failed', status: '镜像确认失败', verificationMessage: detail, error: detail, cleanupMessage: '未清理，运行镜像尚未确认，保留所有安装包' });
  };

  const remoteRequest = (): LowerUpdateTaskSubmitRequest => ({
    operation_id: pendingRemote!.operation_id, remote_target: { ...pendingRemote!.remote_target },
    upload_account: pendingRemote!.upload_account, install_dir: pendingRemote!.install_dir,
    package_name: pendingRemote!.package_name, package_sha256: pendingRemote!.package_sha256,
    expected_image_id: pendingRemote!.expected_image_id,
    auth: { ...(privateInput?.connection.auth ?? recoveredCredentials!.auth) },
    sudo_password: privateInput?.connection.sudo_password ?? recoveredCredentials!.sudo_password,
  });
  const remoteRecoveryRequest = (options: LowerUpdateRecoveryOptions): LowerUpdateTaskCloseRequest => ({ ...remoteRequest(), ...options });
  const applyRemoteStatus = async (result: LowerUpdateTaskStatus, recoveryOptions: LowerUpdateRecoveryOptions): Promise<boolean> => {
    if (result.operation_id !== pendingRemote!.operation_id || compareLowerUpdateImages(result.expected_image_id, pendingRemote!.expected_image_id) !== 'same') throw new Error('远程任务编号或期望镜像不一致，已停止接收结果');
    if (result.phase === 'succeeded' && compareLowerUpdateImages(result.actual_image_id, pendingRemote!.expected_image_id) !== 'same') throw new Error('宿主机返回成功，但实际运行镜像不匹配，保留原任务待确认');
    const terminal = remoteTerminalPhases.has(result.phase);
    const stage: LowerUpdateDeploymentStage = result.phase === 'failed' ? 'install_failed'
      : result.phase === 'accepted' || result.phase === 'preparing' ? 'installing' : result.phase;
    const statuses: Record<string, string> = { succeeded: '升级完成', rolled_back: '更新失败，已自动恢复上一版本', rollback_failed: '自动回退失败，需要人工处理', failed: '更新任务失败', rolling_back: '正在自动恢复上一版本' };
    const changes = { stage, status: statuses[result.phase] ?? '宿主机更新任务执行中', progress: terminal ? 100 : result.phase === 'verifying' ? 85 : 70,
      taskLog: redact(result.log_tail), taskExitCode: result.exit_code, actualImageId: redact(result.actual_image_id ?? '-'), verificationMessage: redact(result.message),
      error: terminal && result.phase !== 'succeeded' ? redact(result.message) : null,
      cleanupMessage: '恢复材料由宿主机管理，稳定状态保留一个先前版本' };
    if (terminal) {
      // 先清除恢复记录，失败时仍保留任务身份，避免重启后误装。
      if (result.phase !== 'rollback_failed') {
        await operations.savePending!(null);
        pendingRemote = null;
      } else changes.cleanupMessage = '自动回退失败，已保留原任务与恢复材料；请人工处理后查询原任务，禁止新建更新';
      if (result.phase === 'succeeded' && recoveryOptions.recovery_direct_account) {
        finish({ ...changes, stage: 'succeeded', status: '升级完成', progress: 100,
          runtimeRefreshMessage: '已通过直连确认原任务成功；平台业务连接请恢复后手动刷新', runtimeRefreshError: null });
      } else if (result.phase === 'succeeded') await finishSucceeded(changes);
      else finish(changes);
    } else update(changes);
    return terminal;
  };
  const finishRejectedRemote = async (error: unknown): Promise<boolean> => {
    if (!errorText(error).includes('LOWER_UPDATE_TASK_REJECTED:')) return false;
    // 仅宿主机明确确认该编号从未受理时才释放它；连接失败仍保留原任务。
    try {
      await operations.savePending!(null);
      pendingRemote = null;
      finish({ stage: 'install_failed', status: '更新任务未受理', error: errorText(error), verificationMessage: `宿主机明确未受理本次任务：${errorText(error).split('LOWER_UPDATE_TASK_REJECTED:').at(-1)!.trim()}`, cleanupMessage: '本次任务未执行安装，未清理设备恢复材料' });
    } catch {
      finish({ stage: 'remote_unknown', status: '未受理任务的本地记录清除失败', error: null, verificationMessage: '请恢复查询原任务以重新确认受理状态并清除记录' });
    }
    return true;
  };
  const isCurrentObservation = (observation: Observation): boolean => activeObservation === observation && observation.id === observationSequence;
  const boundedRead = async <T>(read: () => Promise<T>, duration: number, timeoutMessage: string, observation?: Observation): Promise<T> => {
    let cancelTimeout = () => {};
    const timeout = new Promise<never>((_, reject) => { cancelTimeout = scheduleTimeout(() => reject(new Error(timeoutMessage)), duration); });
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        if (observation && !isCurrentObservation(observation)) throw observationStopped;
        return read();
      }), timeout, ...(observation ? [observation.interrupted] : [])]);
      if (result === observationStopped || (observation && !isCurrentObservation(observation))) throw observationStopped;
      return result as T;
    } finally { cancelTimeout(); }
  };
  const observeRemote = async (once = false, recoveryOptions: LowerUpdateRecoveryOptions = {}): Promise<void> => {
    let stop = () => {};
    const interrupted = new Promise<typeof observationStopped>(resolve => { stop = () => resolve(observationStopped); });
    const observation: Observation = { id: ++observationSequence, interrupted, stop };
    activeObservation = observation;
    const startedAt = now();
    const deadline = startedAt + 180_000;
    const budgetMessage = '自动观测已达 180 秒，本轮本地等待已结束；请稍后查询原任务，不要重复安装';
    publish({ canStopWaiting: true });
    try {
      while (isCurrentObservation(observation)) {
        const remaining = deadline - now();
        if (!once && remaining <= 0) throw new Error(budgetMessage);
        const request = remoteRecoveryRequest(recoveryOptions);
        const result = await boundedRead(() => operations.queryTask!(request), once ? 35_000 : Math.min(35_000, remaining),
          !once && remaining <= 35_000 ? budgetMessage : '原任务查询等待已达 35 秒，未收到完整响应，请检查连接后重试', observation);
        if (!isCurrentObservation(observation)) return;
        // 终态消费会写本地恢复记录；关闭停止入口后才能进入该异步事务。
        if (remoteTerminalPhases.has(result.phase)) publish({ canStopWaiting: false });
        if (!isCurrentObservation(observation)) return;
        if (await applyRemoteStatus(result, recoveryOptions)) return;
        if (!isCurrentObservation(observation)) return;
        if (once) {
          const phases: Partial<Record<LowerUpdateTaskStatus['phase'], string>> = {
            accepted: '已受理', preparing: '准备中', installing: '安装中', verifying: '验证中', rolling_back: '回退中',
          };
          finish({ stage: 'remote_unknown', status: `宿主机任务${phases[result.phase] ?? result.phase}，可稍后查询`, error: null,
            verificationMessage: `本次查询宿主机阶段：${result.phase}。${redact(result.message)}。本轮本地等待已结束，可稍后再次查询原任务。` });
          return;
        }
        const waitBudget = deadline - now();
        if (waitBudget <= 0) throw new Error(budgetMessage);
        await boundedRead(() => operations.sleep(Math.min(3000, waitBudget)), waitBudget, budgetMessage, observation);
      }
    } catch (error) {
      if (!isCurrentObservation(observation) || error === observationStopped) return;
      if (errorText(error).includes('LOWER_UPDATE_TASK_NOT_FOUND:')) {
        finish({ stage: 'task_missing', status: '原任务不存在', error: null,
          verificationMessage: '宿主机未找到原任务，尚未确认旧版本安装成功；可重新核验后结束本地记录。查询不会重新安装。',
          cleanupMessage: '保留本地原任务、设备安装包与恢复材料' });
        return;
      }
      const detail = errorText(error);
      operations.log?.(`原任务查询结束：任务 ${pendingRemote?.operation_id ?? '-'}，耗时 ${Math.round(now() - startedAt)} 毫秒，${detail}`);
      finish({ stage: 'remote_unknown', status: '原任务查询未完成，请检查后重试', error: detail,
        verificationMessage: `本轮查询未确认更新结果：${detail}。已保留原任务，请检查后再次查询，不要重复安装。`, cleanupMessage: '保留原任务及恢复材料' });
    } finally {
      if (isCurrentObservation(observation)) {
        activeObservation = null;
        publish({ canStopWaiting: false });
      }
    }
  };
  const executeRemote = async (): Promise<void> => {
    if (!operations.submitTask || !operations.queryTask || !operations.savePending) throw new Error('远程更新任务接口未初始化');
    const input = privateInput!;
    const record: LowerUpdatePendingTask = { operation_id: globalThis.crypto.randomUUID(), remote_target: { ...input.connection.remote_target! },
      upload_account: input.connection.upload_account, install_dir: input.connection.install_dir, package_name: input.packageResult.package_name,
      package_sha256: input.packageResult.sha256, expected_image_id: input.manifest.image_id!.trim(), version: input.manifest.version };
    // 保存完成后才能提交；保存失败不会创建宿主机任务。
    if (!readLowerUpdatePendingTask(record)) throw new Error('远程更新恢复记录无效，已停止提交');
    update({ stage: 'checking', status: '保存原任务恢复信息', progress: 60 });
    await operations.savePending(record);
    pendingRemote = record;
    update({ operationId: record.operation_id, stage: 'installing', status: '提交宿主机更新任务', progress: 65 });
    try { await operations.submitTask(remoteRequest()); }
    catch (error) {
      if (await finishRejectedRemote(error)) return;
      operations.log?.(`远程更新提交回执暂未确认，继续查询原任务：${errorText(error)}`);
    }
    await observeRemote();
  };
  if (pendingRemote) {
    snapshot = { task: { id: pendingRemote.operation_id, operationId: pendingRemote.operation_id, remoteTarget: { ...pendingRemote.remote_target },
      version: pendingRemote.version, packageName: pendingRemote.package_name, packagePath: '-', uploadAccount: pendingRemote.upload_account,
      installDir: pendingRemote.install_dir, authMethod: 'password', stage: 'remote_unknown', status: '有待确认的远程更新任务', progress: 65,
      uploadedBytes: 0, totalBytes: 0, remotePath: '-', uploadResult: null, installResult: null, expectedImageId: pendingRemote.expected_image_id,
      actualImageId: '-', verificationMessage: '请重新输入认证信息后查询原任务', cleanupMessage: '保留原任务及恢复材料', error: null,
      cleanupError: null, alreadyCurrent: false, connectionWarning: null, runtimeRefreshMessage: '未执行', runtimeRefreshError: null }, isRunning: false, detailOpen: false, resultOpen: false, canStopWaiting: false, hasPendingRemote: true };
  }

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
        await finishSucceeded({ verificationMessage: '目标机已运行待下发构建，无需重复安装', cleanupMessage: '已跳过重复上传和安装，未执行历史包清理' });
        return;
      }
      if (privateInput!.connection.remote_target) {
        if (!operations.preflightTask) throw new Error('远程更新预检接口未初始化，已停止上传');
        update({ stage: 'checking', status: '检查远程安装环境', verificationMessage: '检查 Python、sudo、systemd、Docker 与安装助手目录权限' });
        await operations.preflightTask(connection());
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
      if (privateInput!.connection.remote_target) {
        await executeRemote();
        return;
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
      if (invalidPending) throw new Error('原任务恢复记录无效，已停止新建更新任务，请检查本地恢复记录');
      if (pendingRemote) throw new Error('请先恢复查询原任务，结果未确认前不能创建新任务');
      privateInput = structuredClone(input);
      privateInput.connection.upload_account = privateInput.connection.upload_account.trim();
      privateInput.connection.install_dir = privateInput.connection.install_dir.trim().replace(/\/+$/, '') || '/';
      credentialRevision = operations.credentialRevision(privateInput.connection.upload_account);
      runtimeTarget = { upload_account: privateInput.connection.upload_account,
        ...(privateInput.connection.remote_target ? { remote_target: { ...privateInput.connection.remote_target } } : {}),
      };
      const task: LowerUpdateDeploymentTask = {
        remoteTarget: privateInput.connection.remote_target ? { ...privateInput.connection.remote_target } : undefined,
        id: `lower-update-${Date.now()}-${++sequence}`, version: redact(input.manifest.version),
        packageName: redact(input.packageResult.package_name), packagePath: redact(input.packageResult.package_path),
        uploadAccount: redact(privateInput.connection.upload_account), installDir: redact(privateInput.connection.install_dir), authMethod: input.connection.auth.method,
        stage: 'checking', status: '下发前预检中', progress: 0, uploadedBytes: 0, totalBytes: input.packageResult.downloaded_bytes,
        remotePath: '-', uploadResult: null, installResult: null, expectedImageId: redact(input.manifest.image_id?.trim() || '-'), actualImageId: '-',
        verificationMessage: '下发前查询目标机运行镜像', cleanupMessage: '未执行', error: null, cleanupError: null, alreadyCurrent: false, connectionWarning: null, runtimeRefreshMessage: '未执行', runtimeRefreshError: null,
      };
      // 必须先同步发布占用状态，再进行任何异步预检。
      publish({ task, isRunning: true, detailOpen: true, resultOpen: false });
      operations.log?.('开始执行下位机更新后台任务');
      await execute('start');
    },
    async resumeRemote(auth: LowerUpdateSshAuth, sudoPassword: string, options?: LowerUpdateRecoveryOptions): Promise<void> {
      if (snapshot.isRunning) throw new Error('原任务正在查询中');
      if (!pendingRemote) throw new Error('没有可恢复查询的原任务');
      if (auth.method !== 'password' || !auth.password || !sudoPassword) throw new Error('请输入 SSH 与 sudo 密码');
      const recoveryOptions = normalizeLowerUpdateRecoveryOptions(options, pendingRemote.upload_account);
      recoveredCredentials = { auth: { ...auth }, sudo_password: sudoPassword };
      if (privateInput) { privateInput.connection.auth = { ...auth }; privateInput.connection.sudo_password = sudoPassword; }
      update({ stage: 'waiting_reconnect', status: '正在恢复查询原任务', error: null });
      publish({ detailOpen: true, resultOpen: false });
      await observeRemote(true, recoveryOptions);
    },
    stopObservingRemote(): void {
      if (!snapshot.canStopWaiting || !activeObservation) return;
      const observation = activeObservation;
      observationSequence++;
      activeObservation = null;
      observation.stop();
      finish({ stage: 'remote_unknown', status: '已停止本地等待', error: null,
        verificationMessage: '已停止本轮本地查询，未取消设备上的安装。更新结果尚未确认，原任务记录已保留，可稍后重新查询。', cleanupMessage: '保留原任务及恢复材料' });
    },
    async closeMissingRemote(auth: LowerUpdateSshAuth, sudoPassword: string, options?: LowerUpdateRecoveryOptions): Promise<void> {
      if (snapshot.isRunning) throw new Error('原任务正在核验中');
      if (!pendingRemote || snapshot.task?.stage !== 'task_missing') throw new Error('只有确认不存在的原任务才能核验并结束本地记录');
      if (auth.method !== 'password' || !auth.password || !sudoPassword) throw new Error('请输入原设备 SSH 与 sudo 密码');
      const recoveryOptions = normalizeLowerUpdateRecoveryOptions(options, pendingRemote.upload_account);
      recoveredCredentials = { auth: { ...auth }, sudo_password: sudoPassword };
      if (privateInput) { privateInput.connection.auth = { ...auth }; privateInput.connection.sudo_password = sudoPassword; }
      update({ stage: 'checking', status: '正在核验原任务和设备运行状态', error: null });
      try {
        if (!operations.queryTask || !operations.archivePending || !operations.closeTask || !operations.savePending) throw new Error('原任务查询、关闭或归档接口未初始化，已保留本地记录');
        const request = remoteRecoveryRequest(recoveryOptions);
        try {
          await boundedRead(() => operations.queryTask!(request), 35_000, '原任务查询等待已达 35 秒，已保留记录，请检查连接后重试');
          finish({ stage: 'remote_unknown', status: '原任务已存在，请恢复查询', error: null,
            verificationMessage: '二次核验发现宿主机原任务已存在，已停止结束操作；请恢复查询原任务。', cleanupMessage: '保留原任务及恢复材料' });
          return;
        } catch (error) {
          // 后端仅在同时排除其他执行中、回退失败任务和安装进程后返回不存在。
          if (!errorText(error).includes('LOWER_UPDATE_TASK_NOT_FOUND:')) throw error;
        }
        const runtimeRequest: LowerUpdateRuntimeInfoRequest = {
          remote_target: { ...pendingRemote.remote_target }, upload_account: pendingRemote.upload_account,
          auth: { ...auth }, sudo_password: sudoPassword,
          ...recoveryOptions,
        };
        const runtime = await boundedRead(() => operations.queryRuntime(runtimeRequest), 35_000, '原设备运行状态核验等待已达 35 秒，已保留记录，请检查连接后重试');
        const actualImageId = runtime.image_id?.trim() ?? '';
        if (!runtime.exists || !runtime.running || !/^sha256:[0-9a-f]{64}$/i.test(actualImageId)) {
          throw new Error('原设备业务容器未正常运行或镜像 ID 无效，已保留本地记录，请检查设备后重试');
        }
        await operations.archivePending({ task: structuredClone(pendingRemote), closed_at: new Date().toISOString(), actual_image_id: actualImageId, reason: 'task_not_found' });
        // 设备持久记录拒绝原编号，阻止已发出但迟到的提交在本地结束后安装旧包。
        await operations.closeTask(request);
        await operations.savePending(null);
        const publicImageId = redact(actualImageId);
        pendingRemote = null;
        recoveredCredentials = null;
        privateInput = null;
        finish({ stage: 'task_closed', status: '本地记录已结束', progress: 100, error: null, actualImageId: publicImageId,
          verificationMessage: '已核验原任务不存在且设备业务容器正常运行；本地恢复记录已归档并结束，不代表旧版本安装成功。',
          cleanupMessage: '未执行安装，未删除设备安装包或恢复材料' });
      } catch (error) {
        finish({ stage: 'task_missing', status: '原任务记录未结束，可重试核验', error: errorText(error),
          verificationMessage: '核验、归档或本地记录清除未完成，已保留原任务，禁止新建更新。', cleanupMessage: '未执行安装，未删除设备安装包或恢复材料' });
      }
    },
    async retry(mode: LowerUpdateDeploymentRetryMode): Promise<void> {
      if (snapshot.isRunning) throw new Error('已有下位机更新任务正在执行，请查看当前任务');
      if (mode === 'reconnect') {
        if (!runtimeTarget || snapshot.task?.stage !== 'succeeded') throw new Error('请先确认更新成功，再重试业务连接');
        publish({ detailOpen: true, resultOpen: false });
        await finishSucceeded();
        return;
      }
      if (snapshot.task?.remoteTarget) throw new Error('远程更新请恢复查询原任务；已结束任务需明确开始新的更新，不能重新安装原任务');
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
