#!/bin/bash
# OwnMind SessionStart Hook
# 每個新 session 自動檢查更新 + 載入使用者記憶，注入到 AI context

OWNMIND_DIR="$HOME/.ownmind"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
MARKER_FILE="$OWNMIND_DIR/.last-update-check"
LOCK_FILE="$OWNMIND_DIR/.update-lock"
LOG_DIR="$OWNMIND_DIR/logs"
UPDATE_MSG=""

# v1.26.7 — normalize paths for Node.exe on Windows + Git Bash.
# Without this, $OWNMIND_DIR=/c/Users/Vin/.ownmind makes require() fail with
# MODULE_NOT_FOUND. See path-helpers.sh.
if [ -f "$OWNMIND_DIR/scripts/install-helpers/path-helpers.sh" ]; then
  # shellcheck disable=SC1091
  . "$OWNMIND_DIR/scripts/install-helpers/path-helpers.sh"
else
  to_win_path() { echo "$1"; }
fi
OWNMIND_DIR_WIN="$(to_win_path "$OWNMIND_DIR")"

# v1.17.71：補印上次 session 因 tty 不可用沒寫成的 banner（規格 #3 不被 AI 過濾）。
# SessionStart 的 stderr → user terminal，是 user-visible 通道。
# JSON Lines format：每行一個 { "ts", "block" } record。
# 單次 spawn node 串流讀整個檔（不在 bash while loop 裡 per-line spawn）—
# 50+ banner 積壓時 per-line spawn 會卡住數秒。
PENDING_BANNER_FILE="$LOG_DIR/banner-pending.jsonl"
SCRIPT_DIR_FOR_FLUSH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -s "$PENDING_BANNER_FILE" ]; then
  echo "" >&2
  echo "📥 OwnMind 上次 session 累積的訊息（tty 寫不到、補印）：" >&2
  node "$SCRIPT_DIR_FOR_FLUSH/lib/flush-pending-banners.js" < "$PENDING_BANNER_FILE" 2>&1 1>/dev/null
  # 註：concurrency — 兩個 session 同時跑時，append 是 atomic（O_APPEND），但
  # 介於 read 跟下面 truncate 之間進來的 banner 會被丟掉。v1.17.71 接受這個
  # microsecond race；之後若有人發現掉訊息再考慮 lockfile。
  : > "$PENDING_BANNER_FILE"  # 清空
fi

# v1.17.97：補送 reply-lint Stop hook 上次 POST 失敗 / 離線時 spool 的合規事件。
# helper 自己處理：沒檔/沒 credentials/POST 失敗 → 留檔等下次；POST 200 → 刪檔。
# 嚴禁外漏 stderr/stdout（user-visible 通道）— helper 內部已做防護、這邊也丟到 /dev/null 雙保險。
COMPLIANCE_SPOOL_FILE="$LOG_DIR/reply-lint-pending.jsonl"
if [ -s "$COMPLIANCE_SPOOL_FILE" ]; then
  node "$SCRIPT_DIR_FOR_FLUSH/lib/flush-compliance-spool.js" >/dev/null 2>&1 || true
fi

# --- Log function (local + server) ---
log_event() {
  local event="$1"; shift
  mkdir -p "$LOG_DIR"
  local ts=$(date +%Y-%m-%dT%H:%M:%S%z | sed 's/\([0-9][0-9]\)$/:\1/')
  local date_str=$(date +%Y-%m-%d)
  local extra=""
  while [ $# -gt 0 ]; do
    local val=$(echo "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')
    extra="$extra,\"$1\":\"$val\""
    shift 2
  done
  local entry="{\"ts\":\"$ts\",\"event\":\"$event\",\"tool\":\"claude-code\",\"source\":\"hook\"$extra}"
  # Local log
  echo "$entry" >> "$LOG_DIR/$date_str.jsonl"
  # Server upload (background, non-blocking)
  if [ -n "$API_KEY" ] && [ -n "$API_URL" ]; then
    curl -sf --max-time 3 -X POST \
      -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
      -d "{\"events\":[$entry]}" \
      "${API_URL}/api/activity/batch" >/dev/null 2>&1 &
  fi
}

# --- 讀取設定（一次 node 呼叫取 KEY + URL）---
if [ -f "$CLAUDE_SETTINGS" ]; then
  CREDS=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$CLAUDE_SETTINGS', 'utf8'));
      const o = s.mcpServers?.ownmind?.env || {};
      console.log((o.OWNMIND_API_KEY || '') + '\n' + (o.OWNMIND_API_URL || ''));
    } catch { console.log('\n'); }
  " 2>/dev/null)
  API_KEY=$(echo "$CREDS" | head -1)
  API_URL=$(echo "$CREDS" | tail -1)
fi

if [ -z "$API_KEY" ] || [ -z "$API_URL" ]; then
  exit 0
fi

# --- 自動更新（背景執行，不阻塞 session 啟動）---
# Stale lock: 超過 5 分鐘自動清除
# stat -f %m = macOS, stat -c %Y = Linux, echo 0 = fallback（epoch 0 → age 極大 → 必定清除，fail-open）
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0) ))
  [ "$LOCK_AGE" -gt 300 ] && rm -f "$LOCK_FILE"
fi

if [ -d "$OWNMIND_DIR/.git" ] && [ ! -f "$LOCK_FILE" ]; then
  TODAY=$(date +%Y-%m-%d)
  LAST_CHECK=$(cat "$MARKER_FILE" 2>/dev/null || echo "")

  if [ "$LAST_CHECK" != "$TODAY" ]; then
    log_event "update_check"
    # 背景執行更新，不阻塞記憶載入
    # P3 修正（Bob case 2026-04-26）：原本 silent 吞失敗後無條件寫 update_applied，
    # 即使 git pull / npm / update.sh 任一失敗都會誤報「已更新」。對齊 mcp/index.js
    # 的修法：每步顯式檢查；分流寫 update_applied / update_clean / update_failed。
    (
      touch "$LOCK_FILE" || { log_event "update_failed" "step" "lock"; exit 0; }
      cd "$OWNMIND_DIR" || { rm -f "$LOCK_FILE"; log_event "update_failed" "step" "cd"; exit 0; }
      if ! git fetch -q 2>/dev/null; then
        rm -f "$LOCK_FILE"
        log_event "update_failed" "step" "fetch"
        exit 0
      fi
      UPDATES=$(git log HEAD..origin/main --oneline 2>/dev/null)
      if [ -n "$UPDATES" ]; then
        git stash -q 2>/dev/null
        if ! { git pull -q --rebase 2>/dev/null || git pull -q 2>/dev/null; }; then
          rm -f "$LOCK_FILE"
          log_event "update_failed" "step" "pull"
          exit 0
        fi
        if ! ( cd "$OWNMIND_DIR/mcp" && npm install -q 2>/dev/null ); then
          rm -f "$LOCK_FILE"
          log_event "update_failed" "step" "npm"
          exit 0
        fi
        if ! bash "$OWNMIND_DIR/scripts/update.sh" >/dev/null 2>&1; then
          rm -f "$LOCK_FILE"
          log_event "update_failed" "step" "update_sh"
          exit 0
        fi
        log_event "update_applied"
      else
        log_event "update_clean"
      fi
      echo "$TODAY" > "$MARKER_FILE"
      rm -f "$LOCK_FILE"
    ) &
  fi
fi

# v1.17.86 IR-038：drain .upload-spool.jsonl（v1.17.85 reviewer I1 + IR-007 同類雷收尾）
# 場景：升級成功末段的 upgrade_complete beacon / post_upgrade self-check 上傳失敗時
# 寫進 .upload-spool.jsonl，原本要等下次 self-check.cjs 才 drain。但若 user 升完就
# quit Claude Code，永遠沒下次 self-check 來觸發 → spool 卡在他本機、server 永遠
# 看不到 user 升上去了。
# 改在 SessionStart 也跑 drain — 任何新 Claude Code session 起來都 retry 一次、
# 縮短「user 升完 → server 看到」的延遲到「下次開 Claude Code」即可。
# Fire-and-forget、3 秒 timeout、絕不擋 SessionStart。
SELF_CHECK_SCRIPT="$OWNMIND_DIR/scripts/install-helpers/self-check.cjs"
if [ -f "$SELF_CHECK_SCRIPT" ] && [ -n "$API_KEY" ] && [ -n "$API_URL" ]; then
  timeout 3 node -e "
    const sc = require('$SELF_CHECK_SCRIPT');
    if (sc.retrySpool) {
      sc.retrySpool('$API_URL', '$API_KEY').catch(() => {});
    }
  " >/dev/null 2>&1 &
fi

# --- v1.18.0: Conditional sync — 用 sync_token 跳過 99% sessions 的 download ---
# helper 流程：
#   1. 讀 ~/.ownmind/cache/memories.json (sync_token + saved_at)
#   2. 24hr 過期 → 強制走全量 init
#   3. 否則 GET /sync-token (~50 bytes) 比對
#   4. 相同 → 跳過 init download、用 cache (~95% sessions 走這條)
#   5. 不同 → 全量 init + 寫新 cache + 重寫 ~/.claude/skills/ownmind-iron-rules/
# helper 內建 fallback：fetch 失敗 → 用 cache、cache 也沒 → 印空 string
SCRIPT_DIR_FOR_INIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INIT_DATA=$(timeout 10 node "$SCRIPT_DIR_FOR_INIT/lib/conditional-sync-cli.js" \
  "$API_URL" "$API_KEY" 2>/dev/null)

if [ -z "$INIT_DATA" ]; then
  # conditional-sync 完全失敗（無網 + 無 cache）→ fallback 到 v1.17.x 直接 curl
  INIT_DATA=$(curl -sf --max-time 5 \
    -H "Authorization: Bearer $API_KEY" \
    "${API_URL}/api/memory/init?compact=true" 2>/dev/null)
fi

if [ -z "$INIT_DATA" ]; then
  log_event "init_fail" "status" "api_timeout"
  exit 0
fi

log_event "init" "status" "ok"

# --- v1.17.0 P3: 抓當前應顯示的廣播（fail-silent，不擋 SessionStart）---
# v1.17.18: 帶 client_version 讓 server semver filter 生效
# （否則 broadcast-filter.js 的 min/max_version 過濾會跳過 → 已升級用戶仍見舊升級廣播）
CLIENT_VERSION=$(node -p "require('$OWNMIND_DIR_WIN/package.json').version" 2>/dev/null || echo "")
BROADCAST_URL="${API_URL}/api/broadcast/active?tool=claude-code"
if [ -n "$CLIENT_VERSION" ]; then
  BROADCAST_URL="${BROADCAST_URL}&client_version=${CLIENT_VERSION}"
  BROADCAST_DATA=$(curl -sf --max-time 3 \
    -H "Authorization: Bearer $API_KEY" \
    -H "X-Ownmind-Version: ${CLIENT_VERSION}" \
    "${BROADCAST_URL}" 2>/dev/null)
else
  BROADCAST_DATA=$(curl -sf --max-time 3 \
    -H "Authorization: Bearer $API_KEY" \
    "${BROADCAST_URL}" 2>/dev/null)
fi
# 空值 / 失敗一律當 "[]"（就是沒廣播）
[ -z "$BROADCAST_DATA" ] && BROADCAST_DATA="[]"

# --- 解析記憶 + 廣播 + 輸出 JSON ---
# render 邏輯拆到 hooks/lib/render-session-context.js（可被 unit test）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/lib/session-start-output.js" "$INIT_DATA" "$BROADCAST_DATA" 2>/dev/null

# --- v1.17.8: delta sync 本地記憶 md 檔（A+C 方案，不阻塞，fail-silent）---
# 把雲端 iron_rule/project/feedback 同步到 $CLAUDE_PROJECT_DIR 的 auto-memory dir，
# 避免 AI 讀到過期快照。CLAUDE_PROJECT_DIR 未設時 node script 自己 exit 0。
if [ -n "$CLAUDE_PROJECT_DIR" ]; then
  SYNC_DATA=$(curl -sf --max-time 4 \
    -H "Authorization: Bearer $API_KEY" \
    "${API_URL}/api/memory/sync?types=iron_rule,project,feedback" 2>/dev/null)
  if [ -n "$SYNC_DATA" ]; then
    echo "$SYNC_DATA" | node "$SCRIPT_DIR/lib/sync-memory-files.js" 2>/dev/null
  else
    node "$SCRIPT_DIR/lib/sync-memory-files.js" --fail 2>/dev/null
    log_event "memory_sync_fail"
  fi
fi

exit 0
