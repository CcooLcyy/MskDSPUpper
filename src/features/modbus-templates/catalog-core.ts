import { parseModbusTemplateJson } from './model.ts';
import type { ModbusTemplate } from './model.ts';
export interface PlatformTemplateSummary {
  id: string;
  revision: string;
  name: string;
  manufacturer: string;
  models: string[];
  protocol_version: string;
  point_count: number;
  updated_at: number;
}
export interface PlatformTemplateRecord {
  id: string;
  revision: string;
  template_json: string;
  created_at: number;
  updated_at: number;
}
export interface PlatformTemplateEntry {
  summary: PlatformTemplateSummary;
  template: ModbusTemplate;
  platformId: string;
  cached: boolean;
}
export const normalizePlatformId = (value: string) => value.trim().replace(/\/+$/, '');
const positiveRevision = (value: unknown): value is string => typeof value === 'string' && value.length <= 20 && /^[1-9]\d*$/.test(value) && BigInt(value) <= 18446744073709551615n;
export function validateSummary(value: PlatformTemplateSummary): PlatformTemplateSummary {
  if (!value || typeof value.id !== 'string' || !value.id || !positiveRevision(value.revision) || typeof value.name !== 'string' || typeof value.manufacturer !== 'string' || !Array.isArray(value.models) || value.models.some(x => typeof x !== 'string') || typeof value.protocol_version !== 'string' || !Number.isInteger(value.point_count) || value.point_count < 1 || value.point_count > 10000 || !Number.isFinite(value.updated_at)) throw Error('平台点表目录格式不合法');
  return value;
}
const networkFailure = (error: unknown) => /^(连接平台点表服务失败|平台点表请求超时|平台点表服务暂时不可用)/.test(String(error instanceof Error ? error.message : error));
/** 缓存只接受通过平台返回并验证的数据；鉴权和平台身份在请求前后再次检查。 */
export function createPlatformCatalog(io: {
  read: (key: string) => unknown;
  write: (key: string, value: unknown) => void | Promise<void>;
  verify: (platformId: string) => Promise<void>;
  list: () => Promise<PlatformTemplateSummary[]>;
  get: (id: string, revision?: string) => Promise<PlatformTemplateRecord>;
}) {
  const key = (platformId: string, suffix: string) => `protocol.modbus.platform-cache.v1:${encodeURIComponent(normalizePlatformId(platformId))}:${suffix}`;
  return {
    async list(platformId: string): Promise<{
      summaries: PlatformTemplateSummary[];
      cached: boolean;
    }> {
      await io.verify(platformId);
      let summaries: PlatformTemplateSummary[];
      try {
        summaries = await io.list();
      } catch (error) {
        await io.verify(platformId);
        if (!networkFailure(error)) throw error;
        const cached = io.read(key(platformId, 'catalog'));
        if (!Array.isArray(cached)) throw error;
        return {
          summaries: cached.map(validateSummary),
          cached: true
        };
      }
      await io.verify(platformId);
      if (!Array.isArray(summaries) || summaries.length > 1000) throw Error('平台点表目录数量不合法');
      summaries = summaries.map(validateSummary);
      if (new Set(summaries.map(x => x.id)).size !== summaries.length) throw Error('平台点表目录ID重复');
      await io.write(key(platformId, 'catalog'), summaries);
      return {
        summaries,
        cached: false
      };
    },
    async get(platformId: string, id: string, revision: string): Promise<PlatformTemplateEntry> {
      await io.verify(platformId);
      let record: PlatformTemplateRecord;
      let cached = false;
      try {
        record = await io.get(id, revision);
      } catch (error) {
        await io.verify(platformId);
        if (!networkFailure(error)) throw error;
        const value = io.read(key(platformId, `${encodeURIComponent(id)}:${revision}`));
        if (!value) throw error;
        record = value as PlatformTemplateRecord;
        cached = true;
      }
      await io.verify(platformId);
      if (!record || record.id !== id || record.revision !== revision || !positiveRevision(record.revision) || typeof record.template_json !== 'string') throw Error('平台点表内容与请求版本不一致');
      const template = parseModbusTemplateJson(record.template_json);
      if (!cached) await io.write(key(platformId, `${encodeURIComponent(id)}:${revision}`), record);
      return {
        template,
        platformId: normalizePlatformId(platformId),
        cached,
        summary: {
          id,
          revision,
          name: template.name,
          manufacturer: template.manufacturer,
          models: template.models,
          protocol_version: template.protocol_version,
          point_count: template.points.length,
          updated_at: record.updated_at
        }
      };
    }
  };
}
