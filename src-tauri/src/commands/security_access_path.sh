#!/bin/bash
# MskDSP managed vertical-security-access runtime v1
# 仅配置固定维护通路，不涉及业务配置或持久化。
set -euo pipefail
umask 077
phase=preflight
changed=0
addr101=0 addr108=0 route101=0 route108=0 fwout=0 fwin=0 snat=0 forward=0 proxy=0
old_forward=0 old_proxy=0
shared_forward_retained=0
root_group_check=unchecked
out_rule=(-i eth0.101 -o eth0.108 -s 11.22.33.0/24 -d 11.22.33.44/32 -j ACCEPT)
in_rule=(-i eth0.108 -o eth0.101 -s 11.22.33.44/32 -d 11.22.33.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT)
nat_rule=(-o eth0.108 -s 11.22.33.0/24 -d 11.22.33.44/32 -j SNAT --to-source 11.22.33.2)
emit() { printf 'MSKDSP_PATH|%s|%s\n' "$1" "$2"; }
rollback() {
    local failed=0
    # 仅逆序回退本次执行成功的写入，不清空或替换既有配置。
    if (( snat )); then iptables -w 5 -t nat -D POSTROUTING "${nat_rule[@]}" >/dev/null 2>&1 || failed=1; fi
    if (( fwin )); then iptables -w 5 -t filter -D FORWARD "${in_rule[@]}" >/dev/null 2>&1 || failed=1; fi
    if (( fwout )); then iptables -w 5 -t filter -D FORWARD "${out_rule[@]}" >/dev/null 2>&1 || failed=1; fi
    # IPv4 转发是业务与维护共享依赖，即使本次开启也不自动关闭。
    if (( forward )); then shared_forward_retained=1; fi
    if (( proxy || forward )); then sysctl -w "net.ipv4.conf.eth0/101.proxy_arp=$old_proxy" >/dev/null 2>&1 || failed=1; fi
    if (( route108 )); then ip route del 11.22.33.44/32 dev eth0.108 src 11.22.33.2 scope link >/dev/null 2>&1 || failed=1; fi
    if (( route101 )); then ip route del 11.22.33.0/24 dev eth0.101 src 11.22.33.1 scope link >/dev/null 2>&1 || failed=1; fi
    if (( addr108 )); then ip address del 11.22.33.2/32 dev eth0.108 >/dev/null 2>&1 || failed=1; fi
    if (( addr101 )); then ip address del 11.22.33.1/32 dev eth0.101 >/dev/null 2>&1 || failed=1; fi
    return "$failed"
}
finish() {
    local rc=$?
    trap - EXIT INT TERM HUP
    if (( rc != 0 )); then
        emit "$phase" failed
        if (( changed )); then
            if rollback; then
                if (( shared_forward_retained )); then emit rollback partial; else emit rollback success; fi
            else emit rollback failed; fi
        else emit rollback unchanged; fi
        emit result failed
    fi
    exit "$rc"
}
secure_directory() {
    local path="$1" uid mode
    [[ -d "$path" && ! -L "$path" ]] || return 1
    uid=$(stat -c %u -- "$path") || return 1
    mode=$(stat -c %a -- "$path") || return 1
    [[ "$uid" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
    (( (8#$mode & 022) == 0 ))
}
strict_directory() {
    if ! secure_directory "$1"; then emit detail "$2"; return 1; fi
}
local_nss_sources_only() {
    local path=/etc/nsswitch.conf uid mode
    # 远程 NSS 可能不支持完整枚举；本轮例外只支持固定的本机身份来源。
    [[ -f "$path" && ! -L "$path" && -r "$path" ]] || return 1
    uid=$(stat -c %u -- "$path") || return 1
    mode=$(stat -c %a -- "$path") || return 1
    [[ "$uid" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
    (( (8#$mode & 022) == 0 )) || return 1
    LC_ALL=C awk '
        {
            sub(/#.*/, "");
            colon=index($0, ":");
            if (!colon) next;
            database=substr($0, 1, colon-1);
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", database);
            if (database!="passwd" && database!="group" && database!="initgroups") next;
            source=substr($0, colon+1);
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", source);
            gsub(/[[:space:]]+/, " ", source);
            if (source!="files" && source!="files systemd") bad=1;
            seen[database]++;
        }
        END { exit (bad || seen["passwd"]!=1 || seen["group"]!=1 || seen["initgroups"]>1) ? 1 : 0 }
    ' "$path" 2>/dev/null || return 1
}
trusted_root_group() {
    local group_data passwd_data name password gid members extra member record member_name member_uid
    local uid gecos home shell membership token found_group=0 found_root_user=0
    local -a member_names group_ids
    if [[ "$root_group_check" == trusted ]]; then return 0; fi
    if [[ "$root_group_check" == untrusted ]]; then return 1; fi
    root_group_check=untrusted
    local_nss_sources_only || return 1
    command -v getent >/dev/null || return 1
    group_data=$(getent group 2>/dev/null) || return 1
    passwd_data=$(getent passwd 2>/dev/null) || return 1
    [[ -n "$group_data" && -n "$passwd_data" ]] || return 1
    # 扫描全部 gid=0 的组（包括别名），不能只相信名为 root 的一个条目。
    while IFS=: read -r name password gid members extra; do
        [[ -n "$name" && "$gid" =~ ^[0-9]+$ && -z "$extra" ]] || return 1
        if [[ "$gid" =~ ^0+$ ]]; then
            found_group=1
            member_names=()
            IFS=, read -r -a member_names <<<"$members"
            for member in "${member_names[@]}"; do
                [[ -n "$member" ]] || return 1
                record=$(getent passwd "$member" 2>/dev/null) || return 1
                [[ "$record" != *$'\n'* ]] || return 1
                IFS=: read -r member_name password member_uid gid gecos home shell extra <<<"$record"
                [[ "$member_name" == "$member" && "$member_uid" =~ ^0+$ && -z "$extra" ]] || return 1
            done
        fi
    done <<<"$group_data"
    # 主组成员不一定出现在 group 的成员列表；NSS initgroups 还可能提供动态附组。
    while IFS=: read -r name password uid gid gecos home shell extra; do
        [[ -n "$name" && "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ && -z "$extra" ]] || return 1
        if [[ "$uid" =~ ^0+$ ]]; then found_root_user=1; continue; fi
        [[ ! "$gid" =~ ^0+$ ]] || return 1
        membership=$(getent initgroups "$name" 2>/dev/null) || return 1
        [[ "$membership" != *$'\n'* ]] || return 1
        read -r -a group_ids <<<"$membership"
        # 部分 getent 只返回附加组；无附加组时 rc=0 且只返回用户名是正常结果。
        # 主组 gid 已由上面的 passwd 检查覆盖，不能在这里再要求重复出现。
        [[ "${#group_ids[@]}" -ge 1 && "${group_ids[0]}" == "$name" ]] || return 1
        for token in "${group_ids[@]:1}"; do
            [[ "$token" =~ ^[0-9]+$ && ! "$token" =~ ^0+$ ]] || return 1
        done
    done <<<"$passwd_data"
    [[ "$found_group" == 1 && "$found_root_user" == 1 ]] || return 1
    root_group_check=trusted
}
system_ancestor_directory() {
    local path="$1" code uid gid mode listing permissions
    # 仅这些固定系统目录可以使用受限的 root 组写权限例外。
    case "$path" in
        /usr) code=directory_usr ;;
        /usr/local) code=directory_usr_local ;;
        /usr/local/lib) code=directory_usr_local_lib ;;
        /etc) code=directory_etc ;;
        /etc/systemd) code=directory_etc_systemd ;;
        /etc/systemd/system) code=directory_unit ;;
        /etc/systemd/system/multi-user.target.wants) code=directory_wants ;;
        *) return 1 ;;
    esac
    if [[ ! -d "$path" || -L "$path" ]]; then emit detail "$code"; return 1; fi
    if ! uid=$(stat -c %u -- "$path") || ! gid=$(stat -c %g -- "$path") || ! mode=$(stat -c %a -- "$path"); then
        emit detail "$code"; return 1
    fi
    if [[ "$uid" != 0 || ! "$mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$mode & 002) != 0 )); then
        emit detail "$code"; return 1
    fi
    if ! listing=$(LC_ALL=C ls -ld -- "$path" 2>/dev/null); then emit detail "$code"; return 1; fi
    permissions="${listing%%[[:space:]]*}"
    # '+' 是扩展 ACL；'.' 只表示安全上下文，不扩大文件访问权限。
    if [[ ! "$permissions" =~ ^d[rwxstST-]{9}\.?$ ]]; then emit detail "$code"; return 1; fi
    if (( (8#$mode & 020) != 0 )); then
        if [[ "$gid" != 0 ]]; then emit detail "$code"; return 1; fi
        if ! trusted_root_group; then emit detail root_group_untrusted; return 1; fi
    fi
}
acquire_path_lock() {
    local path=/run/mskdsp-vertical-security-access.lock uid mode links
    strict_directory /run directory_run
    if [[ -e "$path" || -L "$path" ]]; then
        if [[ ! -f "$path" || -L "$path" ]]; then emit detail directory_run; return 1; fi
        if ! uid=$(stat -c %u -- "$path") || ! mode=$(stat -c %a -- "$path") || ! links=$(stat -c %h -- "$path"); then
            emit detail directory_run; return 1
        fi
        if [[ "$uid" != 0 || "$links" != 1 || ! "$mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$mode & 022) != 0 )); then
            emit detail directory_run; return 1
        fi
    fi
    # 同一把锁覆盖手动配置、持久化事务及开机恢复。
    exec 9>"$path"
    flock -n 9
}
runtime_preflight() {
for tool in ip iptables sysctl flock awk grep id stat; do command -v "$tool" >/dev/null; done
[[ "$(id -u)" == 0 ]]
for interface in eth0.101 eth0.108; do
    ip -o link show dev "$interface" | grep -Eq '<([^>]*,)?UP(,|>)'
done
addresses=$(ip -o -4 address show)
# 拒绝固定地址被其他接口占用、掩码不符，或目标地址属于本机。
printf '%s\n' "$addresses" | awk '
    $3 == "inet" {
      sub(/@.*/, "", $2);
      split($4, a, "/");
      if (a[1] == "11.22.33.44") bad=1;
      if (a[1] == "11.22.33.1" && ($2 != "eth0.101" || $4 != "11.22.33.1/32")) bad=1;
      if (a[1] == "11.22.33.2" && ($2 != "eth0.108" || $4 != "11.22.33.2/32")) bad=1;
    } END { exit bad ? 1 : 0 }'
has101=0 has108=0
if printf '%s\n' "$addresses" | awk '{sub(/@.*/, "", $2)} $2=="eth0.101" && $4=="11.22.33.1/32" {found=1} END {exit !found}'; then has101=1; fi
if printf '%s\n' "$addresses" | awk '{sub(/@.*/, "", $2)} $2=="eth0.108" && $4=="11.22.33.2/32" {found=1} END {exit !found}'; then has108=1; fi
routes=$(ip -4 route show table all)
printf '%s\n' "$routes" | awk '
    ($1=="blackhole" || $1=="unreachable" || $1=="prohibit" || $1=="throw") &&
    ($2=="11.22.33.0/24" || $2=="11.22.33.44" || $2=="11.22.33.44/32") {bad=1}
    $1=="11.22.33.0/24" || $1=="11.22.33.44" || $1=="11.22.33.44/32" {
      iface=($1=="11.22.33.0/24") ? "eth0.101" : "eth0.108";
      source=($1=="11.22.33.0/24") ? "11.22.33.1" : "11.22.33.2";
      dev="";
      for (i=2; i<=NF; i++) {
        if ($i=="dev") dev=$(i+1);
        if ($i=="via" || $i=="nexthop") bad=1;
        if ($i=="table" && $(i+1)!="main") bad=1;
        if ($i=="src" && $(i+1)!=source) bad=1;
      }
      if (dev!=iface) bad=1;
    } END {exit bad ? 1 : 0}'
hasroute101=0 hasroute108=0
if printf '%s\n' "$routes" | grep -Eq '^11\.22\.33\.0/24 '; then hasroute101=1; fi
if printf '%s\n' "$routes" | grep -Eq '^11\.22\.33\.44(/32)? '; then hasroute108=1; fi
old_forward=$(sysctl -n net.ipv4.ip_forward)
old_proxy=$(sysctl -n net.ipv4.conf.eth0/101.proxy_arp)
[[ "$old_forward" =~ ^[01]$ && "$old_proxy" =~ ^[01]$ ]]
needout=0 needin=0 neednat=0
# 退出码 1 代表规则不存在；权限、模块缺失等其他错误在修改前退出。
if iptables -w 5 -t filter -C FORWARD "${out_rule[@]}" >/dev/null 2>&1; then :; else rc=$?; [[ $rc == 1 ]]; needout=1; fi
if iptables -w 5 -t filter -C FORWARD "${in_rule[@]}" >/dev/null 2>&1; then :; else rc=$?; [[ $rc == 1 ]]; needin=1; fi
if iptables -w 5 -t nat -C POSTROUTING "${nat_rule[@]}" >/dev/null 2>&1; then :; else rc=$?; [[ $rc == 1 ]]; neednat=1; fi
emit preflight success
}
apply_runtime() {
phase=addresses
if (( !has101 )); then ip address add 11.22.33.1/32 dev eth0.101 >/dev/null 2>&1; addr101=1; changed=1; fi
if (( !has108 )); then ip address add 11.22.33.2/32 dev eth0.108 >/dev/null 2>&1; addr108=1; changed=1; fi
emit addresses success
phase=routes
if (( !hasroute101 )); then ip route add 11.22.33.0/24 dev eth0.101 src 11.22.33.1 scope link >/dev/null 2>&1; route101=1; changed=1; fi
if (( !hasroute108 )); then ip route add 11.22.33.44/32 dev eth0.108 src 11.22.33.2 scope link >/dev/null 2>&1; route108=1; changed=1; fi
emit routes success
phase=forwarding
if [[ "$old_forward" != 1 ]]; then sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1; forward=1; changed=1; fi
if [[ "$old_proxy" != 1 || "$forward" == 1 ]]; then sysctl -w net.ipv4.conf.eth0/101.proxy_arp=1 >/dev/null 2>&1; proxy=1; changed=1; fi
if (( needout )); then iptables -w 5 -t filter -I FORWARD 1 "${out_rule[@]}" >/dev/null 2>&1; fwout=1; changed=1; fi
if (( needin )); then iptables -w 5 -t filter -I FORWARD 1 "${in_rule[@]}" >/dev/null 2>&1; fwin=1; changed=1; fi
if (( neednat )); then iptables -w 5 -t nat -I POSTROUTING 1 "${nat_rule[@]}" >/dev/null 2>&1; snat=1; changed=1; fi
emit forwarding success
phase=verification
# 策略路由可能覆盖主路由表，因此分别检查 DSP 本机及 101 口转发的出口。
# 此处仅读取路由，不向目标发送探测报文。
for route in "$(ip -4 route get 11.22.33.44)" "$(ip -4 route get 11.22.33.44 from 11.22.33.3 iif eth0.101)"; do
    printf '%s\n' "$route" | awk '{for (i=1;i<=NF;i++) {if ($i=="dev" && $(i+1)=="eth0.108") ok=1; if ($i=="via") bad=1}} END {exit (!ok || bad)}'
done
emit verification success
}

# 安装事务 source 同一份函数，保持新增项账本到持久化结束；启动服务直接执行。
if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
    trap finish EXIT
    trap 'exit 130' INT TERM HUP
    for tool in stat id flock; do command -v "$tool" >/dev/null; done
    [[ "$(id -u)" == 0 ]]
    acquire_path_lock
    runtime_preflight
    apply_runtime
    emit result success
fi
