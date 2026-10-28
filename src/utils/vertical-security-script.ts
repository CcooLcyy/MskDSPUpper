import { save } from '@tauri-apps/plugin-dialog';
import { api } from '../adapters';
import type {
  LowerUpdateSshAuth,
  VerticalSecurityDeployResult,
  VerticalSecurityStatusRequest,
  VerticalSecurityStatusResult,
} from '../adapters';

export type VerticalSecurityScriptValues = {
  device: string;
  localRtuAddress: string;
  localSecurityAddress: string;
  localGatewayAddress: string;
  remoteRtuAddress: string;
  remoteSecurityAddress: string;
  remoteGatewayAddress: string;
};

const DEFAULT_SCRIPT_FILE_NAME = 'mskdsp-vertical-security.sh';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requireScriptValue(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name}不能为空`);
  }
  if (/\r|\n/.test(normalized)) {
    throw new Error(`${name}不能包含换行`);
  }
  return normalized;
}

export function isValidIpv4Address(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim();
  const octets = normalized.split('.');
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet) || (octet.length > 1 && octet.startsWith('0'))) {
      return false;
    }
    const number = Number(octet);
    return number >= 0 && number <= 255;
  });
}

function requireIpv4Address(name: string, value: string): string {
  const normalized = requireScriptValue(name, value);
  if (!isValidIpv4Address(normalized)) {
    throw new Error(`${name}必须是合法 IPv4 地址`);
  }
  return normalized;
}

export function buildVerticalSecurityScript(values: VerticalSecurityScriptValues): string {
  const device = requireScriptValue('目标设备', values.device);
  const localRtuAddress = requireIpv4Address('本地 RTU 地址', values.localRtuAddress);
  const localSecurityAddress = requireIpv4Address('本地纵密地址', values.localSecurityAddress);
  const localGatewayAddress = requireIpv4Address('本地网关地址', values.localGatewayAddress);
  const remoteRtuAddress = requireIpv4Address('远程 RTU 地址', values.remoteRtuAddress);
  const remoteSecurityAddress = requireIpv4Address('远程纵密地址', values.remoteSecurityAddress);
  const remoteGatewayAddress = requireIpv4Address('远程网关地址', values.remoteGatewayAddress);

  return `#!/usr/bin/env bash
set -Eeuo pipefail

# MskDSP 纵密业务网络配置脚本
# 维护访问通路由纵密访问页面独立配置及恢复，本脚本不管理维护地址或规则。

readonly TARGET_DEVICE=${shellQuote(device)}
readonly LOCAL_RTU_ADDRESS=${shellQuote(localRtuAddress)}
readonly LOCAL_SECURITY_ADDRESS=${shellQuote(localSecurityAddress)}
readonly LOCAL_GATEWAY_ADDRESS=${shellQuote(localGatewayAddress)}
readonly REMOTE_RTU_ADDRESS=${shellQuote(remoteRtuAddress)}
readonly REMOTE_SECURITY_ADDRESS=${shellQuote(remoteSecurityAddress)}
readonly REMOTE_GATEWAY_ADDRESS=${shellQuote(remoteGatewayAddress)}
readonly CONFIG_DIR='/etc/mskdsp'
readonly CONFIG_FILE="\${CONFIG_DIR}/vertical-security.conf"
readonly PENDING_NAT_FILE="\${CONFIG_DIR}/vertical-security-nat.pending"
readonly STATUS_DIR='/run/mskdsp-vertical-security'
readonly STATUS_LOG="\${STATUS_DIR}/steps.log"
readonly STATUS_CURRENT="\${STATUS_DIR}/current"

WATCH_PPP=0
if [[ "$#" -gt 1 || ( "$#" -eq 1 && "\${1:-}" != '--watch-ppp' ) ]]; then
  echo '参数无效：仅支持 --watch-ppp' >&2
  exit 2
fi
if [[ "\${1:-}" == '--watch-ppp' ]]; then
  WATCH_PPP=1
fi
CONNTRACK_TIMEOUT_PENDING_RESTORE=0

write_step_status() {
  local status="$1"
  local message="$2"
  local timestamp
  timestamp="$(date +%s)"

  install -d -m 0755 "\${STATUS_DIR}"
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${timestamp}" "\${CURRENT_STEP_ID}" "\${CURRENT_STEP_NAME}" "\${status}" "\${message}" >> "\${STATUS_LOG}"
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${timestamp}" "\${CURRENT_STEP_ID}" "\${CURRENT_STEP_NAME}" "\${status}" "\${message}" > "\${STATUS_CURRENT}.tmp"
  mv -f "\${STATUS_CURRENT}.tmp" "\${STATUS_CURRENT}"
}

begin_step() {
  CURRENT_STEP_ID="$1"
  CURRENT_STEP_NAME="$2"
  write_step_status 'running' "$3"
}

complete_step() {
  write_step_status 'success' "$1"
}

handle_step_error() {
  local exit_code="$?"
  trap - ERR
  write_step_status 'failed' "执行失败，退出码：\${exit_code}" || true
  exit "\${exit_code}"
}

restore_conntrack_timeout() {
  if [[ "\${CONNTRACK_TIMEOUT_PENDING_RESTORE}" == '1' ]]; then
    if sysctl -w net.netfilter.nf_conntrack_generic_timeout=600; then
      CONNTRACK_TIMEOUT_PENDING_RESTORE=0
    else
      echo '恢复连接跟踪超时为 600 秒失败' >&2
      return 1
    fi
  fi
}

for required_command in sysctl ip iptables install awk date; do
  command -v "\${required_command}" >/dev/null 2>&1 || {
    echo "缺少必要命令：\${required_command}" >&2
    exit 1
  }
done
install -d -m 0755 "\${STATUS_DIR}"
: > "\${STATUS_LOG}"
CURRENT_STEP_ID='precheck'
CURRENT_STEP_NAME='系统预检查'
trap handle_step_error ERR
trap restore_conntrack_timeout EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
begin_step 'precheck' '系统预检查' '检查必要命令和网络接口'
ip link show dev eth0.108 >/dev/null 2>&1
ip link show dev eth0.107 >/dev/null 2>&1
complete_step '必要命令和网络接口检查完成'

PREVIOUS_PPP0_ADDRESS=''
PREVIOUS_LOCAL_SECURITY_ADDRESS=''
PREVIOUS_REMOTE_SECURITY_ADDRESS=''
if [[ -r "\${CONFIG_FILE}" ]]; then
  PREVIOUS_PPP0_ADDRESS="$(awk -F= '$1 == "PPP0_ADDRESS" { print $2; exit }' "\${CONFIG_FILE}")"
  PREVIOUS_LOCAL_SECURITY_ADDRESS="$(awk -F= '$1 == "LOCAL_SECURITY_ADDRESS" { print $2; exit }' "\${CONFIG_FILE}")"
  PREVIOUS_REMOTE_SECURITY_ADDRESS="$(awk -F= '$1 == "REMOTE_SECURITY_ADDRESS" { print $2; exit }' "\${CONFIG_FILE}")"
fi

# 业务链路同样需要共享的 IPv4 转发；不修改独立维护通路的接口参数。
begin_step 'forwarding' '业务 IPv4 转发' '启用业务链路所需的共享 IPv4 转发'
sysctl -w net.ipv4.ip_forward=1
complete_step '业务 IPv4 转发已启用'

# 107 口：使用本地网关地址访问本地纵密。
begin_step 'local_security' '107 本地纵密链路' '配置本地网关地址和本地纵密路由'
ip addr replace "\${LOCAL_GATEWAY_ADDRESS}/32" dev eth0.107
ip route replace "\${LOCAL_SECURITY_ADDRESS}/32" dev eth0.107 scope link src "\${LOCAL_GATEWAY_ADDRESS}"
complete_step '107 本地纵密链路配置完成'

# 108 口：使用本地 RTU 地址经固定网关访问远程 RTU。
begin_step 'local_rtu' '108 本地 RTU 链路' '配置本地 RTU 地址和远程 RTU 路由'
ip addr replace "\${LOCAL_RTU_ADDRESS}/32" dev eth0.108
ip route replace "\${REMOTE_RTU_ADDRESS}/32" via 192.168.8.220 dev eth0.108 src "\${LOCAL_RTU_ADDRESS}" onlink
complete_step '108 本地 RTU 链路配置完成'

get_ppp0_ipv4() {
  local details
  if ip link show dev ppp0 >/dev/null 2>&1; then
    details="$(ip -4 -o addr show dev ppp0 2>/dev/null)" || return 0
    printf '%s\\n' "\${details}" | awk 'NR == 1 { split($4, fields, "/"); print fields[1]; exit }'
  fi
  return 0
}

get_ppp0_link_key() {
  ip -o link show dev ppp0 2>/dev/null | awk 'NR == 1 { sub(/:$/, "", $1); print $1; exit }' || true
}

# 首次应用等待 PPP；服务模式完成后继续观察重拨。
wait_for_ppp0_ipv4() {
  local interval_seconds=5
  write_step_status 'waiting' '等待 ppp0 IPv4 地址'

  while true; do
    local address
    address="$(get_ppp0_ipv4)"
    if [[ -n "\${address}" ]]; then
      printf '%s\\n' "\${address}"
      return 0
    fi
    sleep "\${interval_seconds}"
  done
}

# 目标设备可能未启用 comment match，按本功能的完整地址组合清理规则。
remove_nat_rule() {
  local check_status
  while true; do
    if iptables -t nat -C "$@" 2>/dev/null; then
      iptables -t nat -D "$@"
    else
      check_status="$?"
      if [[ "\${check_status}" != '1' ]]; then
        echo "检查业务 NAT 规则失败，退出码：\${check_status}" >&2
        return "\${check_status}"
      fi
      return 0
    fi
  done
}

remove_managed_dnat_rule() {
  local public_address="$1"
  local private_address="$2"
  [[ -n "\${public_address}" && -n "\${private_address}" ]] || return 0

  remove_nat_rule PREROUTING -i ppp0 -d "\${public_address}" -j DNAT --to-destination "\${private_address}"
}

remove_managed_snat_rule() {
  local public_address="$1"
  local private_address="$2"
  local remote_address="$3"
  [[ -n "\${public_address}" && -n "\${private_address}" && -n "\${remote_address}" ]] || return 0

  remove_nat_rule POSTROUTING -o ppp0 -s "\${private_address}/32" -d "\${remote_address}/32" -j SNAT --to-source "\${public_address}"
  # 兼容此前现场验证添加的协议 253 限定规则，不影响其他地址或接口。
  remove_nat_rule POSTROUTING -o ppp0 -p 253 -s "\${private_address}/32" -d "\${remote_address}/32" -j SNAT --to-source "\${public_address}"
}

recover_pending_nat() {
  if [[ -r "\${PENDING_NAT_FILE}" ]]; then
    local pending_public pending_private pending_remote
    pending_public="$(awk -F= '$1 == "PPP0_ADDRESS" { print $2; exit }' "\${PENDING_NAT_FILE}")"
    pending_private="$(awk -F= '$1 == "LOCAL_SECURITY_ADDRESS" { print $2; exit }' "\${PENDING_NAT_FILE}")"
    pending_remote="$(awk -F= '$1 == "REMOTE_SECURITY_ADDRESS" { print $2; exit }' "\${PENDING_NAT_FILE}")"
    if [[ -z "\${pending_public}" || -z "\${pending_private}" || -z "\${pending_remote}" ]]; then
      echo '待恢复 NAT 记录缺少必要地址，停止配置' >&2
      return 1
    fi
    echo "清理上次未完成的业务 NAT，PPP 地址：\${pending_public}"
    remove_managed_dnat_rule "\${pending_public}" "\${pending_private}"
    remove_managed_snat_rule "\${pending_public}" "\${pending_private}" "\${pending_remote}"
    rm -f -- "\${PENDING_NAT_FILE}"
  fi
}

record_pending_nat() {
  install -d -m 0755 "\${CONFIG_DIR}"
  cat > "\${PENDING_NAT_FILE}.tmp" <<EOF
PPP0_ADDRESS=\${PPP0_ADDRESS}
LOCAL_SECURITY_ADDRESS=\${LOCAL_SECURITY_ADDRESS}
REMOTE_SECURITY_ADDRESS=\${REMOTE_SECURITY_ADDRESS}
EOF
  chmod 0600 "\${PENDING_NAT_FILE}.tmp"
  mv -f "\${PENDING_NAT_FILE}.tmp" "\${PENDING_NAT_FILE}"
}

apply_ppp_business_network() {
  recover_pending_nat
  record_pending_nat
  begin_step 'remote_security_route' '远程纵密路由' '配置远程纵密经 ppp0 的路由'
  ip route replace "\${REMOTE_SECURITY_ADDRESS}/32" dev ppp0
  complete_step '远程纵密路由配置完成'

  begin_step 'dnat' 'DNAT 规则' '清理旧规则并插入 ppp0 入站 DNAT'
  remove_managed_dnat_rule "\${PREVIOUS_PPP0_ADDRESS}" "\${PREVIOUS_LOCAL_SECURITY_ADDRESS}"
  remove_managed_dnat_rule "\${PPP0_ADDRESS}" "\${LOCAL_SECURITY_ADDRESS}"
  iptables -t nat -I PREROUTING 1 -i ppp0 -d "\${PPP0_ADDRESS}" -j DNAT --to-destination "\${LOCAL_SECURITY_ADDRESS}"
  complete_step 'DNAT 规则配置完成'

  begin_step 'snat' 'SNAT 规则' '配置本地纵密到远程纵密的 ppp0 出站源地址转换'
  remove_managed_snat_rule "\${PREVIOUS_PPP0_ADDRESS}" "\${PREVIOUS_LOCAL_SECURITY_ADDRESS}" "\${PREVIOUS_REMOTE_SECURITY_ADDRESS}"
  remove_managed_snat_rule "\${PPP0_ADDRESS}" "\${LOCAL_SECURITY_ADDRESS}" "\${REMOTE_SECURITY_ADDRESS}"
  iptables -t nat -A POSTROUTING -o ppp0 -s "\${LOCAL_SECURITY_ADDRESS}/32" -d "\${REMOTE_SECURITY_ADDRESS}/32" -j SNAT --to-source "\${PPP0_ADDRESS}"
  complete_step "SNAT 规则配置完成，当前 PPP 地址：\${PPP0_ADDRESS}，不限制协议和端口"
}

refresh_conntrack_timeout() {
  begin_step 'conntrack' '连接跟踪超时' '设置 3 秒并在 30 秒后恢复 600 秒'
  CONNTRACK_TIMEOUT_PENDING_RESTORE=1
  sysctl -w net.netfilter.nf_conntrack_generic_timeout=3
  sleep 30
  restore_conntrack_timeout
  complete_step '连接跟踪超时已恢复为 600 秒'
}

# 保存表单字段和本次 PPP 地址；后续重拨按这些地址精确替换旧业务规则。
save_configuration() {
  begin_step 'save_config' '配置保存' '写入纵密配置文件'
  install -d -m 0755 "\${CONFIG_DIR}"
  cat > "\${CONFIG_FILE}.tmp" <<EOF
TARGET_DEVICE=\${TARGET_DEVICE}
LOCAL_RTU_ADDRESS=\${LOCAL_RTU_ADDRESS}
LOCAL_SECURITY_ADDRESS=\${LOCAL_SECURITY_ADDRESS}
LOCAL_GATEWAY_ADDRESS=\${LOCAL_GATEWAY_ADDRESS}
REMOTE_RTU_ADDRESS=\${REMOTE_RTU_ADDRESS}
REMOTE_SECURITY_ADDRESS=\${REMOTE_SECURITY_ADDRESS}
REMOTE_GATEWAY_ADDRESS=\${REMOTE_GATEWAY_ADDRESS}
PPP0_ADDRESS=\${PPP0_ADDRESS}
EOF
  chmod 0600 "\${CONFIG_FILE}.tmp"
  mv -f "\${CONFIG_FILE}.tmp" "\${CONFIG_FILE}"
  rm -f -- "\${PENDING_NAT_FILE}"
  PREVIOUS_PPP0_ADDRESS="\${PPP0_ADDRESS}"
  PREVIOUS_LOCAL_SECURITY_ADDRESS="\${LOCAL_SECURITY_ADDRESS}"
  PREVIOUS_REMOTE_SECURITY_ADDRESS="\${REMOTE_SECURITY_ADDRESS}"
  complete_step '纵密配置文件保存完成'
}

begin_step 'ppp0_wait' 'PPP 链路' '等待 ppp0 获取 IPv4 地址'
PPP0_ADDRESS="$(wait_for_ppp0_ipv4)"
PPP0_LINK_KEY="$(get_ppp0_link_key)"
complete_step '已获取 ppp0 IPv4 地址'
apply_ppp_business_network
refresh_conntrack_timeout
save_configuration

echo "纵密业务网络配置已完成，目标设备：\${TARGET_DEVICE}"

if [[ "\${WATCH_PPP}" == '1' ]]; then
  echo '已启用 PPP 重拨监控，地址或接口恢复后同步更新业务路由与双向 NAT'
  PPP0_WAS_DOWN=0
  while true; do
    sleep 5
    next_address="$(get_ppp0_ipv4)"
    next_link_key="$(get_ppp0_link_key)"
    if [[ -z "\${next_address}" || -z "\${next_link_key}" ]]; then
      if [[ "\${PPP0_WAS_DOWN}" == '0' ]]; then
        begin_step 'ppp0_wait' 'PPP 链路' 'PPP 链路断开，等待重新取得 IPv4 地址'
        write_step_status 'waiting' 'PPP 链路断开，保留现有业务规则并等待恢复'
        echo 'PPP 链路断开，等待恢复'
      fi
      PPP0_WAS_DOWN=1
      continue
    fi
    if [[ "\${PPP0_WAS_DOWN}" == '1' || "\${next_address}" != "\${PPP0_ADDRESS}" || "\${next_link_key}" != "\${PPP0_LINK_KEY}" ]]; then
      begin_step 'ppp0_wait' 'PPP 链路' 'PPP 链路已恢复或地址发生变化，更新业务规则'
      PPP0_ADDRESS="\${next_address}"
      PPP0_LINK_KEY="\${next_link_key}"
      complete_step "已获取 ppp0 IPv4 地址：\${PPP0_ADDRESS}"
      apply_ppp_business_network
      refresh_conntrack_timeout
      save_configuration
      PPP0_WAS_DOWN=0
      echo "PPP 业务规则已更新，当前地址：\${PPP0_ADDRESS}"
    fi
  done
fi
`;
}

export async function saveVerticalSecurityScript(
  values: VerticalSecurityScriptValues,
): Promise<string | null> {
  const content = buildVerticalSecurityScript(values);
  const isTauriRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  if (!isTauriRuntime) {
    return api.saveVerticalSecurityScript(DEFAULT_SCRIPT_FILE_NAME, content);
  }

  const selectedPath = await save({
    title: '生成纵密配置脚本',
    defaultPath: DEFAULT_SCRIPT_FILE_NAME,
    filters: [{ name: 'Shell 脚本', extensions: ['sh'] }],
  });

  if (!selectedPath) {
    return null;
  }

  return api.saveVerticalSecurityScript(selectedPath, content);
}

export async function deployVerticalSecurityScript(
  values: VerticalSecurityScriptValues,
  connection: {
    uploadAccount: string;
    installDir: string;
    auth: LowerUpdateSshAuth;
    sudoPassword: string;
  },
): Promise<VerticalSecurityDeployResult> {
  const content = buildVerticalSecurityScript(values);
  return api.deployVerticalSecurityScript({
    script_content: content,
    upload_account: connection.uploadAccount,
    install_dir: connection.installDir,
    auth: connection.auth,
    sudo_password: connection.sudoPassword,
  });
}

export async function getVerticalSecurityStatus(
  connection: VerticalSecurityStatusRequest,
): Promise<VerticalSecurityStatusResult> {
  return api.getVerticalSecurityStatus(connection);
}
