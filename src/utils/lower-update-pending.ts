import type { LowerUpdateRemoteTarget } from '../adapters/types';

/** 只保存恢复原任务所需的非秘密字段；禁止保存认证或临时隧道地址。 */
export interface LowerUpdatePendingTask {
  operation_id: string;
  remote_target: LowerUpdateRemoteTarget;
  upload_account: string;
  install_dir: string;
  package_name: string;
  package_sha256: string;
  expected_image_id: string;
  version: string;
}
export const LOWER_UPDATE_PENDING_KEY = 'mskdsp.lower-update.pending.v1';
export function readLowerUpdatePendingTask(value: unknown): LowerUpdatePendingTask | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const target = item.remote_target as Record<string, unknown> | undefined;
  if (!target || typeof target.endpoint !== 'string' || !target.endpoint || typeof target.device_id !== 'string' || !target.device_id) return null;
  try {
    const endpoint = new URL(target.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
  } catch { return null; }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(target.device_id)) return null;
  const keys = ['operation_id', 'upload_account', 'install_dir', 'package_name', 'package_sha256', 'expected_image_id', 'version'] as const;
  if (keys.some(key => typeof item[key] !== 'string' || !item[key])) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.operation_id as string) || !/^[0-9a-f]{64}$/i.test(item.package_sha256 as string)) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*@remote:22$/.test(item.upload_account as string) || !/^\/[^\s]*$/.test(item.install_dir as string) || !/^[A-Za-z0-9._-]+$/.test(item.package_name as string) || !/^sha256:[0-9a-f]{64}$/i.test(item.expected_image_id as string)) return null;
  return { operation_id: item.operation_id as string, upload_account: item.upload_account as string, install_dir: item.install_dir as string,
    package_name: item.package_name as string, package_sha256: item.package_sha256 as string, expected_image_id: item.expected_image_id as string,
    version: item.version as string, remote_target: { endpoint: target.endpoint, device_id: target.device_id } };
}
