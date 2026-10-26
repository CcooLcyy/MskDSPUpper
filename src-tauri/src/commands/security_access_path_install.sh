#!/bin/bash
# MskDSP managed vertical-security-access installer v1
# 固定内容由 Rust 注入，不接受用户脚本、路径、服务名或网络参数。
set -euo pipefail
umask 077
runtime_payload=$(cat <<'MSKDSP_FIXED_RUNTIME_END'
__MSKDSP_RUNTIME_PAYLOAD__
MSKDSP_FIXED_RUNTIME_END
)
# source 同一份运行态脚本，使网络新增项账本延续到持久化完成。
source /dev/stdin <<<"$runtime_payload"
root=/usr/local/lib/mskdsp-vertical-security-access
runtime_path="$root/apply.sh"
ownership_path="$root/ownership"
unit_path=/etc/systemd/system/mskdsp-vertical-security-access.service
service=mskdsp-vertical-security-access.service
wants_dir=/etc/systemd/system/multi-user.target.wants
wants_path="$wants_dir/$service"
managed_marker='# MskDSP managed vertical-security-access ownership v1'
old_enabled=not-found old_active=inactive
existed=0 root_created=0 runtime_written=0 unit_written=0 ownership_written=0 enable_attempted=0 reload_attempted=0
committed=0
runtime_backup='' unit_backup='' ownership_backup=''
runtime_temp='' unit_temp='' ownership_temp=''
unit_payload=$(cat <<'MSKDSP_FIXED_UNIT_END'
# MskDSP managed vertical-security-access service v1
[Unit]
Description=MskDSP 纵密维护访问通路
Wants=network-online.target
After=network-online.target
# 每次失败等待 15 秒，持续等待 VLAN 就绪，不因次数上限永久停止恢复。
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=/bin/bash --noprofile --norc /usr/local/lib/mskdsp-vertical-security-access/apply.sh
RemainAfterExit=yes
Restart=on-failure
RestartSec=15
TimeoutStartSec=60

[Install]
WantedBy=multi-user.target
MSKDSP_FIXED_UNIT_END
)

secure_file() {
    local path="$1" uid mode links
    [[ -f "$path" && ! -L "$path" ]]
    uid=$(stat -c %u -- "$path"); mode=$(stat -c %a -- "$path"); links=$(stat -c %h -- "$path")
    [[ "$uid" == 0 && "$links" == 1 && "$mode" =~ ^[0-7]{3,4}$ ]]
    (( (8#$mode & 022) == 0 ))
}
digest() { local result; result=$(sha256sum -- "$1"); printf '%s' "${result%% *}"; }
cleanup_temps() {
    local path
    for path in "$runtime_temp" "$unit_temp" "$ownership_temp" "$runtime_backup" "$unit_backup" "$ownership_backup"; do
        if [[ -n "$path" ]]; then rm -f -- "$path" || return 1; fi
    done
}
cleanup_pending() {
    local path
    # 恢复失败时保留旧配置备份，以便人工恢复，不因清理再次丢失旧内容。
    for path in "$runtime_temp" "$unit_temp" "$ownership_temp"; do
        if [[ -n "$path" ]]; then rm -f -- "$path" || return 1; fi
    done
}
restore_persistence() {
    local failed=0 active
    # 只有本次原本未启用的服务才撤销 enable；不 stop/restart 原有服务。
    if (( enable_attempted )) && [[ "$old_enabled" != enabled ]]; then
        systemctl disable "$service" >/dev/null 2>&1 || failed=1
    fi
    if (( existed )); then
        if (( runtime_written )); then mv -f -- "$runtime_backup" "$runtime_path" >/dev/null 2>&1 || failed=1; fi
        if (( unit_written )); then mv -f -- "$unit_backup" "$unit_path" >/dev/null 2>&1 || failed=1; fi
        if (( ownership_written )); then mv -f -- "$ownership_backup" "$ownership_path" >/dev/null 2>&1 || failed=1; fi
    else
        if (( ownership_written )); then rm -f -- "$ownership_path" || failed=1; fi
        if (( unit_written )); then rm -f -- "$unit_path" || failed=1; fi
        if (( runtime_written )); then rm -f -- "$runtime_path" || failed=1; fi
    fi
    if (( reload_attempted )); then systemctl daemon-reload >/dev/null 2>&1 || failed=1; fi
    active=$(systemctl show "$service" --property=ActiveState --value 2>/dev/null) || :
    [[ "$active" == "$old_active" ]] || failed=1
    if (( failed )); then cleanup_pending || failed=1
    else cleanup_temps || failed=1; fi
    if (( root_created )); then rmdir -- "$root" >/dev/null 2>&1 || failed=1; fi
    return "$failed"
}
finish_install() {
    local rc=$? failed=0
    trap - EXIT INT TERM HUP
    if (( rc != 0 )); then
        emit "$phase" failed
        if (( committed )); then
            # 文件和服务已核验；清理部分备份后无法保证还能完整恢复旧事务。
            # 保留已更新配置并报告未完成，不能在清理失败前输出最终成功。
            emit rollback retained
            emit result failed
            exit "$rc"
        fi
        if (( runtime_written || unit_written || ownership_written || root_created || reload_attempted || enable_attempted )); then
            restore_persistence || failed=1
        else cleanup_temps || failed=1; fi
        if (( changed )); then rollback || failed=1; fi
        if (( failed )); then emit rollback failed
        elif (( shared_forward_retained )); then emit rollback partial
        elif (( changed || runtime_written || unit_written || root_created )); then emit rollback success
        else emit rollback unchanged; fi
        emit result failed
    fi
    exit "$rc"
}
trap finish_install EXIT
trap 'exit 130' INT TERM HUP

for tool in bash cat stat ls id flock ip iptables sysctl awk grep sha256sum systemctl mktemp cp chmod chown mv rm rmdir readlink head tail mkdir; do
    command -v "$tool" >/dev/null
done
[[ "$(id -u)" == 0 ]]
acquire_path_lock
for directory in /usr /usr/local /usr/local/lib /etc /etc/systemd /etc/systemd/system; do system_ancestor_directory "$directory"; done
if [[ -e "$root" || -L "$root" ]]; then strict_directory "$root" directory_managed; fi
if [[ -e "$wants_dir" || -L "$wants_dir" ]]; then system_ancestor_directory "$wants_dir"; fi
[[ ! -e "$unit_path.d" && ! -L "$unit_path.d" ]]
[[ -n "$(systemctl show --property=Version --value)" ]]
load_state=$(systemctl show "$service" --property=LoadState --value) || :
fragment=$(systemctl show "$service" --property=FragmentPath --value) || :
dropins=$(systemctl show "$service" --property=DropInPaths --value) || :
old_active=$(systemctl show "$service" --property=ActiveState --value) || :
old_enabled=$(systemctl is-enabled "$service" 2>/dev/null) || :
# 不同 systemd 版本对不存在单元的 show/is-enabled 退出码和空值略有差异。
# 先确认管理器可用，再只在本功能尚无单元时规范化这些未安装状态。
if [[ "$load_state" == not-found && ! -e "$unit_path" && ! -L "$unit_path" ]]; then
    if [[ -z "$old_enabled" ]]; then old_enabled=not-found; fi
    if [[ -z "$old_active" ]]; then old_active=inactive; fi
fi
[[ -z "$dropins" ]]
[[ "$old_active" == inactive || "$old_active" == active || "$old_active" == failed ]]
[[ "$old_enabled" == enabled || "$old_enabled" == disabled || "$old_enabled" == not-found ]]
if [[ "$load_state" == loaded ]]; then [[ "$fragment" == "$unit_path" ]]
else [[ "$load_state" == not-found && -z "$fragment" ]]; fi

if [[ -e "$root" || -e "$unit_path" || -L "$unit_path" ]]; then
    strict_directory "$root" directory_managed
    secure_file "$runtime_path"; secure_file "$unit_path"; secure_file "$ownership_path"
    # marker 不能单独证明归属；固定格式 ownership 中的两项散列也必须匹配。
    mapfile -t ownership <"$ownership_path"
    [[ "${#ownership[@]}" == 3 && "${ownership[0]}" == "$managed_marker" ]]
    [[ "${ownership[1]}" =~ ^runtime_sha=([a-f0-9]{64})$ ]]
    [[ "${BASH_REMATCH[1]}" == "$(digest "$runtime_path")" ]]
    [[ "${ownership[2]}" =~ ^unit_sha=([a-f0-9]{64})$ ]]
    [[ "${BASH_REMATCH[1]}" == "$(digest "$unit_path")" ]]
    [[ "$(head -n 2 -- "$runtime_path" | tail -n 1)" == '# MskDSP managed vertical-security-access runtime v1' ]]
    [[ "$(head -n 1 -- "$unit_path")" == '# MskDSP managed vertical-security-access service v1' ]]
    existed=1
else
    [[ "$load_state" == not-found && "$old_enabled" == not-found && "$old_active" == inactive ]]
fi
if [[ -e "$wants_path" || -L "$wants_path" ]]; then
    [[ -L "$wants_path" && "$(stat -c %u -- "$wants_path")" == 0 && "$old_enabled" == enabled && "$existed" == 1 ]]
    target=$(readlink -- "$wants_path")
    [[ "$target" == '../mskdsp-vertical-security-access.service' || "$target" == "$unit_path" ]]
else [[ "$old_enabled" != enabled ]]; fi

# 文件、服务与网络冲突全部检查后才允许开始变更。
runtime_preflight
phase=persistence
if (( existed )); then
    runtime_backup=$(mktemp "$root/.runtime-backup.XXXXXX")
    unit_backup=$(mktemp /etc/systemd/system/.mskdsp-vertical-security-access-backup.XXXXXX)
    ownership_backup=$(mktemp "$root/.ownership-backup.XXXXXX")
    cp -p -- "$runtime_path" "$runtime_backup"
    cp -p -- "$unit_path" "$unit_backup"
    cp -p -- "$ownership_path" "$ownership_backup"
else mkdir -m 700 -- "$root"; root_created=1; fi
apply_runtime
phase=persistence
runtime_temp=$(mktemp "$root/.apply.XXXXXX")
printf '%s\n' "$runtime_payload" >"$runtime_temp"
chown 0:0 -- "$runtime_temp"; chmod 700 -- "$runtime_temp"
unit_temp=$(mktemp /etc/systemd/system/.mskdsp-vertical-security-access.XXXXXX)
printf '%s\n' "$unit_payload" >"$unit_temp"
chown 0:0 -- "$unit_temp"; chmod 644 -- "$unit_temp"
ownership_temp=$(mktemp "$root/.ownership.XXXXXX")
printf '%s\nruntime_sha=%s\nunit_sha=%s\n' "$managed_marker" "$(digest "$runtime_temp")" "$(digest "$unit_temp")" >"$ownership_temp"
chown 0:0 -- "$ownership_temp"; chmod 600 -- "$ownership_temp"
runtime_written=1; mv -f -- "$runtime_temp" "$runtime_path"
unit_written=1; mv -f -- "$unit_temp" "$unit_path"
ownership_written=1; mv -f -- "$ownership_temp" "$ownership_path"
reload_attempted=1
systemctl daemon-reload >/dev/null 2>&1
[[ "$(systemctl show "$service" --property=LoadState --value)" == loaded ]]
[[ "$(systemctl show "$service" --property=FragmentPath --value)" == "$unit_path" ]]
[[ -z "$(systemctl show "$service" --property=DropInPaths --value)" ]]
enable_attempted=1
systemctl enable "$service" >/dev/null 2>&1
[[ "$(systemctl is-enabled "$service")" == enabled ]]
[[ -L "$wants_path" ]]
target=$(readlink -- "$wants_path")
[[ "$target" == '../mskdsp-vertical-security-access.service' || "$target" == "$unit_path" ]]
[[ "$(systemctl show "$service" --property=ActiveState --value)" == "$old_active" ]]
committed=1
cleanup_temps
emit persistence success
emit result success
