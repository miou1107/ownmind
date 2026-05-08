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
STEP "check" "檢查 OwnMind 目錄是否存在"
[ -d "${OWNMIND_DIR}" ] || FAIL "no_ownmind" "找不到 ${OWNMIND_DIR}，請先跑 install.sh 初始安裝"
[ -d "${OWNMIND_DIR}/.git" ] || FAIL "no_git" "${OWNMIND_DIR} 不是 git repo，無法升級"

# --- 1. 備份 ---
STEP "backup" "備份到 ${BACKUP_DIR}"
if cp -r "${OWNMIND_DIR}" "${BACKUP_DIR}" >>"${LOG_FILE}" 2>&1; then
  OK "backup" "備份完成"
else
  FAIL "backup_failed" "備份失敗，請檢查磁碟空間"
fi

rollback() {
  STEP "rollback" "還原備份 ${BACKUP_DIR} → ${OWNMIND_DIR}"
  rm -rf "${OWNMIND_DIR}"
  mv "${BACKUP_DIR}" "${OWNMIND_DIR}" && OK "rollback" "已還原舊版"
}

# --- 2. git pull ---
# v1.17.79：先偵測 dirty working tree（user 的 AI 助手手動編輯過 OwnMind 內檔很常見），
# dirty 就 report_error + git fetch + reset --hard origin/main 強制對齊（backup 保險絲已先做）。
# 真實案例：vin-windows-test 的 AI 編輯 mcp/start.cmd 加 fallback，下次 git pull --ff-only
# 直接被 reject、整個升級卡住，server 完全沒紀錄。
STEP "pull" "拉取最新 OwnMind"
cd "${OWNMIND_DIR}" || FAIL "cd_failed" "無法進入 ${OWNMIND_DIR}"

DIRTY=$(git status --porcelain 2>/dev/null)
if [ -n "${DIRTY}" ]; then
  STEP "pull_dirty" "偵測到 working tree 有未 commit 改動，自動對齊 origin/main（備份已先做）"
  echo "${DIRTY}" > "${LOG_FILE}.dirty"
  report_error "upgrade_dirty_tree" "git status --porcelain 非空，自動 reset --hard 對齊 origin/main" "${LOG_FILE}.dirty"
  if git fetch origin >>"${LOG_FILE}" 2>&1 \
     && git reset --hard origin/main >>"${LOG_FILE}" 2>&1; then
    OK "pull" "強制對齊完成（dirty 改動已蓋掉，舊版見備份）"
  else
    report_error "upgrade_git_pull_failed" "fetch + reset --hard origin/main 失敗" "${LOG_FILE}"
    rollback
    FAIL "git_pull" "強制對齊也失敗（網路或權限），備份已還原"
  fi
elif git pull --ff-only >>"${LOG_FILE}" 2>&1; then
  OK "pull" "git pull 成功"
else
  report_error "upgrade_git_pull_failed" "git pull --ff-only 失敗（可能網路或非 ff merge）" "${LOG_FILE}"
  rollback
  FAIL "git_pull" "git pull 失敗（可能網路），備份已還原。手動檢查：cd ~/.ownmind && git status"
fi

# --- 3. npm install (MCP 依賴) ---
if [ -f "${OWNMIND_DIR}/mcp/package.json" ]; then
  STEP "npm_install" "更新 MCP 依賴"
  cd "${OWNMIND_DIR}/mcp" || true
  if npm install --silent >>"${LOG_FILE}" 2>&1; then
    OK "npm_install" "MCP 依賴完成"
  else
    report_error "upgrade_npm_install_failed" "MCP npm install 失敗" "${LOG_FILE}"
    rollback
    FAIL "npm_install" "MCP npm install 失敗；備份已還原，請檢查 ${LOG_FILE}"
  fi
fi

# --- 4. Re-run install.sh（從現有 ~/.claude/settings.json 讀 creds）---
STEP "install" "重跑 install.sh（skill / hook / 排程同步）"
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
  STEP "install" "找不到現有 credentials，跳過 install.sh 重跑（skill/hook 可由後續 update.sh 補）"
  STEP "install_fallback" "執行 scripts/update.sh 同步 skill + hook"
  cd "${OWNMIND_DIR}"
  if bash scripts/update.sh >>"${LOG_FILE}" 2>&1; then
    OK "install" "update.sh setup 完成（scheduler 未重註冊，請手動跑 install.sh）"
  else
    rollback
    FAIL "install" "scripts/update.sh 也失敗，已還原"
  fi
else
  cd "${OWNMIND_DIR}"
  if bash install.sh "${API_KEY}" "${API_URL}" >>"${LOG_FILE}" 2>&1; then
    OK "install" "setup 完成"
  else
    rollback
    FAIL "install" "install.sh 失敗（詳細見 ${LOG_FILE}）；備份已還原"
  fi
fi

# --- 5. 重註冊排程 ---
case "$(uname -s)" in
  Darwin)
    if [ -f "${HOME}/Library/LaunchAgents/com.ownmind.usage-scanner.plist" ]; then
      STEP "reschedule" "重載 launchd agent"
      launchctl unload "${HOME}/Library/LaunchAgents/com.ownmind.usage-scanner.plist" 2>/dev/null || true
      if launchctl load "${HOME}/Library/LaunchAgents/com.ownmind.usage-scanner.plist" 2>>"${LOG_FILE}"; then
        OK "reschedule" "launchd 重載完成"
      else
        STEP "reschedule" "launchd 重載失敗，但升級已完成，可手動處理"
      fi
    fi
    ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      STEP "reschedule" "reload systemd user timer"
      systemctl --user daemon-reload 2>/dev/null || true
      systemctl --user restart ownmind-usage-scanner.timer 2>/dev/null && OK "reschedule" "systemd timer restarted" || true
    fi
    ;;
esac

# --- 6. 本地驗測 + server round-trip + 清理 ---
if [ -x "${OWNMIND_DIR}/scripts/verify-upgrade.sh" ]; then
  STEP "verify_local" "本地元件驗測"
  if bash "${OWNMIND_DIR}/scripts/verify-upgrade.sh" --local >>"${LOG_FILE}" 2>&1; then
    OK "verify_local" "本地元件全在"
  else
    rollback
    FAIL "verify_local" "本地驗測失敗（缺檔）。詳細見 ${LOG_FILE}"
  fi

  STEP "verify_server" "Server 連線 + 寫入讀取測試 + 鐵律觸發"
  if bash "${OWNMIND_DIR}/scripts/verify-upgrade.sh" --server >>"${LOG_FILE}" 2>&1; then
    OK "verify_server" "server 正常"
  else
    STEP "verify_server" "server 驗測失敗（可能網路暫斷），升級本身已完成。詳細見 ${LOG_FILE}"
  fi

  STEP "cleanup" "清理測試資料"
  bash "${OWNMIND_DIR}/scripts/verify-upgrade.sh" --cleanup >>"${LOG_FILE}" 2>&1 \
    && OK "cleanup" "測試資料已清" \
    || STEP "cleanup" "清理失敗（稍後 super_admin 可手動清 __upgrade_test__）"
fi

# --- 7. 告知 server 升級完成 → 主動 dismiss upgrade_reminder 廣播 ---
# v1.17.18: 把 dismiss 從 AI skill 移到腳本本身（IR-027「邏輯才有效」）。
# 之前依賴 AI 讀完 OK:done:* 後手動呼叫 /api/broadcast/dismiss，
# 漏做時 broadcast 一直不會 dismiss → user 每個 session 都重看升級提醒。
VERSION=$(node -p "require('${OWNMIND_DIR}/package.json').version" 2>/dev/null || echo "unknown")

if [ -n "${API_KEY}" ] && [ -n "${API_URL}" ] && [ "${VERSION}" != "unknown" ]; then
  STEP "dismiss" "Dismiss 已過時的升級廣播"
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
  OK "dismiss" "升級廣播已 dismiss（${COUNT} 則）"
fi

# v1.17.70：升級成功末段 sweep ~/.ownmind.bak.<ts>/ 超過 N 天的（IR-027 邏輯卡控）。
# 預設 7 天，可用 OWNMIND_BACKUP_RETENTION_DAYS 環境變數覆蓋。
# 防呆：sweep 失敗（權限 / 磁碟）也不影響升級結果。
# 設計選擇：單次 sweep、不預先 wc 計數（避免 count vs delete race + 處理檔名特殊字元的 wc 噪音）。
RETENTION_DAYS="${OWNMIND_BACKUP_RETENTION_DAYS:-7}"
STEP "sweep" "清除超過 ${RETENTION_DAYS} 天的舊備份（如有）"
find "${HOME}" -maxdepth 1 -type d -name '.ownmind.bak.*' -mtime +"${RETENTION_DAYS}" -exec rm -rf {} + 2>/dev/null || true
OK "sweep" "舊備份 sweep 完成"

OK "done" "升級完成 → 版本：${VERSION}。備份保留於 ${BACKUP_DIR}（${RETENTION_DAYS} 天後下次升級自動清）"

# v1.17.63: 升級完跑 self-check，把當下本機狀態抓下來、寫 log + 上傳。失敗不擋升級訊息。
SELF_CHECK_SCRIPT="${OWNMIND_DIR}/scripts/install-helpers/self-check.cjs"
if [ -f "${SELF_CHECK_SCRIPT}" ]; then
  node "${SELF_CHECK_SCRIPT}" --trigger=post_upgrade || true
fi

exit 0
