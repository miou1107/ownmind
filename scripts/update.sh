#!/bin/bash
# OwnMind 自動更新腳本
# 在 git pull 後執行，同步 skill、hook 到各工具目錄
# 用法: bash ~/.ownmind/scripts/update.sh

OWNMIND_DIR="$HOME/.ownmind"

echo "🔄 OwnMind 同步更新中..."

# --- 1. 同步 Claude Code skill ---
SKILL_DIR="$HOME/.claude/skills/ownmind-memory"
if [ -d "$HOME/.claude" ]; then
  mkdir -p "$SKILL_DIR"
  cp "$OWNMIND_DIR/skills/ownmind-memory.md" "$SKILL_DIR/SKILL.md"
  echo "   ✅ skill 已更新"
fi

# --- 2. 同步 Claude Code hook script ---
HOOK_DIR="$HOME/.claude/hooks"
if [ -d "$HOME/.claude" ]; then
  mkdir -p "$HOOK_DIR"
  cp "$OWNMIND_DIR/hooks/ownmind-iron-rule-check.sh" "$HOOK_DIR/"
  chmod +x "$HOOK_DIR/ownmind-iron-rule-check.sh"
  echo "   ✅ hook script 已更新"
fi

# --- 3. 確保 settings.json 有 hook 設定 ---
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
if [ -f "$CLAUDE_SETTINGS" ]; then
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$CLAUDE_SETTINGS', 'utf8'));
    if (!s.hooks) s.hooks = {};
    if (!s.hooks.PreToolUse) s.hooks.PreToolUse = [];
    const exists = s.hooks.PreToolUse.some(h =>
      h.hooks?.some(hh => hh.command?.includes('ownmind-iron-rule-check'))
    );
    if (!exists) {
      s.hooks.PreToolUse.push({
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-iron-rule-check.sh' }]
      });
      fs.writeFileSync('$CLAUDE_SETTINGS', JSON.stringify(s, null, 2));
      console.log('   ✅ hook 設定已加入 settings.json');
    }
  " 2>/dev/null
fi

echo "✅ OwnMind 同步完成"
