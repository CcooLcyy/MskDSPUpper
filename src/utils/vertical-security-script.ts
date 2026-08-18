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

export function buildVerticalSecurityScript(values: VerticalSecurityScriptValues): string {
  const device = requireScriptValue('目标设备', values.device);
  const localRtuAddress = requireScriptValue('本地 RTU 地址', values.localRtuAddress);
  const localSecurityAddress = requireScriptValue('本地纵密地址', values.localSecurityAddress);
  const localGatewayAddress = requireScriptValue('本地网关地址', values.localGatewayAddress);
  const remoteRtuAddress = requireScriptValue('远程 RTU 地址', values.remoteRtuAddress);
  const remoteSecurityAddress = requireScriptValue('远程纵密地址', values.remoteSecurityAddress);
  const remoteGatewayAddress = requireScriptValue('远程网关地址', values.remoteGatewayAddress);

  return `#!/usr/bin/env bash
set -Eeuo pipefail

# MskDSP 纵密网络配置脚本
# 前置条件：电脑必须使用 11.22.33.41 作为自身 IP 地址。
# 固定网络段：11.22.33.41 为电脑地址，11.22.33.44 为纵密装置地址。

readonly TARGET_DEVICE=${shellQuote(device)}
readonly LOCAL_RTU_ADDRESS=${shellQuote(localRtuAddress)}
readonly LOCAL_SECURITY_ADDRESS=${shellQuote(localSecurityAddress)}
readonly LOCAL_GATEWAY_ADDRESS=${shellQuote(localGatewayAddress)}
readonly REMOTE_RTU_ADDRESS=${shellQuote(remoteRtuAddress)}
readonly REMOTE_SECURITY_ADDRESS=${shellQuote(remoteSecurityAddress)}
readonly REMOTE_GATEWAY_ADDRESS=${shellQuote(remoteGatewayAddress)}
readonly DNAT_COMMENT='mskdsp-vertical-security'
readonly CONFIG_DIR='/etc/mskdsp'
readonly CONFIG_FILE="\${CONFIG_DIR}/vertical-security.conf"
readonly STATUS_DIR='/run/mskdsp-vertical-security'
readonly STATUS_LOG="\${STATUS_DIR}/steps.log"
readonly STATUS_CURRENT="\${STATUS_DIR}/current"

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
begin_step 'precheck' '系统预检查' '检查必要命令和网络接口'
ip link show dev eth0.101 >/dev/null 2>&1
ip link show dev eth0.108 >/dev/null 2>&1
ip link show dev eth0.107 >/dev/null 2>&1
complete_step '必要命令和网络接口检查完成'

PREVIOUS_PPP0_ADDRESS=''
PREVIOUS_LOCAL_SECURITY_ADDRESS=''
if [[ -r "\${CONFIG_FILE}" ]]; then
  PREVIOUS_PPP0_ADDRESS="$(awk -F= '$1 == "PPP0_ADDRESS" { print $2; exit }' "\${CONFIG_FILE}")"
  PREVIOUS_LOCAL_SECURITY_ADDRESS="$(awk -F= '$1 == "LOCAL_SECURITY_ADDRESS" { print $2; exit }' "\${CONFIG_FILE}")"
fi

# 固定的 101 口纵密直连配置。
begin_step 'fixed_network' '101 固定网络' '配置转发、代理 ARP、固定地址和 SNAT'
sysctl -w net.ipv4.ip_forward=1
sysctl -w 'net.ipv4.conf.eth0/101.proxy_arp=1'
sysctl -w 'net.ipv4.conf.eth0/108.proxy_arp=0'

ip addr replace 11.22.33.1/32 dev eth0.101
ip route replace 11.22.33.41/32 dev eth0.101 scope link

ip addr replace 11.22.33.2/32 dev eth0.108
ip route replace 11.22.33.44/32 dev eth0.108 scope link

# 检查后再追加，避免脚本重复执行产生重复 NAT 规则。
if ! iptables -t nat -C POSTROUTING -o eth0.108 -s 11.22.33.41/32 -d 11.22.33.44/32 -j SNAT --to-source 11.22.33.2 2>/dev/null; then
  iptables -t nat -A POSTROUTING -o eth0.108 -s 11.22.33.41/32 -d 11.22.33.44/32 -j SNAT --to-source 11.22.33.2
fi
complete_step '101 固定网络和 SNAT 配置完成'

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

# 等待 PPP 链路建立并获取 IPv4 地址；PPP 恢复前一直等待。
begin_step 'ppp0_wait' 'PPP 链路' '等待 ppp0 获取 IPv4 地址'
wait_for_ppp0_ipv4() {
  local interval_seconds=5
  write_step_status 'waiting' '等待 ppp0 IPv4 地址'

  while true; do
    if ip link show dev ppp0 >/dev/null 2>&1; then
      local address
      address="$(ip -4 -o addr show dev ppp0 | awk 'NR == 1 { split($4, fields, "/"); print fields[1]; exit }')"
      if [[ -n "\${address}" ]]; then
        printf '%s\\n' "\${address}"
        return 0
      fi
    fi
    sleep "\${interval_seconds}"
  done
}

PPP0_ADDRESS="$(wait_for_ppp0_ipv4)"
complete_step '已获取 ppp0 IPv4 地址'

# 远程纵密通过 PPP 链路访问。
begin_step 'remote_security_route' '远程纵密路由' '配置远程纵密经 ppp0 的路由'
ip route replace "\${REMOTE_SECURITY_ADDRESS}/32" dev ppp0
complete_step '远程纵密路由配置完成'

# 仅删除本脚本标记过的旧规则，再插入到 PREROUTING 第 1 条。
begin_step 'dnat' 'DNAT 规则' '清理旧规则并插入 ppp0 入站 DNAT'
remove_managed_dnat_rule() {
  local public_address="$1"
  local private_address="$2"
  [[ -n "\${public_address}" && -n "\${private_address}" ]] || return 0

  while iptables -t nat -C PREROUTING -i ppp0 -d "\${public_address}" -m comment --comment "\${DNAT_COMMENT}" -j DNAT --to-destination "\${private_address}" 2>/dev/null; do
    iptables -t nat -D PREROUTING -i ppp0 -d "\${public_address}" -m comment --comment "\${DNAT_COMMENT}" -j DNAT --to-destination "\${private_address}"
  done
}
remove_managed_dnat_rule "\${PREVIOUS_PPP0_ADDRESS}" "\${PREVIOUS_LOCAL_SECURITY_ADDRESS}"
remove_managed_dnat_rule "\${PPP0_ADDRESS}" "\${LOCAL_SECURITY_ADDRESS}"
iptables -t nat -I PREROUTING 1 -i ppp0 -d "\${PPP0_ADDRESS}" -m comment --comment "\${DNAT_COMMENT}" -j DNAT --to-destination "\${LOCAL_SECURITY_ADDRESS}"
complete_step 'DNAT 规则配置完成'

# 临时缩短连接跟踪超时，等待连接状态刷新后恢复默认值。
begin_step 'conntrack' '连接跟踪超时' '设置 3 秒并在 30 秒后恢复 600 秒'
sysctl -w net.netfilter.nf_conntrack_generic_timeout=3
sleep 30
sysctl -w net.netfilter.nf_conntrack_generic_timeout=600
complete_step '连接跟踪超时已恢复为 600 秒'

# 保存表单字段和本次 PPP 地址，供后续纵密服务读取。
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
complete_step '纵密配置文件保存完成'

echo "纵密网络固定配置已完成，目标设备：\${TARGET_DEVICE}"
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
