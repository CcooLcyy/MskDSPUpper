#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

HOST="${MSKDSP_UPPER_DEV_HOST:-0.0.0.0}"
PORT="${MSKDSP_UPPER_DEV_PORT:-5173}"
SKIP_NPM_CI="${MSKDSP_UPPER_DEV_SKIP_NPM_CI:-0}"

log() {
  echo "[dev-browser] $*"
}

die() {
  echo "[dev-browser] Error: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

print_node_install_hint() {
  cat >&2 <<'EOF'
[dev-browser] 当前环境缺少 Node.js/npm。
[dev-browser] 本项目 CI 使用 Node 22；在 Ubuntu/Debian 容器中可执行：

  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs

EOF
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  print_node_install_hint
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "${NODE_MAJOR}" != "22" ]]; then
  log "当前 Node 版本为 $(node -v)，CI 使用 Node 22；如遇依赖问题请切换到 Node 22。"
fi

require_cmd npm

cd "${REPO_ROOT}"

need_npm_ci=0
if [[ ! -d node_modules ]]; then
  need_npm_ci=1
elif [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
  need_npm_ci=1
elif [[ package.json -nt node_modules/.package-lock.json ]]; then
  need_npm_ci=1
fi

if [[ "${SKIP_NPM_CI}" != "1" && "${need_npm_ci}" == "1" ]]; then
  log "安装/更新前端依赖: npm ci"
  npm ci
elif [[ "${SKIP_NPM_CI}" == "1" ]]; then
  log "已跳过 npm ci"
fi

log "启动浏览器开发模式，使用 mock adapter，不触发 Tauri/Rust 编译。"
log "监听地址: http://${HOST}:${PORT}/"

exec npm run dev -- --host "${HOST}" --port "${PORT}"
