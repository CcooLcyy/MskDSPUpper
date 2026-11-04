type RequestResult<T> = { current: true; value: T } | { current: false };

// 每个页面只接受最近一次读取；取消仅结束界面等待，底层 IPC 由后端超时收尾。
export function createModuleOpsRequestScope() {
  let active: AbortController | undefined;
  const cancel = () => {
    active?.abort();
    active = undefined;
  };
  return {
    cancel,
    async run<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<RequestResult<T>> {
      cancel();
      const controller = new AbortController();
      active = controller;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort = () => {};
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      if (timeoutMs !== undefined) timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const value = await Promise.race([work(controller.signal), interrupted]);
        if (active !== controller || controller.signal.aborted) return { current: false };
        return { current: true, value };
      } catch (error) {
        if (active !== controller) return { current: false };
        if (timedOut) throw new Error('无法连接：现场连接或读取超时，请检查地址和网络后重试');
        if (controller.signal.aborted) return { current: false };
        throw error;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        if (active === controller) active = undefined;
      }
    },
  };
}
