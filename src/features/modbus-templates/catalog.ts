import { invoke } from '@tauri-apps/api/core';
import { getAppSetting, saveAppSetting } from '../../utils/app-settings';
import { MODBUS_PLATFORM_CACHE_SETTING_KEY } from '../../utils/app-settings-core';
import { platformAuthApi } from '../../auth/platform-auth-api';
import { createPlatformCatalog, normalizePlatformId, validateSummary } from './catalog-core';
import type { PlatformTemplateRecord, PlatformTemplateSummary } from './catalog-core';
interface CatalogCache {
  schema_version: 1;
  entries: Record<string, {
    value: unknown;
    used_at: number;
  }>;
}
let cacheWriteQueue = Promise.resolve();
const readCache = (): CatalogCache => {
  const value = getAppSetting<CatalogCache>(MODBUS_PLATFORM_CACHE_SETTING_KEY);
  return value?.schema_version === 1 && value.entries && typeof value.entries === 'object' ? value : {
    schema_version: 1,
    entries: {}
  };
};
export function cachedPlatformSummaries(platformId: string): PlatformTemplateSummary[] | null {
  const key = `protocol.modbus.platform-cache.v1:${encodeURIComponent(normalizePlatformId(platformId))}:catalog`;
  const value = readCache().entries[key]?.value;
  try {
    return Array.isArray(value) ? value.map(validateSummary) : null;
  } catch {
    return null;
  }
}
function writeCache(key: string, value: unknown, verify: () => Promise<void>): Promise<void> {
  const operation = cacheWriteQueue.catch(() => undefined).then(async () => {
    await verify();
    const cache = readCache();
    const entries = {
      ...cache.entries,
      [key]: {
        value,
        used_at: Date.now()
      }
    };
    const victims = Object.keys(entries).filter(item => item !== key).sort((a, b) => (entries[a].used_at ?? 0) - (entries[b].used_at ?? 0));
    const document: CatalogCache = {
      schema_version: 1,
      entries
    };
    while (Object.keys(entries).length > 2001 || new TextEncoder().encode(JSON.stringify(document)).length > 50 * 1024 * 1024) {
      const victim = victims.shift();
      if (!victim) throw Error('平台点表缓存超过50MiB');
      delete entries[victim];
    }
    await verify();
    await saveAppSetting(MODBUS_PLATFORM_CACHE_SETTING_KEY, document);
  });
  cacheWriteQueue = operation.catch(error => {
    console.warn('平台点表缓存保存失败', error);
  });
  return operation;
}
/** 不提供本地模板目录；缓存读取与远程读取均受现有登录会话限制。 */
export function platformTemplateCatalog(platformId: string, username: string, isCurrent: () => boolean) {
  const verify = async (expected: string) => {
    if (!isCurrent()) throw Error('平台登录会话已变化，请重新打开模板窗口');
    const [status, settings] = await Promise.all([platformAuthApi.getStatus(), platformAuthApi.getSettings()]);
    if (!isCurrent() || !status.authenticated || status.username !== username || status.expires_at === null || status.expires_at <= Date.now() || normalizePlatformId(settings.grpc_endpoint) !== normalizePlatformId(expected) || normalizePlatformId(platformId) !== normalizePlatformId(expected)) throw Error('平台登录已失效或平台已切换，请重新登录');
  };
  return createPlatformCatalog({
    read: key => readCache().entries[key]?.value,
    write: async (key, value) => {
      try {
        await writeCache(key, value, () => verify(platformId));
      } catch (error) {
        await verify(platformId);
        console.warn('平台点表已获取，但缓存未能持久化', error);
      }
    },
    verify,
    list: () => invoke<PlatformTemplateSummary[]>('list_platform_modbus_templates'),
    get: (id, revision) => invoke<PlatformTemplateRecord>('get_platform_modbus_template', {
      id,
      revision
    })
  });
}
