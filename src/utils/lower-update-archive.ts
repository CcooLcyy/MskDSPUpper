import { readLowerUpdatePendingTask } from './lower-update-pending.ts';
import type { LowerUpdatePendingTask } from './lower-update-pending';

export const LOWER_UPDATE_ARCHIVE_KEY = 'mskdsp.lower-update.archive.v1';
export interface LowerUpdateTaskArchive {
  task: LowerUpdatePendingTask;
  closed_at: string;
  actual_image_id: string;
  reason: 'task_not_found';
}

function readArchive(value: unknown): LowerUpdateTaskArchive {
  if (!value || typeof value !== 'object') throw new Error('远程更新归档记录无效');
  const item = value as Record<string, unknown>;
  const task = readLowerUpdatePendingTask(item.task);
  if (!task || item.reason !== 'task_not_found' || typeof item.closed_at !== 'string'
    || !Number.isFinite(Date.parse(item.closed_at)) || typeof item.actual_image_id !== 'string'
    || !/^sha256:[0-9a-f]{64}$/i.test(item.actual_image_id)) throw new Error('远程更新归档记录无效');
  return { task, closed_at: item.closed_at, actual_image_id: item.actual_image_id, reason: 'task_not_found' };
}

/** 归档重建白名单；损坏记录不静默覆盖，避免丢失原任务的恢复证据。 */
export function appendLowerUpdateArchive(existing: unknown, record: LowerUpdateTaskArchive): LowerUpdateTaskArchive[] {
  if (!Array.isArray(existing)) throw new Error('远程更新归档内容损坏，请先保留原归档再处理');
  const archive = existing.map(readArchive);
  const safe = readArchive(record);
  // 清除 pending 失败后的重试不重复占用归档容量。
  const matches = (entry: LowerUpdateTaskArchive) => entry.task.operation_id === safe.task.operation_id
    && entry.task.remote_target.device_id === safe.task.remote_target.device_id
    && entry.task.remote_target.endpoint === safe.task.remote_target.endpoint;
  if (!archive.some(matches)) archive.push(safe);
  return archive.slice(-20);
}
