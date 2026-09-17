/**
 * 离线工作区不支持的操作。
 *
 * 离线模式下没有下位机可执行的控制/运行态语义（IEC61850、控制编排等），
 * 这些接口必须显式报错而不是静默成功，避免用户误以为配置已生效。
 */

export class OfflineUnsupportedError extends Error {
  /** 出错的接口名，便于日志定位。 */
  readonly apiName: string;

  constructor(apiName: string) {
    super(`离线工作区不支持该操作：${apiName}，请连接下位机后执行`);
    this.name = 'OfflineUnsupportedError';
    this.apiName = apiName;
  }
}

/** 统一的"离线不支持"处理器工厂，保证错误信息与日志一致。 */
export function unsupported(apiName: string): () => never {
  return () => {
    console.warn('[离线工作区] 调用了不支持的接口', { apiName });

    throw new OfflineUnsupportedError(apiName);
  };
}
