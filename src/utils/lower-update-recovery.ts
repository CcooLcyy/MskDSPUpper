import type { LowerUpdateRecoveryOptions } from '../adapters/types';
import { validateManagerAddress } from './network.ts';

/** 直连只覆盖本轮通信地址，原任务用户和设备身份必须保持不变。 */
export function normalizeLowerUpdateRecoveryOptions(options: LowerUpdateRecoveryOptions | undefined, originalAccount: string): LowerUpdateRecoveryOptions {
  if (options?.recovery_direct_account === undefined) return {};
  const direct = options.recovery_direct_account;
  if (typeof direct !== 'string') throw new Error('原任务直连账号格式应为 原用户@主机:端口');
  const account = /^([A-Za-z_][A-Za-z0-9_-]*)@([^@:\s]+):(\d+)$/.exec(direct.trim());
  if (!account) throw new Error('原任务直连账号格式应为 原用户@主机:端口');
  if (account[1] !== originalAccount.split('@')[0]) throw new Error('直连 SSH 用户必须与原任务用户一致');
  if (account[2].toLowerCase() === 'remote') throw new Error('直连原设备必须填写实际主机地址，不能使用 remote');
  const address = validateManagerAddress(`${account[2]}:${account[3]}`);
  if (!address.ok) throw new Error(`原任务直连地址无效：${address.error}`);
  return { recovery_direct_account: `${account[1]}@${address.normalized}` };
}
