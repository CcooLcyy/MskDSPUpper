/** 上下位机安装包共用的平台地址设置。 */
export const SOFTWARE_PLATFORM_ENDPOINT_KEY = 'softwarePlatformGrpcEndpoint';
export const DEFAULT_SOFTWARE_PLATFORM_ENDPOINT = 'http://192.168.10.198:50000';

/** 前端校验地址结构；明文网络范围与 TLS 由 Rust 权威校验。 */
export function normalizeSoftwarePlatformEndpoint(value: string): string {
  const input = value.trim();
  if (!input || Array.from(input).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
    throw new Error('请输入完整的平台地址，例如 http://192.168.10.198:50000');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('平台地址格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('平台地址只允许 HTTP(S) 主机和端口，不能包含账号、路径或查询参数');
  }
  return url.origin;
}
