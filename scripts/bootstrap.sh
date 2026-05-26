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
#   INFO:detect:<message>   — progress message
#   OK:done:<message>       — step succeeded
#   ERROR:install:<message> — failure

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

log_info detect "Checking OwnMind installation ($OWNMIND_DIR)"

# Branch 1: no install
if [ ! -d "$OWNMIND_DIR" ]; then
  log_info fresh "Fresh install: cloning repo"
  git clone "$OWNMIND_REPO" "$OWNMIND_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done
  if [ ! -d "$OWNMIND_DIR/.git" ]; then
    log_err git_clone "git clone failed (check network or GitHub access)"
    exit 1
  fi
  log_ok clone "Clone complete"
  cd "$OWNMIND_DIR"
  log_info install "Running install.sh (forwarding API_KEY + API_URL)"
  # Forward positional args ("$@") to install.sh; if missing, install.sh
  # prints its own friendly error message and exits non-zero.
  bash install.sh "$@" || { log_err install "install.sh failed (missing API_KEY/URL or other error)"; exit 1; }
  log_ok done "Fresh install complete"
  exit 0
fi

# Branch 2: broken
if [ ! -d "$OWNMIND_DIR/.git" ]; then
  BAK="${OWNMIND_DIR}.broken.${TS}"
  log_info broken "$OWNMIND_DIR exists but is not a git repo; backing up to $BAK"
  mv "$OWNMIND_DIR" "$BAK" || { log_err backup "Backup failed"; exit 1; }
  log_ok backup "Backed up"
  log_info fresh "Re-cloning"
  git clone "$OWNMIND_REPO" "$OWNMIND_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done
  cd "$OWNMIND_DIR"
  bash install.sh "$@" || { log_err install "install.sh failed (missing API_KEY/URL or other error)"; exit 1; }
  log_ok done "Repair complete (old data preserved at $BAK; backups older than 7 days are swept on next upgrade)"
  exit 0
fi

# Branch 3: normal upgrade
log_info upgrade "Installed; delegating to interactive-upgrade.sh"
exec bash "$OWNMIND_DIR/scripts/interactive-upgrade.sh"
