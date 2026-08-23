#!/bin/bash
# run-scanner.sh — OwnMind token usage scanner wrapper
#
# Purpose: launchd / systemd / Task Scheduler invokes this script; it dynamically locates a
#          working node, verifies the version, then exec's the actual scanner JS.
#          Avoids hard-coding paths in plist/service files.
#
# Copied to ~/.ownmind/bin/run-scanner.sh by install.sh.
# Plan P6 / D12.
#
# Candidate node paths (tried in order):
#   1. ~/.ownmind/.node-path (written by install when it detected node)
#   2. `command -v node` (current PATH)
#   3. Common globs: /opt/homebrew/bin/node, /usr/local/bin/node,
#                    ~/.nvm/versions/node/*/bin/node (sorted by version, newest first)
#
# Each candidate must pass --version and have major >= $MIN_NODE_MAJOR to be selected.

set -u

# `set -u` + launchd edge cases occasionally leave $HOME unset; provide a fallback.
HOME="${HOME:-$(eval echo ~)}"

MIN_NODE_MAJOR="${OWNMIND_MIN_NODE_MAJOR:-20}"
OWNMIND_DIR="${OWNMIND_DIR:-$HOME/.ownmind}"

# Runtime opt-out: the user can create ~/.ownmind/.no-usage-scanner to disable the scanner
# immediately (no launchctl unload / systemctl disable needed; the next cron firing skips it).
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

# Check whether a candidate runs and meets the version requirement.
# $1 = candidate path
# return 0 if valid, 1 otherwise
check_node() {
  local cand="$1"
  [ -n "$cand" ] || return 1
  [ -x "$cand" ] || return 1
  local ver
  ver="$("$cand" --version 2>/dev/null)" || return 1
  # Expect something like v20.12.3.
  local major
  major="$(echo "$ver" | sed -E 's/^v([0-9]+).*/\1/')"
  if [ -z "$major" ] || ! [ "$major" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    log_err "skip $cand (version=$ver < v$MIN_NODE_MAJOR)"
    return 1
  fi
  return 0
}

# Build the candidate list in order.
candidates=()

# 1. .node-path cache.
if [ -f "$NODE_PATH_CACHE" ]; then
  cached="$(head -n 1 "$NODE_PATH_CACHE" 2>/dev/null)"
  [ -n "$cached" ] && candidates+=("$cached")
fi

# 2. PATH.
if cmd_node="$(command -v node 2>/dev/null)"; then
  candidates+=("$cmd_node")
fi

# 3. Common locations + nvm glob (nvm picks the newest version).
# OWNMIND_SKIP_SYSTEM_CANDIDATES=1 disables system paths (for tests; prevents a real node
# from being picked up).
if [ "${OWNMIND_SKIP_SYSTEM_CANDIDATES:-0}" != "1" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && candidates+=("$p")
  done
  if [ -d "$HOME/.nvm/versions/node" ]; then
    # sort -rV: version-aware reverse sort (v22.1 > v20.12 > v18.5).
    while IFS= read -r p; do
      [ -n "$p" ] && candidates+=("$p")
    done < <(ls -1d "$HOME/.nvm/versions/node"/*/bin/node 2>/dev/null | sort -rV)
  fi
fi

# Iterate candidates, pick the first that passes the check.
# Note: under bash `set -u`, an empty array `"${candidates[@]}"` throws — guard with a size check first.
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

# The scanner runs the whole upgrade behind it: git pull, `npm install`, then
# scripts/update.sh, which is what copies the hooks into ~/.claude/hooks. A scheduler hands
# out its own PATH, not a login shell's — launchd gives /usr/bin:/bin:/usr/sbin:/sbin — so
# git resolved from /usr/bin and npm, living in /opt/homebrew/bin or under ~/.nvm, did not.
# Measured on one Mac: `update_failed step=npm error=ENOENT` 123 times across 12 days, with
# the machine reporting the new version while still running the previous release's hooks.
# The candidate search above already had to find node; npm is its neighbour, so putting that
# directory on PATH fixes every child at once, including the npm calls inside update.sh.
NODE_DIR="$(dirname "$NODE_BIN")"
# `dirname` answers "." for a bare or backslash-separated path, and "." on PATH means "run
# whatever is in the current directory" — never what was wanted here.
case "$NODE_DIR" in
  /*)
    case ":${PATH}:" in
      *":${NODE_DIR}:"*) ;;
      *) PATH="${NODE_DIR}:${PATH}"; export PATH ;;
    esac
    ;;
esac

exec "$NODE_BIN" "$SCANNER_JS"
