let target = { revision: 0, pending: 0 };
const listeners = new Set<() => void>();

function update(pending: number) {
  target = { revision: target.revision + 1, pending };
  listeners.forEach((listener) => listener());
}

export function getConfigDraftTarget() {
  return target;
}

export function subscribeConfigDraftTarget(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// 路由可能在设备切换请求返回前变化，配置页要等切换落定再读取草稿作用域。
export async function changeConfigDraftTarget<T>(change: () => Promise<T>): Promise<T> {
  update(target.pending + 1);
  try {
    return await change();
  } finally {
    update(target.pending - 1);
  }
}
