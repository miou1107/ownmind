#!/bin/bash
# run-scanner.sh — OwnMind token usage scanner wrapper
#
# 目的：launchd / systemd / Task Scheduler 呼叫此 script，script 動態找 node，
#       驗證版本，再 exec 真正的 scanner js。避免 plist/service 寫死路徑。
#
# Install 時由 install.sh 複製到 ~/.ownmind/bin/run-scanner.sh。
# Plan P6 / D12。
#
# 候選 node 路徑（依序嘗試）：
#   1. ~/.ownmind/.node-path（install 時偵測寫入）
#   2. `command -v node`（當前 PATH）
#   3. 常見 glob：/opt/homebrew/bin/node, /usr/local/bin/node,
#                 ~/.nvm/versions/node/*/bin/node（按版本 sort -rV 取最新）
#
# 每個候選都要通過 --version 檢查且 major >= $MIN_NODE_MAJOR 才可用。

set -u

# `set -u` + launchd 極少數情境下 $HOME 可能未設；補一個 fallback
HOME="${HOME:-$(eval echo ~)}"

MIN_NODE_MAJOR="${OWNMIND_MIN_NODE_MAJOR:-20}"
OWNMIND_DIR="${OWNMIND_DIR:-$HOME/.ownmind}"

# Runtime opt-out：使用者可以建 ~/.ownmind/.no-usage-scanner 立即停掉 scanner
# （不用 launchctl unload / systemctl disable；下次 cron 被攔下）
if [ -f "${OWNMIND_DIR}/.no-usage-scanner" ]; then
  mkdir -p "${OWNMIND_DIR}/logs"
  echo "$(date -u +%FT%TZ) [scanner] opt-out flag present, skipping" >> "${OWNMIND_DIR}/logs/scanner.log"
  exit 0
fi
SCANNER_JS="${OWNMIND_DIR}/hooks/ownmind-usage-scanner.js"
LOG_DIR="${OWNMIND_DIR}/logs"
OUT_LOG="${LOG_DIR}/scanner.log"
ERR_LOG="${LOG_DIR}/scanner.err"
NODE_PATH_CACHE="${OWNMIND_DIR}/.node-path"

mkdir -p "$LOG_DIR"

TS() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

log_out() { echo "$(TS) $1" >> "$OUT_LOG"; }
log_err() { echo "$(TS) $1" >> "$ERR_LOG"; }

# 檢查候選是否能跑且版本合格
# $1 = candidate path
# return 0 if valid, 1 otherwise
check_node() {
  local cand="$1"
  [ -n "$cand" ] || return 1
  [ -x "$cand" ] || return 1
  local ver
  ver="$("$cand" --version 2>/dev/null)" || return 1
  # 期望 v20.12.3 之類格式
  local major
  major="$(echo "$ver" | sed -E 's/^v([0-9]+).*/\1/')"
  if [ -z "$major" ] || ! [ "$major" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    log_err "skip $cand (version=$ver < v$MIN_NODE_MAJOR)"
    return 1
  fi
  return 0
}

# 依序建候選清單
candidates=()

# 1. .node-path cache
if [ -f "$NODE_PATH_CACHE" ]; then
  cached="$(head -n 1 "$NODE_PATH_CACHE" 2>/dev/null)"
  [ -n "$cached" ] && candidates+=("$cached")
fi

# 2. PATH
if cmd_node="$(command -v node 2>/dev/null)"; then
  candidates+=("$cmd_node")
fi

# 3. 常見位置 + nvm glob（nvm 取最新版本）
# OWNMIND_SKIP_SYSTEM_CANDIDATES=1 停用系統路徑（測試用；避免真實 node 被撿到）
if [ "${OWNMIND_SKIP_SYSTEM_CANDIDATES:-0}" != "1" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && candidates+=("$p")
  done
  if [ -d "$HOME/.nvm/versions/node" ]; then
    # sort -rV：版本號倒序（v22.1 > v20.12 > v18.5）
    while IFS= read -r p; do
      [ -n "$p" ] && candidates+=("$p")
    done < <(ls -1d "$HOME/.nvm/versions/node"/*/bin/node 2>/dev/null | sort -rV)
  fi
fi

# 遍歷候選，取第一個通過檢查的
# 注意：bash `set -u` 下空 array `"${candidates[@]}"` 會拋錯，要先 guard size
NODE_BIN=""
if [ "${#candidates[@]}" -gt 0 ]; then
  for cand in "${candidates[@]}"; do
    if check_node "$cand"; then
      NODE_BIN="$cand"
      ver="$("$cand" --version 2>/dev/null)"
      log_out "[scanner] using node=$cand version=$ver"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  tried="${candidates[*]:-<none>}"
  log_err "no node >= v$MIN_NODE_MAJOR found. Candidates tried: $tried"
  exit 1
fi

if [ ! -f "$SCANNER_JS" ]; then
  log_err "scanner entry not found: $SCANNER_JS"
  exit 2
fi

exec "$NODE_BIN" "$SCANNER_JS"
