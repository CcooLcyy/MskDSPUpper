import type { CalcGroupConfig, CalcItemConfig, CalcOperandSpec, DcEndpoint, DcRoute } from '../adapters/types';
import type { api as tauriApi } from '../adapters/tauri';
import { calcUsesOperandList } from './calc-operands.ts';

export type CalcRoutePlan = {
  routes: DcRoute[];
  removedRoutes: DcRoute[];
  protection?: {
    groupName: string;
    inputTags: string[];
    outputTags: string[];
    baselineRoutes: DcRoute[];
  };
};
export type CalcRouteApi = Pick<typeof tauriApi,
  'calcGetGroup' | 'calcStopGroup' | 'calcStartGroup' | 'calcUpsertGroup' | 'dcUpsertRoutes' | 'dcDeleteRoutes'>
  & Partial<Pick<typeof tauriApi, 'dcListRoutes'>>;

const isAggregate = calcUsesOperandList;

/** 返回按输入行顺序派生的完整标签；常量行也占据对应序号。 */
export function calcInputTags(item: CalcItemConfig): string[] {
  const suffixes = isAggregate(item)
    ? (item.operands ?? []).map((_, index) => `input_${index + 1}`)
    : item.operator_kind === 5 ? ['left_input'] : ['left_input', 'right_input'];
  return suffixes.map((suffix) => `${item.item_name.trim()}/${suffix}`);
}

function operands(item: CalcItemConfig): Array<CalcOperandSpec | null> {
  return isAggregate(item) ? item.operands : item.operator_kind === 5
    ? [item.left_operand] : [item.left_operand, item.right_operand];
}

const stableEndpoint = (endpoint: DcEndpoint): DcEndpoint => ({
  module_name: endpoint.module_name.trim(), conn_name: endpoint.conn_name.trim(), tag: endpoint.tag.trim(),
});
const endpointKey = (endpoint: DcEndpoint): string => JSON.stringify(stableEndpoint(endpoint));
const routeKey = (route: DcRoute): string => JSON.stringify([endpointKey(route.src), endpointKey(route.dst)]);
const stableRoute = (route: DcRoute): DcRoute => ({ src: stableEndpoint(route.src), dst: stableEndpoint(route.dst) });

/** 依据编辑行携带的来源计算迁移计划，只清理本项精确标签，不使用名称前缀匹配。 */
export function buildCalcRoutePlan(options: {
  groupName: string;
  previousItem: CalcItemConfig | null;
  item: CalcItemConfig | null;
  inputSources: DcEndpoint[][];
  outputs: DcEndpoint[];
  baselineRoutes: DcRoute[];
}): CalcRoutePlan {
  const groupName = options.groupName.trim();
  if (!groupName) throw new Error('计算分组名称不能为空');
  const inputTags = new Set<string>();
  const outputTags = new Set<string>();
  for (const item of [options.previousItem, options.item]) {
    if (!item) continue;
    calcInputTags(item).forEach((tag) => inputTags.add(tag));
    outputTags.add(`${item.item_name.trim()}/result`);
  }
  const isLocal = (endpoint: DcEndpoint): boolean => endpoint.module_name === 'Calc' && endpoint.conn_name === groupName;
  const baseline = options.baselineRoutes.map(stableRoute);
  const owned = baseline.filter((route) => (isLocal(route.dst) && inputTags.has(route.dst.tag))
    || (isLocal(route.src) && outputTags.has(route.src.tag)));
  const legacyInputs = new Set(owned.filter((route) => isLocal(route.dst) && inputTags.has(route.dst.tag)).map((route) => endpointKey(route.src)));
  const legacyOutputs = new Set(owned.filter((route) => isLocal(route.src) && outputTags.has(route.src.tag)).map((route) => endpointKey(route.dst)));
  const desired = new Map<string, DcRoute>();
  const add = (external: DcEndpoint, tag: string, direction: 'input' | 'output') => {
    const endpoint = stableEndpoint(external);
    if (!endpoint.module_name || !endpoint.conn_name || !endpoint.tag) throw new Error('关联点位必须包含完整模块、连接和标签');
    if (isLocal(endpoint) && !(direction === 'input' ? legacyInputs : legacyOutputs).has(endpointKey(endpoint))) {
      throw new Error('不能新增指向当前计算分组的循环关联');
    }
    const local = { module_name: 'Calc', conn_name: groupName, tag };
    const route = direction === 'input' ? { src: endpoint, dst: local } : { src: local, dst: endpoint };
    desired.set(routeKey(route), route);
  };
  if (options.item) {
    const item = options.item;
    if (!item.item_name.trim()) throw new Error('计算项名称不能为空');
    const tags = calcInputTags(item);
    operands(item).forEach((operand, index) => {
      if (operand?.source_kind === 1) (options.inputSources[index] ?? []).forEach((source) => add(source, tags[index], 'input'));
    });
    options.outputs.forEach((destination) => add(destination, `${item.item_name.trim()}/result`, 'output'));
  }
  const removed = new Map<string, DcRoute>();
  owned.forEach((route) => { if (!desired.has(routeKey(route))) removed.set(routeKey(route), route); });
  console.info('数值计算关联计划已生成', { 分组: groupName, 计算项: options.item?.item_name ?? options.previousItem?.item_name, 建立数量: desired.size, 解除数量: removed.size });
  return {
    routes: [...desired.values()], removedRoutes: [...removed.values()],
    protection: { groupName, inputTags: [...inputTags], outputTags: [...outputTags], baselineRoutes: owned },
  };
}

/** 初次保存保护本项基线；重试接受自身可能完成的部分写入，但不覆盖外部新增或删除。 */
async function verifyRouteBaseline(plan: CalcRoutePlan, api: CalcRouteApi, retry: boolean): Promise<void> {
  const protection = plan.protection;
  if (!protection) return;
  if (!api.dcListRoutes) throw new Error('缺少路由读取接口，无法确认已有点位关联');
  const latest = await api.dcListRoutes(0, '', 0, '');
  const isLocal = (endpoint: DcEndpoint): boolean => endpoint.module_name === 'Calc' && endpoint.conn_name === protection.groupName;
  const inputTags = new Set(protection.inputTags);
  const outputTags = new Set(protection.outputTags);
  const scoped = latest.map(stableRoute).filter((route) => (isLocal(route.dst) && inputTags.has(route.dst.tag))
    || (isLocal(route.src) && outputTags.has(route.src.tag)));
  const currentKeys = new Set(scoped.map(routeKey));
  const baselineKeys = new Set(protection.baselineRoutes.map(routeKey));
  const conflict = () => new Error('当前计算项路由已被外部变更，请重新加载关联后再处理，当前草稿及重试计划已保留');
  if (!retry) {
    if (currentKeys.size !== baselineKeys.size || [...currentKeys].some((key) => !baselineKeys.has(key))) throw conflict();
    return;
  }
  const desiredKeys = new Set(plan.routes.map(routeKey));
  // 新增、删除接口可能部分完成；只允许本计划中的新旧关联组合。
  const allowed = new Set([...baselineKeys, ...desiredKeys]);
  if ([...currentKeys].some((key) => !allowed.has(key))) throw conflict();
  // 同时存在于基线和目标集合的路由不会被本计划删除，其缺失属于外部变化。
  if ([...baselineKeys].some((key) => desiredKeys.has(key) && !currentKeys.has(key))) throw conflict();
}

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)]));
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

export class CalcSaveError extends Error {
  readonly configSaved: boolean;
  readonly phase: 'config' | 'routes' | 'restart';
  readonly config: CalcGroupConfig;
  readonly plan: CalcRoutePlan;
  readonly wasRunning: boolean;

  constructor(options: { phase: CalcSaveError['phase']; config: CalcGroupConfig; plan: CalcRoutePlan; wasRunning: boolean; cause: unknown; extra?: string }) {
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause);
    const prefix = options.phase === 'config' ? '计算配置保存失败'
      : options.phase === 'routes' ? '计算已保存，路由同步失败' : '计算与路由已保存，恢复分组功能状态失败';
    super(`${prefix}：${detail}${options.extra ?? ''}`, { cause: options.cause });
    this.name = 'CalcSaveError';
    this.configSaved = options.phase !== 'config';
    this.phase = options.phase;
    this.config = structuredClone(options.config);
    this.plan = structuredClone(options.plan);
    this.wasRunning = options.wasRunning;
  }
}

/** 停止后确认服务端状态，避免将异步停止成功误认为功能已经停止。 */
async function ensureStopped(groupName: string, api: CalcRouteApi): Promise<void> {
  let current = await api.calcGetGroup(groupName);
  if (current.state === 3) throw new Error('计算分组处于待删除状态');
  if (current.state !== 2) return;
  await api.calcStopGroup(groupName);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    current = await api.calcGetGroup(groupName);
    if (current.state !== 2) return;
    if (attempt < 9) await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
  }
  throw new Error('计算分组功能尚未停止，请稍后重试');
}

async function applyRoutes(plan: CalcRoutePlan, api: CalcRouteApi): Promise<void> {
  if (plan.routes.length) await api.dcUpsertRoutes(plan.routes, false);
  if (plan.removedRoutes.length) await api.dcDeleteRoutes(plan.removedRoutes);
}

async function restoreRuntime(config: CalcGroupConfig, wasRunning: boolean, api: CalcRouteApi): Promise<void> {
  if (wasRunning) await api.calcStartGroup(config.group_name);
  else await ensureStopped(config.group_name, api);
}

/** 配置、路由、运行恢复分别报告；路由失败后不恢复运行，保留精确重试计划。 */
export async function saveCalcWithRoutes(options: {
  config: CalcGroupConfig;
  expectedConfig: CalcGroupConfig;
  plan: CalcRoutePlan;
  api: CalcRouteApi;
}): Promise<void> {
  const { config, expectedConfig, plan, api } = options;
  const current = await api.calcGetGroup(config.group_name);
  if (canonical(current.config) !== canonical(expectedConfig)) throw new Error('计算分组配置已被外部变更，请重新加载后再保存，当前草稿已保留');
  if (current.state === 3) throw new Error('计算分组处于待删除状态');
  await verifyRouteBaseline(plan, api, false);
  const wasRunning = current.state === 2;
  try {
    await ensureStopped(config.group_name, api);
    await api.calcUpsertGroup(config, false);
    console.info('数值计算配置已保存，开始同步关联', { 分组: config.group_name });
  } catch (cause) {
    let extra = '';
    if (wasRunning) {
      try { await api.calcStartGroup(config.group_name); }
      catch (restartError) { extra = `；恢复原运行状态失败：${restartError instanceof Error ? restartError.message : String(restartError)}`; }
    }
    console.error('数值计算配置保存失败', { 分组: config.group_name, 错误: cause, 恢复结果: extra });
    throw new CalcSaveError({ phase: 'config', config, plan, wasRunning, cause, extra });
  }
  try {
    // 下位机更新配置可能自动运行，必须再次核对后才写入路由。
    await ensureStopped(config.group_name, api);
    await applyRoutes(plan, api);
    console.info('数值计算路由同步完成', { 分组: config.group_name, 建立数量: plan.routes.length, 解除数量: plan.removedRoutes.length });
  } catch (cause) {
    console.error('数值计算路由同步失败，保留待重试计划', { 分组: config.group_name, 错误: cause });
    throw new CalcSaveError({ phase: 'routes', config, plan, wasRunning, cause });
  }
  try { await restoreRuntime(config, wasRunning, api); }
  catch (cause) { throw new CalcSaveError({ phase: 'restart', config, plan, wasRunning, cause }); }
  console.info('数值计算配置与关联保存完成', { 分组: config.group_name, 恢复运行: wasRunning });
}

/** 先核对已保存配置，仅补做路由或恢复，不重复写入计算配置。 */
export async function retryCalcRoutes(error: CalcSaveError, api: CalcRouteApi): Promise<void> {
  if (!error.configSaved) throw new Error('计算配置尚未保存，请重新保存计算与关联');
  const current = await api.calcGetGroup(error.config.group_name);
  if (canonical(current.config) !== canonical(error.config)) throw new Error('已保存的计算配置又发生变化，请重新加载后处理，旧重试计划未执行');
  if (current.state === 3) throw new Error('计算分组处于待删除状态');
  await verifyRouteBaseline(error.plan, api, true);
  if (error.phase === 'routes') {
    try {
      await ensureStopped(error.config.group_name, api);
      await applyRoutes(error.plan, api);
    } catch (cause) { throw new CalcSaveError({ ...error, phase: 'routes', cause }); }
  }
  try { await restoreRuntime(error.config, error.wasRunning, api); }
  catch (cause) { throw new CalcSaveError({ ...error, phase: 'restart', cause }); }
  console.info('数值计算关联重试完成', { 分组: error.config.group_name, 阶段: error.phase });
}
