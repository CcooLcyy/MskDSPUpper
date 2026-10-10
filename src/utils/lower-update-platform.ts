import type { LowerUpdateChannel, LowerUpdateManifest, LowerUpdatePlatform } from '../adapters/types';

export function getLowerUpdateChannels(platform: LowerUpdatePlatform): LowerUpdateChannel[] {
  if (platform === 'linux-arm64') return ['stable', 'beta', 'ci'];
  if (platform === 'linux-x64') return ['ci'];
  throw new Error(`下位机更新架构不支持: ${platform}`);
}

export function getLowerUpdateChannel(platform: LowerUpdatePlatform, channel: LowerUpdateChannel): LowerUpdateChannel {
  const channels = getLowerUpdateChannels(platform);
  return channels.includes(channel) ? channel : channels[0];
}

// 检查源返回的架构和通道，避免错误源配置导致下载另一架构的包。
export function assertLowerUpdateManifest(
  manifest: Pick<LowerUpdateManifest, 'platform' | 'channel'>,
  platform: LowerUpdatePlatform,
  channel: LowerUpdateChannel,
): void {
  if (manifest.platform !== platform) throw new Error('下位机更新清单架构与所选架构不一致');
  if (!getLowerUpdateChannels(platform).includes(channel) || manifest.channel !== channel) {
    throw new Error('下位机更新清单通道与所选通道不一致或不支持');
  }
}
