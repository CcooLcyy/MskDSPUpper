export interface MqttConfigQueryResult<T> {
  configured: boolean;
  mqtt: T | null;
  message: string;
}

export interface MqttConfigInitializationOptions<T> {
  getConfig: () => Promise<MqttConfigQueryResult<T>>;
  updateConfig: (config: T) => Promise<unknown>;
  refreshRuntime?: () => Promise<unknown>;
  storedConfig: T | null;
  defaultConfig: T;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
  isCancelled?: () => boolean;
}

export interface MqttConfigInitializationResult<T> {
  config: T;
  initialized: boolean;
  cancelled?: boolean;
}

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** 查询模块端配置，仅在缺失时恢复本地配置或写入默认配置。 */
export async function initializeMqttConfig<T>(
  options: MqttConfigInitializationOptions<T>,
): Promise<MqttConfigInitializationResult<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 6);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown = new Error('未收到 MQTT 配置响应');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (options.isCancelled?.()) {
        return { config: options.storedConfig ?? options.defaultConfig, initialized: false, cancelled: true };
      }
      await options.refreshRuntime?.();
      const result = await options.getConfig();
      if (result.configured) {
        if (result.mqtt === null) {
          throw new Error('模块返回 configured=true 但未提供 MQTT 配置');
        }
        return { config: result.mqtt, initialized: false };
      }

      const config = options.storedConfig ?? options.defaultConfig;
      if (options.isCancelled?.()) {
        return { config, initialized: false, cancelled: true };
      }
      await options.updateConfig(config);
      return { config, initialized: true };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        options.onRetry?.(attempt, error);
        await sleep(retryDelayMs);
      }
    }
  }

  throw new Error(`初始化 MQTT 默认配置失败（已尝试 ${maxAttempts} 次）：${errorText(lastError)}`);
}
