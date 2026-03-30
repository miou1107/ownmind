#!/bin/bash
# OwnMind SessionStart Hook
# 每個新 session 自動檢查更新 + 載入使用者記憶，注入到 AI context

OWNMIND_DIR="$HOME/.ownmind"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
MARKER_FILE="$OWNMIND_DIR/.last-update-check"
LOCK_FILE="$OWNMIND_DIR/.update-lock"
LOG_DIR="$OWNMIND_DIR/logs"
UPDATE_MSG=""

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
    (
      touch "$LOCK_FILE"
      cd "$OWNMIND_DIR" || { rm -f "$LOCK_FILE"; exit 0; }
      git fetch -q 2>/dev/null
      UPDATES=$(git log HEAD..origin/main --oneline 2>/dev/null)
      if [ -n "$UPDATES" ]; then
        git stash -q 2>/dev/null
        git pull -q --rebase 2>/dev/null || git pull -q 2>/dev/null
        cd "$OWNMIND_DIR/mcp" && npm install -q 2>/dev/null
        bash "$OWNMIND_DIR/scripts/update.sh" >/dev/null 2>&1
        log_event "update_applied"
      fi
      echo "$TODAY" > "$MARKER_FILE"
      rm -f "$LOCK_FILE"
    ) &
  fi
fi

# --- 呼叫 OwnMind init API（compact mode）---
INIT_DATA=$(curl -sf --max-time 5 \
  -H "Authorization: Bearer $API_KEY" \
  "${API_URL}/api/memory/init?compact=true" 2>/dev/null)

if [ -z "$INIT_DATA" ]; then
  log_event "init_fail" "status" "api_timeout"
  exit 0
fi

log_event "init" "status" "ok"

# --- 解析記憶 + 輸出 JSON（單次 node 呼叫）---
node -e "
  const data = JSON.parse(process.argv[1]);
  const lines = [];

  lines.push('【OwnMind v' + (data.server_version || '?') + '】記憶已自動載入');
  lines.push('');

  if (data.profile) {
    lines.push('## Profile');
    const p = data.profile;
    lines.push('- ' + (p.title || '') + ': ' + (p.content || '').substring(0, 200));
    lines.push('');
  }

  if (data.iron_rules_digest) {
    lines.push('## 鐵律（必須嚴格遵守）');
    lines.push(data.iron_rules_digest);
    lines.push('');
  }

  if (data.principles && data.principles.length > 0) {
    lines.push('## 工作原則');
    data.principles.forEach(p => lines.push('- ' + p.title));
    lines.push('');
  }

  if (data.active_handoff) {
    lines.push('## 待接手交接');
    lines.push('專案: ' + (data.active_handoff.project || '?'));
    lines.push('');
  }

  lines.push('ownmind_* MCP tools 可操作記憶。鐵律完整內容：ownmind_get(\"iron_rule\")。');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n')
    }
  }));
" "$INIT_DATA" 2>/dev/null

exit 0
