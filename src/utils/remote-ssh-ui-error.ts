/** 只用于状态反馈，绝不把已输入的凭据带到错误文字中。 */
export function sshUiError(error: unknown, secrets: readonly string[] = []): string {
  let message = typeof error === 'string' ? error
    : error instanceof Error ? error.message
      : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '';
  for (const secret of secrets) if (secret) message = message.split(secret).join('[已隐藏]');
  return message.trim().slice(0, 512) || 'SSH 操作失败，请重试';
}
