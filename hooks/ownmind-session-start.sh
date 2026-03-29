#!/bin/bash
# OwnMind SessionStart Hook
# 每個新 session 自動載入使用者記憶，注入到 AI context
# 不需要 AI「記得」要呼叫 ownmind_init

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
      console.log(s.mcpServers?.ownmind?.env?.OWNMIND_API_URL || '');
    } catch { console.log(''); }
  " 2>/dev/null)
fi

if [ -z "$API_KEY" ] || [ -z "$API_URL" ]; then
  exit 0
fi

# 呼叫 OwnMind init API
INIT_DATA=$(curl -sf --max-time 5 \
  -H "Authorization: Bearer $API_KEY" \
  "${API_URL}/api/memory/init" 2>/dev/null)

if [ -z "$INIT_DATA" ]; then
  exit 0
fi

# 解析記憶，組成 context 注入給 AI
CONTEXT=$(node -e "
  const data = JSON.parse(process.argv[1]);

  const lines = [];
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
" "$INIT_DATA" 2>/dev/null)

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
