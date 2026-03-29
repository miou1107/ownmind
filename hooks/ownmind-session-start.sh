#!/bin/bash
# OwnMind SessionStart Hook
# 每個新 session 自動檢查更新 + 載入使用者記憶，注入到 AI context
# 不需要 AI「記得」要呼叫 ownmind_init

OWNMIND_DIR="$HOME/.ownmind"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
MARKER_FILE="$OWNMIND_DIR/.last-update-check"
API_URL=""
API_KEY=""
UPDATE_MSG=""

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
      console.log(s.mcpServers?.ownmind?.env?.OWNMIND_API_URL || '');
    } catch { console.log(''); }
  " 2>/dev/null)
fi

if [ -z "$API_KEY" ] || [ -z "$API_URL" ]; then
  exit 0
fi

# --- 自動更新檢查（每天最多一次，有 lock 機制防止跟 MCP 同時跑）---
LOCK_FILE="$OWNMIND_DIR/.update-lock"

# Stale lock detection: if lock file is older than 5 minutes, remove it
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if [ "$LOCK_AGE" -gt 300 ]; then
    rm -f "$LOCK_FILE"
  fi
fi

if [ -d "$OWNMIND_DIR/.git" ] && [ ! -f "$LOCK_FILE" ]; then
  TODAY=$(date +%Y-%m-%d)
  LAST_CHECK=$(cat "$MARKER_FILE" 2>/dev/null || echo "")

  if [ "$LAST_CHECK" != "$TODAY" ]; then
    touch "$LOCK_FILE"

    cd "$OWNMIND_DIR" || { rm -f "$LOCK_FILE"; exit 0; }

    git fetch -q 2>/dev/null
    UPDATES=$(git log HEAD..origin/main --oneline 2>/dev/null)

    if [ -n "$UPDATES" ]; then
      UPDATE_COUNT=$(echo "$UPDATES" | wc -l | tr -d ' ')
      git stash -q 2>/dev/null
      git pull -q --rebase 2>/dev/null || git pull -q 2>/dev/null
      cd "$OWNMIND_DIR/mcp" && npm install -q 2>/dev/null
      bash "$OWNMIND_DIR/scripts/update.sh" >/dev/null 2>&1
      UPDATE_MSG="【OwnMind 自動更新】已更新 ${UPDATE_COUNT} 個 commit"
    fi

    # Marker written AFTER success to allow retry on failure
    echo "$TODAY" > "$MARKER_FILE"
    rm -f "$LOCK_FILE"
    cd - >/dev/null 2>&1 || true
  fi
fi

# 呼叫 OwnMind init API
INIT_DATA=$(curl -sf --max-time 5 \
  -H "Authorization: Bearer $API_KEY" \
  "${API_URL}/api/memory/init?compact=true" 2>/dev/null)

if [ -z "$INIT_DATA" ]; then
  exit 0
fi

# 解析記憶，組成 context 注入給 AI
CONTEXT=$(node -e "
  const data = JSON.parse(process.argv[1]);

  const lines = [];
  const updateMsg = process.argv[2] || '';
  if (updateMsg) {
    lines.push(updateMsg);
    lines.push('');
  }
  lines.push('【OwnMind v' + (data.server_version || '?') + '】記憶已自動載入（SessionStart hook）');
  lines.push('');

  // Profile
  if (data.profile && data.profile.length > 0) {
    lines.push('## 使用者 Profile');
    data.profile.forEach(p => lines.push('- ' + p.title + ': ' + p.content.substring(0, 200)));
    lines.push('');
  }

  // Iron Rules（最重要）
  if (data.iron_rules && data.iron_rules.length > 0) {
    lines.push('## 鐵律（必須嚴格遵守，不可違反）');
    data.iron_rules.forEach(r => {
      const tags = (r.tags || []).filter(t => t.startsWith('trigger:')).join(', ');
      lines.push('- [' + (r.code || 'IR-?') + '] ' + r.title + (tags ? ' (' + tags + ')' : ''));
    });
    lines.push('');
  }

  // Principles
  if (data.principles && data.principles.length > 0) {
    lines.push('## 工作原則');
    data.principles.forEach(p => lines.push('- ' + p.title));
    lines.push('');
  }

  // Active handoff
  if (data.active_handoff) {
    lines.push('## 待接手交接');
    lines.push('專案: ' + (data.active_handoff.project || '?'));
    lines.push('請先確認交接內容再開始工作。');
    lines.push('');
  }

  // Allowed types (for memory operations)
  if (data.allowed_types) {
    lines.push('## OwnMind 記憶類型');
    lines.push('允許的 type: ' + data.allowed_types.join(', '));
    lines.push('');
  }

  lines.push('提醒：存取 OwnMind 時必須顯示【OwnMind】標記。使用 ownmind_* MCP tools 操作記憶。');

  console.log(lines.join('\n'));
" "$INIT_DATA" "$UPDATE_MSG" 2>/dev/null)

if [ -n "$CONTEXT" ]; then
  # 輸出 JSON，透過 additionalContext 注入到 AI context
  node -e "
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: process.argv[1]
      }
    }));
  " "$CONTEXT"
fi

exit 0
