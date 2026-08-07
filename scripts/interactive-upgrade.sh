#!/usr/bin/env bash
# OwnMind interactive upgrade script (v1.17.0 P5)
#
# Usage: bash ~/.ownmind/scripts/interactive-upgrade.sh
# After the AI skill calls this, it reads stdout line by line to judge progress:
#   INFO:<code>:<message>   — progress message (paraphrase to user)
#   OK:<code>:<message>     — step succeeded
#   ERROR:<code>:<message>  — failure (AI guides repair based on code)
#   ASK:<code>:<message>    — needs user input
#
# On failure, performs rollback (restores from ~/.ownmind.bak.<timestamp>).

set -u  # do not set -e; we want to control error paths ourselves

OWNMIND_DIR="${HOME}/.ownmind"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${HOME}/.ownmind.bak.${TS}"

# v1.26.88 — the log lives OUTSIDE ${OWNMIND_DIR}.
# rollback() is `rm -rf "${OWNMIND_DIR}"` followed by `mv "${BACKUP_DIR}" "${OWNMIND_DIR}"`.
# While this file lived under ${OWNMIND_DIR}/logs/, every failure message that said
# "see ~/.ownmind/logs/upgrade-<TS>.log" named a file the same function had just deleted.
# Measured on TANK, 2026-08-06: 0 bytes, on the one failure anybody wanted to read.
# Bug report #15.
LOG_DIR="${HOME}/.ownmind-logs"
# The fallback must also be outside ${OWNMIND_DIR}. Falling back to ${OWNMIND_DIR}/logs
# would quietly restore the exact bug this block removes, and the covering test only reads
# the LOG_FILE= line — it would still pass.
mkdir -p "${LOG_DIR}" 2>/dev/null || LOG_DIR="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}")"
LOG_FILE="${LOG_DIR}/upgrade-${TS}.log"

# v1.26.7 — normalize paths for Node.exe on Windows + Git Bash.
# Without this, ${OWNMIND_DIR}=/c/Users/Vin/.ownmind makes require() fail with
# MODULE_NOT_FOUND. See path-helpers.sh.
if [ -f "${OWNMIND_DIR}/scripts/install-helpers/path-helpers.sh" ]; then
  # shellcheck disable=SC1091
  . "${OWNMIND_DIR}/scripts/install-helpers/path-helpers.sh"
else
  to_win_path() { echo "$1"; }
fi
OWNMIND_DIR_WIN="$(to_win_path "${OWNMIND_DIR}")"

STEP() { echo "INFO:$1:$2"; }
OK()   { echo "OK:$1:$2"; }
# v1.17.85 IR-038: FAIL uniformly appends a fallback report_error so any "uncovered FAIL path"
# leaves observability data behind. Bob (id=3) / Dana (id=6) ran update_started beacons
# on 2026-05-10 and 2026-05-11 but produced neither a post_install record nor any errors-spool
# entry — this was that observability gap.
# Use the _terminal suffix on `kind` so admins can tell it's a "terminal observation" (callers
# may also have called a more specific report_error — that's a _step-level observation; the
# FAIL fallback is the catch-all _terminal level).
# report_error is already noop-on-missing, so a second call is harmless.
FAIL() {
  echo "ERROR:$1:$2"
  report_error "upgrade_failed_terminal_$1" "$2" "${LOG_FILE:-}" 2>/dev/null || true
  exit 1
}

mkdir -p "${OWNMIND_DIR}/logs"

# v1.17.79 — load the report-error helper (IR-038 observability pipeline).
# If source fails (file missing / older install lacked it), fall back to no-op — never block upgrade.
if [ -f "${OWNMIND_DIR}/scripts/install-helpers/report-error.sh" ]; then
  # shellcheck disable=SC1090
  . "${OWNMIND_DIR}/scripts/install-helpers/report-error.sh"
else
  report_error() { :; }
fi

# v1.17.84 — Windows file-lock detection (vin-windows-test round 7).
# When the OwnMind MCP node process holds handles to ~/.ownmind/mcp/node_modules/*.js,
# `git pull` / `npm install` / `install.sh` attempting to overwrite hits EBUSY / EACCES.
# Scan the error log for lock patterns; if matched, change the error code to file_locked
# and give a clear "close Claude Code and re-run" message.
is_file_lock_error() {
  local log="$1"
  [ -f "$log" ] || return 1
  # v1.26.98 — 'it is in use' / 'being used by another' added: PowerShell's own wording when
  # Remove-Item cannot delete a locked directory is "... because it is in use.", which matched
  # none of the previous patterns. Kept identical to $script:FileLockPattern in the .ps1 (IR-022).
  grep -qiE 'EBUSY|EACCES|EPERM|Permission denied|in use by another|another process|file is locked|resource busy|access is denied|it is in use|being used by another' "$log"
}

# --- 0. Pre-check ---
STEP "check" "Checking OwnMind directory"
[ -d "${OWNMIND_DIR}" ] || FAIL "no_ownmind" "${OWNMIND_DIR} not found; run install.sh for fresh install"
[ -d "${OWNMIND_DIR}/.git" ] || FAIL "no_git" "${OWNMIND_DIR} is not a git repo; cannot upgrade"

# --- 1. Backup ---
STEP "backup" "Backing up to ${BACKUP_DIR}"
if cp -r "${OWNMIND_DIR}" "${BACKUP_DIR}" >>"${LOG_FILE}" 2>&1; then
  OK "backup" "Backup complete"
else
  FAIL "backup_failed" "Backup failed (check disk space)"
fi

# v1.26.98 — rollback() used to report success by accident: `mv ... && OK` simply printed
# nothing when the move failed, and `rm -rf` was never checked at all, while every caller
# went on to emit a hard-coded "backup restored". FAIL forwards that same string to the
# server as the Detail of upgrade_failed_terminal_*, so a failed rollback produced a
# diagnostic record asserting a restore that never happened. Kept symmetric with the .ps1
# side (IR-022), where the Windows file-lock case makes this the common failure, not a rare one.
ROLLBACK_FAILED=0

rollback() {
  STEP "rollback" "Restoring backup ${BACKUP_DIR} -> ${OWNMIND_DIR}"
  ROLLBACK_FAILED=0
  if ! rm -rf "${OWNMIND_DIR}" >>"${LOG_FILE}" 2>&1; then
    ROLLBACK_FAILED=1
  elif ! mv "${BACKUP_DIR}" "${OWNMIND_DIR}" >>"${LOG_FILE}" 2>&1; then
    ROLLBACK_FAILED=1
  fi
  if [ "${ROLLBACK_FAILED}" -eq 1 ]; then
    if is_file_lock_error "${LOG_FILE}"; then
      ROLLBACK_KIND="rollback_file_locked"
    else
      ROLLBACK_KIND="rollback_failed"
    fi
    echo "ERROR:${ROLLBACK_KIND}:could not restore ${BACKUP_DIR} -> ${OWNMIND_DIR}"
    report_error "upgrade_${ROLLBACK_KIND}" "Rollback failed; backup left at ${BACKUP_DIR}" "${LOG_FILE}"
  else
    OK "rollback" "Restored previous version"
  fi
}

# The tail every rollback caller appends to its failure message, so the message describes the
# machine's real state instead of the state the rollback was supposed to produce.
rollback_note() {
  if [ "${ROLLBACK_FAILED}" -eq 1 ]; then
    printf 'ROLLBACK ALSO FAILED - %s may be half-updated and the backup is still at %s; restore it manually' \
      "${OWNMIND_DIR}" "${BACKUP_DIR}"
  else
    printf 'backup restored'
  fi
}

# --- 2. git pull ---
# v1.17.79: detect a dirty working tree first (very common when the user's AI assistant has
# manually edited files inside OwnMind). If dirty, report_error + git fetch + reset --hard
# origin/main to force alignment (the backup is already taken as a safety net).
# Real case: vin-windows-test's AI edited mcp/start.cmd to add a fallback; the next
# `git pull --ff-only` was rejected outright and the whole upgrade stalled — the server saw nothing.
STEP "pull" "Pulling latest OwnMind"
cd "${OWNMIND_DIR}" || FAIL "cd_failed" "Cannot enter ${OWNMIND_DIR}"

DIRTY=$(git status --porcelain 2>/dev/null)
if [ -n "${DIRTY}" ]; then
  STEP "pull_dirty" "Working tree has uncommitted changes; auto-aligning to origin/main (backup already saved)"
  echo "${DIRTY}" > "${LOG_FILE}.dirty"
  report_error "upgrade_dirty_tree" "git status --porcelain non-empty; auto reset --hard to origin/main" "${LOG_FILE}.dirty"
  if git fetch origin >>"${LOG_FILE}" 2>&1 \
     && git reset --hard origin/main >>"${LOG_FILE}" 2>&1; then
    OK "pull" "Force-aligned (dirty changes overwritten; previous state in backup)"
  else
    report_error "upgrade_git_pull_failed" "fetch + reset --hard origin/main failed" "${LOG_FILE}"
    rollback
    FAIL "git_pull" "Force-align failed (network or permissions); $(rollback_note)"
  fi
elif git pull --ff-only >>"${LOG_FILE}" 2>&1; then
  OK "pull" "git pull complete"
else
  # v1.26.98 — carry git's own words into the report. "(network or non-ff merge)" was a guess,
  # and a guess is all the server ever received, so no failed upgrade could be diagnosed from
  # the record alone. The log already holds the real output; quote its tail into the Detail.
  GIT_SAID=$(tail -n 5 "${LOG_FILE}" 2>&1 | tr '\n' ' ')
  report_error "upgrade_git_pull_failed" "git pull --ff-only failed: ${GIT_SAID}" "${LOG_FILE}"
  rollback
  FAIL "git_pull" "git pull failed (${GIT_SAID}); $(rollback_note). Manual check: cd ~/.ownmind && git status"
fi

# --- 3. npm install (MCP deps) ---
if [ -f "${OWNMIND_DIR}/mcp/package.json" ]; then
  STEP "npm_install" "Updating MCP dependencies"
  cd "${OWNMIND_DIR}/mcp" || true
  if npm install --silent >>"${LOG_FILE}" 2>&1; then
    OK "npm_install" "MCP dependencies updated"
  else
    if is_file_lock_error "${LOG_FILE}"; then
      report_error "upgrade_file_locked" "npm install hit file lock (likely Claude Code running)" "${LOG_FILE}"
      rollback
      FAIL "file_locked" "Files in use by another process (likely Claude Code); $(rollback_note). Close Claude Code completely, then re-run upgrade."
    fi
    report_error "upgrade_npm_install_failed" "MCP npm install failed" "${LOG_FILE}"
    rollback
    FAIL "npm_install" "MCP npm install failed; $(rollback_note). Check ${LOG_FILE}"
  fi
fi

# --- 4. Re-run install.sh (read creds from existing ~/.claude/settings.json) ---
STEP "install" "Re-running install.sh (sync skills / hooks / scheduler)"
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
CLAUDE_SETTINGS_WIN="$(to_win_path "${CLAUDE_SETTINGS}")"
API_KEY=""
API_URL=""
if [ -f "${CLAUDE_SETTINGS}" ]; then
  CREDS=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('${CLAUDE_SETTINGS_WIN}', 'utf8'));
      const srv = (s.mcpServers && s.mcpServers.ownmind) || {};
      const env = srv.env || {};
      console.log(env.OWNMIND_API_KEY || '');
      console.log(env.OWNMIND_API_URL || '');
    } catch { process.exit(0); }
  " 2>/dev/null)
  API_KEY=$(echo "${CREDS}" | sed -n '1p')
  API_URL=$(echo "${CREDS}" | sed -n '2p')
fi

if [ -z "${API_KEY}" ] || [ -z "${API_URL}" ]; then
  STEP "install" "No existing credentials; skipping install.sh re-run (skill/hook synced by update.sh)"
  STEP "install_fallback" "Running scripts/update.sh to sync skills + hooks"
  cd "${OWNMIND_DIR}"
  if bash scripts/update.sh >>"${LOG_FILE}" 2>&1; then
    OK "install" "update.sh complete (scheduler not re-registered; run install.sh manually if needed)"
  else
    rollback
    FAIL "install" "scripts/update.sh also failed; $(rollback_note)"
  fi
else
  cd "${OWNMIND_DIR}"
  # v1.26.88 — exit 2 means "install.sh ran to the end and found itself incomplete".
  # Do NOT roll back on 2: rollback() only replaces ${OWNMIND_DIR}, while install.sh has
  # already rewritten ~/.claude/settings.json, the hook scripts, the skill files and
  # git's core.hooksPath. Restoring the code alone would pair old code with new
  # configuration, and it cannot produce the missing artifacts anyway. The self-check
  # inside install.sh has already reported the condition to the server.
  install_status=0
  bash install.sh "${API_KEY}" "${API_URL}" >>"${LOG_FILE}" 2>&1 || install_status=$?
  if [ "${install_status}" -eq 0 ]; then
    OK "install" "Setup complete"
  elif [ "${install_status}" -eq 2 ]; then
    report_error "install_incomplete" "install.sh exited 2 (artifacts missing); not rolled back" "${LOG_FILE}"
    STEP "install" "Installation finished but is incomplete — see ${LOG_FILE}. Not rolled back (rollback cannot create the missing parts). Re-run: bash ~/.ownmind/scripts/bootstrap.sh"
  else
    rollback
    FAIL "install" "install.sh failed (see ${LOG_FILE}); $(rollback_note)"
  fi
fi

# --- 5. Re-register the scheduled task ---
case "$(uname -s)" in
  Darwin)
    if [ -f "${HOME}/Library/LaunchAgents/com.ownmind.usage-scanner.plist" ]; then
      STEP "reschedule" "Reloading launchd agent"
      launchctl unload "${HOME}/Library/LaunchAgents/com.ownmind.usage-scanner.plist" 2>/dev/null || true
      if launchctl load "${HOME}/Library/LaunchAgents/com.ownmind.usage-scanner.plist" 2>>"${LOG_FILE}"; then
        OK "reschedule" "launchd reload complete"
      else
        STEP "reschedule" "launchd reload failed; upgrade itself complete (handle manually)"
      fi
    fi
    ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      STEP "reschedule" "Reloading systemd user timer"
      systemctl --user daemon-reload 2>/dev/null || true
      systemctl --user restart ownmind-usage-scanner.timer 2>/dev/null && OK "reschedule" "systemd timer restarted" || true
    fi
    ;;
esac

# --- 6. Local verification + server round-trip + cleanup ---
if [ -x "${OWNMIND_DIR}/scripts/verify-upgrade.sh" ]; then
  STEP "verify_local" "Verifying local components"
  if bash "${OWNMIND_DIR}/scripts/verify-upgrade.sh" --local >>"${LOG_FILE}" 2>&1; then
    OK "verify_local" "Local components present"
  else
    # NOTE: the .ps1 side stopped rolling back here in v1.17.66 ("verify is a post-hoc health
    # check, it does not gate the upgrade") but this side still does. Left as-is rather than
    # changed silently — see the PR discussion; only the message is made truthful here.
    rollback
    FAIL "verify_local" "Local verification failed (missing files); $(rollback_note). See ${LOG_FILE}"
  fi

  STEP "verify_server" "Verifying server connectivity (write/read + iron rule)"
  if bash "${OWNMIND_DIR}/scripts/verify-upgrade.sh" --server >>"${LOG_FILE}" 2>&1; then
    OK "verify_server" "Server reachable"
  else
    STEP "verify_server" "Server verification failed (possible network blip); upgrade itself complete. See ${LOG_FILE}"
  fi

  STEP "cleanup" "Cleaning up test data"
  bash "${OWNMIND_DIR}/scripts/verify-upgrade.sh" --cleanup >>"${LOG_FILE}" 2>&1 \
    && OK "cleanup" "Test data cleaned" \
    || STEP "cleanup" "Cleanup failed (super_admin can clear __upgrade_test__ later)"
fi

# --- 7. Tell the server we finished upgrading → proactively dismiss upgrade_reminder broadcasts ---
# v1.17.18: moved dismiss from the AI skill into the script (IR-027 "only logic works").
# Previously this relied on the AI calling /api/broadcast/dismiss after seeing OK:done:*;
# when missed, the broadcast never dismissed and the user kept seeing the upgrade prompt every session.
VERSION=$(node -p "require('${OWNMIND_DIR_WIN}/package.json').version" 2>/dev/null || echo "unknown")

if [ -n "${API_KEY}" ] && [ -n "${API_URL}" ] && [ "${VERSION}" != "unknown" ]; then
  STEP "dismiss" "Dismissing stale upgrade broadcasts"
  ACTIVE=$(curl -sf --max-time 5 \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "X-Ownmind-Version: ${VERSION}" \
    "${API_URL}/api/broadcast/active?tool=claude-code&client_version=${VERSION}" 2>/dev/null || echo "[]")
  IDS=$(echo "${ACTIVE}" | node -e '
    let buf = "";
    process.stdin.on("data", d => buf += d);
    process.stdin.on("end", () => {
      try {
        const arr = JSON.parse(buf || "[]");
        if (!Array.isArray(arr)) return;
        for (const b of arr) {
          if (b && b.type === "upgrade_reminder" && b.id) console.log(b.id);
        }
      } catch {}
    });
  ' 2>/dev/null)
  COUNT=0
  if [ -n "${IDS}" ]; then
    while IFS= read -r ID; do
      [ -z "$ID" ] && continue
      curl -sf --max-time 3 -X POST \
        -H "Authorization: Bearer ${API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"broadcast_id\":${ID},\"tool\":\"claude-code\"}" \
        "${API_URL}/api/broadcast/dismiss" >/dev/null 2>&1 \
        && COUNT=$((COUNT + 1))
    done <<< "${IDS}"
  fi
  OK "dismiss" "Upgrade broadcasts dismissed (${COUNT})"
fi

# v1.17.70: at the tail of a successful upgrade, sweep ~/.ownmind.bak.<ts>/ older than N days
# (IR-027 logic gating). Default 7 days; override with the OWNMIND_BACKUP_RETENTION_DAYS env var.
# Safety: if the sweep fails (permissions / disk), it does not affect the upgrade result.
# Design choice: single sweep, no pre-count via wc (avoids count-vs-delete race + filename
# special-char noise from wc).
RETENTION_DAYS="${OWNMIND_BACKUP_RETENTION_DAYS:-7}"
STEP "sweep" "Sweeping backups older than ${RETENTION_DAYS} days (if any)"
find "${HOME}" -maxdepth 1 -type d -name '.ownmind.bak.*' -mtime +"${RETENTION_DAYS}" -exec rm -rf {} + 2>/dev/null || true
OK "sweep" "Old backup sweep complete"

OK "done" "Upgrade complete -> version ${VERSION}. Backup kept at ${BACKUP_DIR} (auto-swept after ${RETENTION_DAYS} days)"

# v1.17.86 — upgrade_complete beacon (IR-038 observability backfill).
# Earlier than self-check, with a small payload that can't stall — the server at least sees
# "this user finished upgrading, version X".
# Scenario: Bob / Dana reached 1.17.84 but install_check_logs had no post_install row
# (collector_heartbeat confirmed the upgrade landed). Possible cause: self-check ran, upload
# failed and spooled for the next drain, but the user quit Claude Code right after the
# upgrade — so the next drain never happened. upgrade_complete sends earlier + simple
# fail-fast 5s timeout + spool fallback, sidestepping that race.
send_upgrade_complete_beacon() {
  local version="$1"
  # v1.26.88 — to_win_path, or node.exe never finds it under Git Bash and this beacon
  # silently returns empty credentials on every Windows machine. Bug report #15.
  local claude_settings
  claude_settings="$(to_win_path "$HOME/.claude/settings.json")"
  [ -f "$HOME/.claude/settings.json" ] || return
  local api_key api_url
  api_key=$(node -p "try { require('$claude_settings').mcpServers.ownmind.env.OWNMIND_API_KEY } catch { '' }" 2>>"${LOG_FILE:-/dev/null}")
  api_url=$(node -p "try { require('$claude_settings').mcpServers.ownmind.env.OWNMIND_API_URL } catch { '' }" 2>>"${LOG_FILE:-/dev/null}")
  [ -n "$api_key" ] && [ -n "$api_url" ] || return
  local ts machine platform body
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  machine="$(hostname 2>/dev/null || echo unknown)"
  case "$OSTYPE" in
    darwin*) platform='darwin' ;;
    linux*) platform='linux' ;;
    msys*|cygwin*|win32*) platform='win32' ;;
    *) platform="$OSTYPE" ;;
  esac
  body=$(printf '{"ts":"%s","trigger":"upgrade_complete","client_version":"%s","platform":"%s","machine":"%s"}' \
    "$ts" "$version" "$platform" "$machine")
  if curl -fsS -m 5 -X POST \
    -H "Authorization: Bearer $api_key" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${api_url%/}/api/debug/install-check" >/dev/null 2>&1; then
    return
  fi
  # spool fallback (same pattern as v1.17.80)
  local spool_dir="${HOME}/.ownmind/logs"
  mkdir -p "$spool_dir" 2>/dev/null || return
  printf '%s\n' "$body" >> "${spool_dir}/.upload-spool.jsonl" 2>/dev/null || true
}
send_upgrade_complete_beacon "${VERSION}"

# v1.17.63: after upgrade, run self-check to capture the current local state, write the log,
# and upload. Any failure does NOT block the upgrade message.
SELF_CHECK_SCRIPT="${OWNMIND_DIR}/scripts/install-helpers/self-check.cjs"
if [ -f "${SELF_CHECK_SCRIPT}" ]; then
  node "${SELF_CHECK_SCRIPT}" --trigger=post_upgrade || true
fi

exit 0
