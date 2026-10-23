type OverviewPollingOptions<T> = {
  isCurrent: () => boolean;
  read: () => Promise<T>;
  onValue: (value: T) => void;
  onError: (error: unknown) => void;
  intervalMs: number;
};

/** 地址就绪后串行采样；失败继续重试，刷新代次失效或卸载后忽略迟到结果。 */
export function startOverviewPolling<T>(options: OverviewPollingOptions<T>): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const isActive = () => !cancelled && options.isCurrent();

  const poll = async () => {
    if (!isActive()) return;
    try {
      const value = await options.read();
      if (isActive()) options.onValue(value);
    } catch (error) {
      if (isActive()) options.onError(error);
    } finally {
      if (isActive()) {
        timer = setTimeout(() => { void poll(); }, options.intervalMs);
      }
    }
  };

  void poll();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
