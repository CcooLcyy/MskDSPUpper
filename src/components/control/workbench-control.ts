export type ControlWorkbenchView = 'engineering' | 'runtime';

/** 工作视图仅选择展示列，不修改配置和运行状态。 */
export function selectControlMemberColumns<T extends { key?: unknown }>(columns: T[], view: ControlWorkbenchView): T[] {
  const runtimeKeys = new Set(['member_name', 'p_meas_value', 'p_set_value', 'q_meas_value', 'q_set_value', 'controllable', 'runtime_quality']);
  return columns.filter((column) => view === 'runtime'
    ? runtimeKeys.has(String(column.key))
    : !String(column.key).endsWith('_value') && column.key !== 'runtime_quality');
}

/** 数据总线的实际展示由工作视图决定，切换时保留页面内筛选和草稿。 */
export const dataBusViewForWorkbench = (view: ControlWorkbenchView): 'config' | 'monitor' => (
  view === 'runtime' ? 'monitor' : 'config'
);

/** 仅明确的地址参数才改变工作视图，普通进入页面沿用当前工作视图。 */
export const workbenchViewForDataBusQuery = (query: string | null): ControlWorkbenchView | null => (
  query === 'monitor' ? 'runtime' : query === 'config' ? 'engineering' : null
);

/** 已处理的地址不因能力或回调变化重放，避免返回在线时覆盖用户的新偏好。 */
export function applyDataBusQueryView(
  query: string | null,
  handled: { current: string | null | undefined },
  setView: (view: ControlWorkbenchView) => void,
): void {
  if (handled.current === query) return;
  handled.current = query;
  const nextView = workbenchViewForDataBusQuery(query);
  if (nextView) {
    console.info('数据总线已处理明确视图导航，后续能力变化不重放', { 视图: nextView });
    setView(nextView);
  }
}

/** 展示时钟独立于点值读取，即使请求未完成也能及时标识陈旧数据。 */
export function startControlDisplayClock(onTick: (now: number) => void): () => void {
  const firstTick = setTimeout(() => onTick(Date.now()), 0);
  const timer = setInterval(() => onTick(Date.now()), 1000);
  return () => { clearTimeout(firstTick); clearInterval(timer); };
}
