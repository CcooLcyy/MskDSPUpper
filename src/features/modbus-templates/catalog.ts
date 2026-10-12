import { getAppSetting, saveAppSetting } from '../../utils/app-settings';
import { MODBUS_TEMPLATES_SETTING_KEY } from '../../utils/app-settings-core';
import { MAX_TEMPLATE_FILE_BYTES, parseModbusTemplateJson, validateModbusTemplate } from './model';
import type { ModbusTemplate } from './model';
import { createPersonalTemplateStore } from './store-core';

export interface TemplateCatalogEntry { template: ModbusTemplate; origin: 'builtin' | 'personal' }
const builtinDocuments = import.meta.glob('./builtin/*.json', { eager: true, import: 'default' });
const builtinTemplates = Object.entries(builtinDocuments).map(([file, raw]) => {
  try { return validateModbusTemplate(raw); } catch (error) { throw new Error(`内置模板 ${file} 无效：${String(error)}`); }
});
if (new Set(builtinTemplates.map(template => template.id)).size !== builtinTemplates.length) throw new Error('内置模板 ID 重复');
const personalStore = createPersonalTemplateStore(builtinTemplates, {
  read: () => getAppSetting(MODBUS_TEMPLATES_SETTING_KEY),
  write: templates => saveAppSetting(MODBUS_TEMPLATES_SETTING_KEY, templates),
});

export function listModbusTemplates(): TemplateCatalogEntry[] {
  return [...builtinTemplates.map(template => ({ template, origin: 'builtin' as const })),
    ...personalStore.list().map(template => ({ template, origin: 'personal' as const }))];
}
export async function savePersonalTemplate(template: ModbusTemplate): Promise<void> {
  await personalStore.save(template);
  console.info('Modbus 个人模板已保存', { templateId: template.id, points: template.points.length });
}
export async function removePersonalTemplate(id: string): Promise<void> {
  await personalStore.remove(id);
  console.info('Modbus 个人模板已删除', { templateId: id });
}
export function exportModbusTemplate(template: ModbusTemplate): string {
  const json = JSON.stringify(validateModbusTemplate(template), null, 2) + '\n';
  if (new TextEncoder().encode(json).length > MAX_TEMPLATE_FILE_BYTES) throw new Error('模板导出文件不能超过 2 MiB');
  return json;
}
export async function importPersonalTemplate(json: string): Promise<ModbusTemplate> {
  const template = parseModbusTemplateJson(json);
  await savePersonalTemplate(template);
  return template;
}
export async function saveModbusTemplateFile(template: ModbusTemplate): Promise<boolean> {
  const contents = exportModbusTemplate(template);
  const filename = `${template.id}.json`;
  if ('__TAURI_INTERNALS__' in globalThis) {
    const [{ save }, { invoke }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/api/core')]);
    const path = await save({ defaultPath: filename, filters: [{ name: 'Modbus 点表模板', extensions: ['json'] }] });
    if (!path) return false;
    await invoke('save_modbus_template_export', { path, contents });
  } else {
    const url = URL.createObjectURL(new Blob([contents], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  console.info('Modbus 点表模板已导出', { templateId: template.id, points: template.points.length });
  return true;
}
