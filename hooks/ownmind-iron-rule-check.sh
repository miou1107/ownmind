#!/bin/bash
# OwnMind Iron Rule Check — Claude Code PreToolUse Hook
# 在執行 git/deploy/delete 等高風險指令前，自動提示相關鐵律
# 附帶：一次性自動升級檢查（搭便車機制）

LOG_DIR="$HOME/.ownmind/logs"
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
  echo "$entry" >> "$LOG_DIR/$date_str.jsonl"
  # Server upload (background)
  if [ -n "$API_KEY" ] && [ -n "$API_URL" ]; then
    curl -sf --max-time 3 -X POST \
      -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
      -d "{\"events\":[$entry]}" \
      "${API_URL}/api/activity/batch" >/dev/null 2>&1 &
  fi
}

# --- 一次性升級：偵測到缺少 SessionStart hook → 自動安裝 ---
UPGRADE_MARKER="$HOME/.ownmind/.session-hook-installed"
if [ ! -f "$UPGRADE_MARKER" ] && [ -d "$HOME/.ownmind/.git" ]; then
  # 檢查 settings.json 是否已有 SessionStart hook
  HAS_SESSION_HOOK=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$HOME/.claude/settings.json', 'utf8'));
      const has = (s.hooks?.SessionStart || []).some(h =>
        h.hooks?.some(hh => (hh.command || '').includes('ownmind'))
      );
      console.log(has ? 'yes' : 'no');
    } catch { console.log('no'); }
  " 2>/dev/null)

  if [ "$HAS_SESSION_HOOK" = "no" ]; then
    # 自動升級：pull + update
    (
      cd "$HOME/.ownmind" && \
      git pull -q --rebase 2>/dev/null && \
      cd mcp && npm install -q 2>/dev/null && \
      bash "$HOME/.ownmind/scripts/update.sh" >/dev/null 2>&1
    )
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"【OwnMind 自動升級】已安裝 SessionStart hook，下次開新 session 記憶會自動載入，不用再手動說「載入 OwnMind」。"}}'
  fi

  # 標記已檢查，不再重複
  touch "$UPGRADE_MARKER"
fi

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | node -e "
  const d = require('fs').readFileSync('/dev/stdin','utf8');
  try { console.log(JSON.parse(d).command || ''); } catch { console.log(''); }
" 2>/dev/null)

if [ -z "$COMMAND" ]; then exit 0; fi

# 偵測觸發關鍵字
TRIGGER=""
if echo "$COMMAND" | grep -qiE "git (commit|reset|rebase|merge)"; then
  TRIGGER="commit"
elif echo "$COMMAND" | grep -qiE "git push"; then
  TRIGGER="deploy"
elif echo "$COMMAND" | grep -qiE "(rm -rf|rmdir|del |drop table|DELETE FROM)"; then
  TRIGGER="delete"
elif echo "$COMMAND" | grep -qiE "(docker.*deploy|docker.*up|kubectl apply|npm run deploy)"; then
  TRIGGER="deploy"
fi

if [ -z "$TRIGGER" ]; then exit 0; fi

# 從 Claude Code settings.json 取得 API key
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
API_URL=""
API_KEY=""

if [ -f "$CLAUDE_SETTINGS" ]; then
  API_KEY=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$CLAUDE_SETTINGS', 'utf8'));
      console.log(s.mcpServers?.ownmind?.env?.OWNMIND_API_KEY || '');
    } catch { console.log(''); }
  " 2>/dev/null)
  API_URL=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$CLAUDE_SETTINGS', 'utf8'));
      console.log(s.mcpServers?.ownmind?.env?.OWNMIND_API_URL || 'https://kkvin.com/ownmind');
    } catch { console.log('https://kkvin.com/ownmind'); }
  " 2>/dev/null)
fi

if [ -z "$API_KEY" ] || [ -z "$API_URL" ]; then exit 0; fi

# 從 OwnMind 取得相關鐵律
RULES=$(curl -sf --max-time 3 -H "Authorization: Bearer $API_KEY" \
  "${API_URL}/api/memory/type/iron_rule" 2>/dev/null | \
  node -e "
    const d = require('fs').readFileSync('/dev/stdin','utf8');
    const trigger = '$TRIGGER';
    try {
      const rules = JSON.parse(d);
      const relevant = rules.filter(r => {
        if (!r.tags || r.tags.length === 0) return true;
        return r.tags.some(t =>
          t === 'trigger:' + trigger ||
          (trigger === 'commit' && t === 'trigger:git')
        );
      });
      if (relevant.length === 0) process.exit(0);
      console.log('【OwnMind 鐵律提醒】即將執行 ' + trigger + ' 操作，請確認以下鐵律：');
      relevant.forEach(r => console.log('  ⚠️  ' + (r.code || 'IR-?') + ': ' + r.title));
    } catch { process.exit(0); }
  " 2>/dev/null)

# --- IR-008 智慧檢查：程式碼有改但文件沒同步 ---
IR008_WARNING=""
if [ "$TRIGGER" = "commit" ]; then
  STAGED=$(git diff --cached --name-only 2>/dev/null)
  HAS_CODE=$(echo "$STAGED" | grep -E '^(src/|mcp/|hooks/|install\.|skills/|configs/)' | head -1)
  if [ -n "$HAS_CODE" ]; then
    MISSING=""
    echo "$STAGED" | grep -q '^README\.md$'    || MISSING="${MISSING}\n  ❌ README.md 未修改"
    echo "$STAGED" | grep -q '^FILELIST\.md$'   || MISSING="${MISSING}\n  ❌ FILELIST.md 未修改"
    echo "$STAGED" | grep -q '^CHANGELOG\.md$'  || MISSING="${MISSING}\n  ❌ CHANGELOG.md 未修改"
    if [ -n "$MISSING" ]; then
      IR008_WARNING="\n【OwnMind IR-008 檢查】偵測到程式碼變更但以下文件未同步：${MISSING}\n請先更新這些文件再 commit。"
    fi
  fi
fi

if [ -n "$RULES" ] || [ -n "$IR008_WARNING" ]; then
  log_event "iron_rule_trigger" "trigger" "$TRIGGER"
  [ -n "$RULES" ] && echo "$RULES"
  [ -n "$IR008_WARNING" ] && echo -e "$IR008_WARNING"
fi

exit 0
