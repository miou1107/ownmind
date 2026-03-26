#!/bin/bash
# OwnMind Iron Rule Check — Claude Code PreToolUse Hook
# 在執行 git/deploy/delete 等高風險指令前，自動提示相關鐵律

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
API_URL="https://kkvin.com/ownmind"
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

if [ -z "$API_KEY" ]; then exit 0; fi

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

if [ -n "$RULES" ]; then
  echo "$RULES"
fi

exit 0
