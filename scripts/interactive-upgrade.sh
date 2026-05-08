#!/usr/bin/env bash
# OwnMind 互動式升級 script (v1.17.0 P5)
#
# 用法：bash ~/.ownmind/scripts/interactive-upgrade.sh
# AI skill 呼叫後，逐行讀 stdout 判斷進度：
#   INFO:<code>:<message>   — 進度訊息（轉述給 user）
#   OK:<code>:<message>     — 步驟成功
#   ERROR:<code>:<message>  — 失敗（AI 依 code 引導修復）
#   ASK:<code>:<message>    — 需要 user 回答
#
# 失敗後執行 rollback（從 ~/.ownmind.bak.<timestamp> 還原）

set -u  # 不 set -e，因為要自己控制 error path

OWNMIND_DIR="${HOME}/.ownmind"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${HOME}/.ownmind.bak.${TS}"
LOG_FILE="${OWNMIND_DIR}/logs/upgrade-${TS}.log"

STEP() { echo "INFO:$1:$2"; }
OK()   { echo "OK:$1:$2"; }
FAIL() { echo "ERROR:$1:$2"; exit 1; }

mkdir -p "${OWNMIND_DIR}/logs"

# v1.17.79 — 載入 report-error helper（IR-038 觀測管道）
# source 失敗（檔不存在 / 舊版裝過沒這支）就 fallback 成 no-op，不擋升級
if [ -f "${OWNMIND_DIR}/scripts/install-helpers/report-error.sh" ]; then
  # shellcheck disable=SC1090
  . "${OWNMIND_DIR}/scripts/install-helpers/report-error.sh"
else
  report_error() { :; }
fi

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

rollback() {
  STEP "rollback" "Restoring backup ${BACKUP_DIR} -> ${OWNMIND_DIR}"
  rm -rf "${OWNMIND_DIR}"
  mv "${BACKUP_DIR}" "${OWNMIND_DIR}" && OK "rollback" "Restored previous version"
}

# --- 2. git pull ---
# v1.17.79：先偵測 dirty working tree（user 的 AI 助手手動編輯過 OwnMind 內檔很常見），
# dirty 就 report_error + git fetch + reset --hard origin/main 強制對齊（backup 保險絲已先做）。
# 真實案例：vin-windows-test 的 AI 編輯 mcp/start.cmd 加 fallback，下次 git pull --ff-only
# 直接被 reject、整個升級卡住，server 完全沒紀錄。
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
    FAIL "git_pull" "Force-align failed (network or permissions); backup restored"
  fi
elif git pull --ff-only >>"${LOG_FILE}" 2>&1; then
  OK "pull" "git pull complete"
else
  report_error "upgrade_git_pull_failed" "git pull --ff-only failed (network or non-ff merge)" "${LOG_FILE}"
  rollback
  FAIL "git_pull" "git pull failed; backup restored. Manual check: cd ~/.ownmind && git status"
fi

# --- 3. npm install (MCP 依賴) ---
if [ -f "${OWNMIND_DIR}/mcp/package.json" ]; then
  STEP "npm_install" "Updating MCP dependencies"
  cd "${OWNMIND_DIR}/mcp" || true
  if npm install --silent >>"${LOG_FILE}" 2>&1; then
    OK "npm_install" "MCP dependencies updated"
  else
    report_error "upgrade_npm_install_failed" "MCP npm install failed" "${LOG_FILE}"
    rollback
    FAIL "npm_install" "MCP npm install failed; backup restored. Check ${LOG_FILE}"
  fi
fi

# --- 4. Re-run install.sh (read creds from existing ~/.claude/settings.json) ---
STEP "install" "Re-running install.sh (sync skills / hooks / scheduler)"
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
API_KEY=""
API_URL=""
if [ -f "${CLAUDE_SETTINGS}" ]; then
  CREDS=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('${CLAUDE_SETTINGS}', 'utf8'));
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
    FAIL "install" "scripts/update.sh also failed; backup restored"
  fi
else
  cd "${OWNMIND_DIR}"
  if bash install.sh "${API_KEY}" "${API_URL}" >>"${LOG_FILE}" 2>&1; then
    OK "install" "Setup complete"
  else
    rollback
    FAIL "install" "install.sh failed (see ${LOG_FILE}); backup restored"
  fi
fi

# --- 5. 重註冊排程 ---
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

# --- 6. 本地驗測 + server round-trip + 清理 ---
if [ -x "${OWNMIND_DIR}/scripts/verify-upgrade.sh" ]; then
  STEP "verify_local" "Verifying local components"
  if bash "${OWNMIND_DIR}/scripts/verify-upgrade.sh" --local >>"${LOG_FILE}" 2>&1; then
    OK "verify_local" "Local components present"
  else
    rollback
    FAIL "verify_local" "Local verification failed (missing files). See ${LOG_FILE}"
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

# --- 7. 告知 server 升級完成 → 主動 dismiss upgrade_reminder 廣播 ---
# v1.17.18: 把 dismiss 從 AI skill 移到腳本本身（IR-027「邏輯才有效」）。
# 之前依賴 AI 讀完 OK:done:* 後手動呼叫 /api/broadcast/dismiss，
# 漏做時 broadcast 一直不會 dismiss → user 每個 session 都重看升級提醒。
VERSION=$(node -p "require('${OWNMIND_DIR}/package.json').version" 2>/dev/null || echo "unknown")

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

# v1.17.70：升級成功末段 sweep ~/.ownmind.bak.<ts>/ 超過 N 天的（IR-027 邏輯卡控）。
# 預設 7 天，可用 OWNMIND_BACKUP_RETENTION_DAYS 環境變數覆蓋。
# 防呆：sweep 失敗（權限 / 磁碟）也不影響升級結果。
# 設計選擇：單次 sweep、不預先 wc 計數（避免 count vs delete race + 處理檔名特殊字元的 wc 噪音）。
RETENTION_DAYS="${OWNMIND_BACKUP_RETENTION_DAYS:-7}"
STEP "sweep" "Sweeping backups older than ${RETENTION_DAYS} days (if any)"
find "${HOME}" -maxdepth 1 -type d -name '.ownmind.bak.*' -mtime +"${RETENTION_DAYS}" -exec rm -rf {} + 2>/dev/null || true
OK "sweep" "Old backup sweep complete"

OK "done" "Upgrade complete -> version ${VERSION}. Backup kept at ${BACKUP_DIR} (auto-swept after ${RETENTION_DAYS} days)"

# v1.17.63: 升級完跑 self-check，把當下本機狀態抓下來、寫 log + 上傳。失敗不擋升級訊息。
SELF_CHECK_SCRIPT="${OWNMIND_DIR}/scripts/install-helpers/self-check.cjs"
if [ -f "${SELF_CHECK_SCRIPT}" ]; then
  node "${SELF_CHECK_SCRIPT}" --trigger=post_upgrade || true
fi

exit 0
