import type { LowerUpdateActiveChannel, LowerUpdateChannel, LowerUpdateManifest, LowerUpdatePlatform } from '../adapters/types';

// 版本尚未读取或无法识别时采用 Stable 限制，防止初始化期间越过通道边界。
export function isStableUpdateClient(version: string | null): boolean {
  return !version?.includes('-ci.') && !version?.includes('-beta.');
}

export function getLowerUpdateChannels(platform: LowerUpdatePlatform, clientVersion?: string | null): LowerUpdateActiveChannel[] {
  let channels: LowerUpdateActiveChannel[];
  if (platform === 'linux-arm64') channels = ['stable', 'ci'];
  else if (platform === 'linux-x64') channels = ['ci'];
  else throw new Error(`下位机更新架构不支持: ${platform}`);
  return clientVersion !== undefined && isStableUpdateClient(clientVersion)
    ? channels.filter((channel) => channel === 'stable') : channels;
}

export function getLowerUpdateChannel(platform: LowerUpdatePlatform, channel: LowerUpdateChannel, clientVersion?: string | null): LowerUpdateActiveChannel {
  const channels = getLowerUpdateChannels(platform, clientVersion);
  return channels.find((candidate) => candidate === channel) ?? channels[0] ?? 'stable';
}

// 检查源返回的架构和通道，避免错误源配置导致下载另一架构的包。
export function assertLowerUpdateManifest(
  manifest: Pick<LowerUpdateManifest, 'platform' | 'channel'>,
  platform: LowerUpdatePlatform,
  channel: LowerUpdateChannel,
  clientVersion?: string | null,
): asserts channel is LowerUpdateActiveChannel {
  if (manifest.platform !== platform) throw new Error('下位机更新清单架构与所选架构不一致');
  if (!getLowerUpdateChannels(platform, clientVersion).some((candidate) => candidate === channel) || manifest.channel !== channel) {
    throw new Error('下位机更新清单通道与所选通道不一致或不支持');
  }
}
