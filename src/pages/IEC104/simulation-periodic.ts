import type { Iec104SimulationPeriodicStatus } from '../../adapters/types.ts';

export const DEFAULT_SIMULATION_INTERVAL = 5;

export function validateSimulationInterval(value: number | null): number {
  if (value === null || !Number.isInteger(value) || value < 1 || value > 3600) {
    throw new Error('周期上报间隔必须是 1～3600 秒的整数');
  }
  return value;
}

/** 关闭使用服务端已生效间隔，避免无效输入阻挡停止任务。 */
export function getSimulationPeriodicInterval(enabled: boolean, draft: number | null, current: number, changingInterval = false): number {
  return validateSimulationInterval(!enabled && !changingInterval ? current : draft);
}

type MockContext = { slave: boolean; hasSimulation: boolean; active: boolean };
type MockOptions = {
  context: (connName: string) => MockContext | undefined;
  now: () => number;
  schedule: (callback: () => void, intervalMs: number) => () => void;
};

/** 浏览器模式模拟定时任务；查询不推进任务，时钟与调度器可注入验证。 */
export function createSimulationPeriodicMock(options: MockOptions) {
  const states = new Map<string, Iec104SimulationPeriodicStatus>();
  const cancelByName = new Map<string, () => void>();
  const requireContext = (connName: string) => {
    const context = options.context(connName);
    if (!context) throw new Error(`未找到 IEC104 连接：${connName}`);
    return context;
  };
  const get = (connName: string): Iec104SimulationPeriodicStatus => {
    const context = requireContext(connName);
    const state = states.get(connName) ?? {
      conn_name: connName, enabled: false, interval_seconds: DEFAULT_SIMULATION_INTERVAL,
      running: false, last_sent_ms: 0,
    };
    return { ...state, running: state.enabled && context.slave && context.hasSimulation && context.active };
  };
  const stop = (connName: string) => {
    cancelByName.get(connName)?.();
    cancelByName.delete(connName);
  };
  const controller = {
    get,
    set(connName: string, enabled: boolean, intervalSeconds: number) {
      const interval = validateSimulationInterval(intervalSeconds);
      const context = requireContext(connName);
      if (!context.slave) throw new Error('仅 IEC104 从站支持模拟值周期上报');
      if (enabled && !context.hasSimulation) throw new Error('请先生成或保存模拟值');
      const previous = get(connName);
      if (previous.enabled === enabled && previous.interval_seconds === interval) return previous;
      stop(connName);
      states.set(connName, { ...previous, enabled, interval_seconds: interval });
      if (enabled) {
        cancelByName.set(connName, options.schedule(() => {
          const state = states.get(connName);
          if (state && get(connName).running) state.last_sent_ms = options.now();
        }, interval * 1000));
      }
      return get(connName);
    },
    clear(connName: string) {
      stop(connName);
      const previous = states.get(connName);
      if (previous) states.set(connName, { ...previous, enabled: false, running: false });
    },
    remove(connName: string) {
      stop(connName);
      states.delete(connName);
    },
    rename(oldConnName: string, newConnName: string) {
      if (oldConnName === newConnName) return;
      const previous = states.get(oldConnName);
      stop(oldConnName);
      states.delete(oldConnName);
      if (previous) {
        states.set(newConnName, { ...previous, conn_name: newConnName, enabled: false, running: false });
        controller.set(newConnName, previous.enabled, previous.interval_seconds);
      }
    },
  };
  return controller;
}
