#!/usr/bin/env bash
# OwnMind Universal Bootstrap — install / upgrade / repair in one script
#
# Usage:
#   Already installed (upgrade only):
#     bash ~/.ownmind/scripts/bootstrap.sh
#     curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash
#   Fresh install / repair (needs API key + URL):
#     curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash -s -- YOUR_API_KEY YOUR_API_URL
#
# Branches:
#   1. ~/.ownmind not present         → fresh clone + install.sh "$@" (requires API key args)
#   2. ~/.ownmind present, no .git    → backup + re-clone + install.sh "$@" (requires API key args)
#   3. ~/.ownmind is a git repo       → delegate to scripts/interactive-upgrade.sh (no args needed)
#
# Env overrides (for testing):
#   OWNMIND_DIR   — install path (default: $HOME/.ownmind)
#   OWNMIND_REPO  — git URL      (default: https://github.com/miou1107/ownmind.git)
#
# Log format (machine-readable):
#   INFO:detect:<message>   — 進度訊息
#   OK:done:<message>       — 步驟成功
#   ERROR:install:<message> — 失敗

set -e
# pipefail: ensure `git clone ... | while read ...` propagates git's
# non-zero exit code instead of masking it behind the always-successful while.
set -o pipefail

OWNMIND_DIR="${OWNMIND_DIR:-$HOME/.ownmind}"
OWNMIND_REPO="${OWNMIND_REPO:-https://github.com/miou1107/ownmind.git}"
TS=$(date +%Y%m%d-%H%M%S)

log_info() { echo "INFO:$1:$2"; }
log_ok()   { echo "OK:$1:$2"; }
log_err()  { echo "ERROR:$1:$2" >&2; }

log_info detect "檢查 OwnMind 安裝狀態（$OWNMIND_DIR）"

# Branch 1: no install
if [ ! -d "$OWNMIND_DIR" ]; then
  log_info fresh "首次安裝，clone repo"
  git clone "$OWNMIND_REPO" "$OWNMIND_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done
  if [ ! -d "$OWNMIND_DIR/.git" ]; then
    log_err git_clone "git clone 失敗，請檢查網路或 GitHub 權限"
    exit 1
  fi
  log_ok clone "clone 完成"
  cd "$OWNMIND_DIR"
  log_info install "執行 install.sh（轉發參數 API_KEY + API_URL）"
  # Forward positional args ("$@") to install.sh; if missing, install.sh
  # prints its own friendly "請提供 API Key" message and exits non-zero.
  bash install.sh "$@" || { log_err install "install.sh 失敗（缺 API_KEY/URL 或其他錯誤）"; exit 1; }
  log_ok done "首次安裝完成"
  exit 0
fi

# Branch 2: broken
if [ ! -d "$OWNMIND_DIR/.git" ]; then
  BAK="${OWNMIND_DIR}.broken.${TS}"
  log_info broken "$OWNMIND_DIR 存在但不是 git repo，備份至 $BAK"
  mv "$OWNMIND_DIR" "$BAK" || { log_err backup "備份失敗"; exit 1; }
  log_ok backup "已備份"
  log_info fresh "重新 clone"
  git clone "$OWNMIND_REPO" "$OWNMIND_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done
  cd "$OWNMIND_DIR"
  bash install.sh "$@" || { log_err install "install.sh 失敗（缺 API_KEY/URL 或其他錯誤）"; exit 1; }
  log_ok done "修復完成（舊資料保留於 $BAK，3 天後可手動刪除）"
  exit 0
fi

# Branch 3: normal upgrade
log_info upgrade "已安裝，交給 interactive-upgrade.sh"
exec bash "$OWNMIND_DIR/scripts/interactive-upgrade.sh"
