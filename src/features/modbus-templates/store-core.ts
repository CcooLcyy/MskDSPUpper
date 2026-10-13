import { MAX_PERSONAL_TEMPLATES, MAX_PERSONAL_TEMPLATE_BYTES, validateModbusTemplate } from './model.ts';
import type { ModbusTemplate } from './model.ts';

export function createPersonalTemplateStore(builtins: readonly ModbusTemplate[], storage: { read: () => unknown; write: (templates: ModbusTemplate[]) => Promise<void> }) {
  const builtinIds = new Set(builtins.map(template => template.id));
  let queue: Promise<void> = Promise.resolve();
  function validateList(raw: unknown): ModbusTemplate[] {
    if (raw === null || raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > MAX_PERSONAL_TEMPLATES) throw new Error(`个人模板目录必须是数组且最多 ${MAX_PERSONAL_TEMPLATES} 项`);
    if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_PERSONAL_TEMPLATE_BYTES) throw new Error('个人模板目录不能超过 50 MiB');
    const ids = new Set<string>();
    return raw.map(item => {
      const template = validateModbusTemplate(item);
      if (builtinIds.has(template.id)) throw new Error('个人模板不能覆盖内置模板');
      if (ids.has(template.id)) throw new Error('个人模板 ID 重复');
      ids.add(template.id);
      return template;
    });
  }
  function transact(update: (current: ModbusTemplate[]) => ModbusTemplate[]): Promise<void> {
    const task = queue.then(async () => { await storage.write(validateList(update(validateList(storage.read())))); });
    queue = task.catch(() => undefined);
    return task;
  }
  return {
    list: () => validateList(storage.read()),
    save: (raw: ModbusTemplate) => transact(current => {
      const template = validateModbusTemplate(raw);
      if (builtinIds.has(template.id)) throw new Error('不能覆盖内置模板');
      if (current.some(item => item.id === template.id)) throw new Error('个人模板 ID 重复，请使用新的模板名称保存');
      return [...current, template];
    }),
    remove: (id: string) => transact(current => {
      if (builtinIds.has(id)) throw new Error('内置模板不能删除');
      if (!current.some(item => item.id === id)) throw new Error('个人模板不存在');
      return current.filter(item => item.id !== id);
    }),
  };
}
