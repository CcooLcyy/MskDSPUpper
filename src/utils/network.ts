const IPV4_SEGMENT_PATTERN = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_PATTERN = new RegExp(`^(?:${IPV4_SEGMENT_PATTERN}\\.){3}${IPV4_SEGMENT_PATTERN}$`);
const DIGITS_ONLY_PATTERN = /^\d+$/;
const DIGITS_AND_DOTS_PATTERN = /^[\d.]+$/;
const HOSTNAME_LABEL_PATTERN = /^[A-Za-z0-9-]+$/;

const isValidHostnameLabel = (label: string): boolean =>
  label.length > 0
  && label.length <= 63
  && !label.startsWith('-')
  && !label.endsWith('-')
  && HOSTNAME_LABEL_PATTERN.test(label);

const isValidHostname = (host: string): boolean =>
  host.length > 0
  && host.length <= 253
  && !host.startsWith('.')
  && !host.endsWith('.')
  && host.split('.').every(isValidHostnameLabel);

const isValidHost = (host: string): boolean => {
  if (DIGITS_AND_DOTS_PATTERN.test(host)) {
    return IPV4_PATTERN.test(host);
  }

  return isValidHostname(host);
};

export const validateManagerAddress = (
  value: string,
): { ok: true; normalized: string } | { ok: false; error: string } => {
  const trimmed = value.trim();

  if (!trimmed) {
    return { ok: false, error: '请输入 ModuleManager 地址' };
  }

  const separatorIndex = trimmed.lastIndexOf(':');
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return { ok: false, error: '地址格式应为 host:port' };
  }

  const host = trimmed.slice(0, separatorIndex).trim();
  const portText = trimmed.slice(separatorIndex + 1).trim();

  if (!isValidHost(host)) {
    return { ok: false, error: '请输入合法的 IPv4 地址或主机名' };
  }

  if (!DIGITS_ONLY_PATTERN.test(portText)) {
    return { ok: false, error: '端口必须是整数' };
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: '端口范围必须在 1-65535 之间' };
  }

  return {
    ok: true,
    normalized: `${host}:${port}`,
  };
};
