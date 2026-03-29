#!/bin/bash
# OwnMind 自動更新腳本
# 在 git pull 後執行，同步 skill、hook、settings 到各工具目錄
# 用法: bash ~/.ownmind/scripts/update.sh

OWNMIND_DIR="$HOME/.ownmind"

echo "🔄 OwnMind 同步更新中..."

# --- 1. 同步 Claude Code skill ---
if [ -d "$HOME/.claude" ]; then
  SKILL_DIR="$HOME/.claude/skills/ownmind-memory"
  mkdir -p "$SKILL_DIR"
  cp "$OWNMIND_DIR/skills/ownmind-memory.md" "$SKILL_DIR/SKILL.md"
  echo "   ✅ skill 已更新"
fi

# --- 2. 同步 hook scripts（所有 hook 一次同步）---
if [ -d "$HOME/.claude" ]; then
  HOOK_DIR="$HOME/.claude/hooks"
  mkdir -p "$HOOK_DIR"
  for hook_file in "$OWNMIND_DIR/hooks/"*.sh; do
    if [ -f "$hook_file" ]; then
      cp "$hook_file" "$HOOK_DIR/"
      chmod +x "$HOOK_DIR/$(basename "$hook_file")"
    fi
  done
  echo "   ✅ hook scripts 已同步"
fi

# --- 3. 確保 Claude Code settings.json 有所有 hook 設定 ---
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
if [ -f "$CLAUDE_SETTINGS" ]; then
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$CLAUDE_SETTINGS', 'utf8'));
    let changed = false;
    if (!s.hooks) { s.hooks = {}; changed = true; }

    // SessionStart hook — 自動載入記憶
    if (!s.hooks.SessionStart) s.hooks.SessionStart = [];
    const sessionExists = s.hooks.SessionStart.some(h =>
      h.hooks?.some(hh => (hh.command || '').includes('ownmind-session-start'))
    );
    if (!sessionExists) {
      s.hooks.SessionStart.push({
        hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-session-start.sh', timeout: 10 }]
      });
      changed = true;
      console.log('   ✅ 加入 SessionStart hook（自動載入記憶）');
    }

    // PreToolUse hook — 鐵律檢查
    if (!s.hooks.PreToolUse) s.hooks.PreToolUse = [];
    const preExists = s.hooks.PreToolUse.some(h =>
      h.hooks?.some(hh => (hh.command || '').includes('ownmind-iron-rule-check'))
    );
    if (!preExists) {
      s.hooks.PreToolUse.push({
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-iron-rule-check.sh' }]
      });
      changed = true;
      console.log('   ✅ 加入 PreToolUse hook（鐵律檢查）');
    }

    if (changed) {
      fs.writeFileSync('$CLAUDE_SETTINGS', JSON.stringify(s, null, 2));
    }
  " 2>/dev/null
fi

# --- 4. Gemini CLI hooks ---
if [ -d "$HOME/.gemini" ]; then
  GEMINI_SETTINGS="$HOME/.gemini/settings.json"
  node -e "
    const fs = require('fs');
    const path = '$GEMINI_SETTINGS';
    let s = {};
    if (fs.existsSync(path)) {
      try { s = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
    }
    if (!s.hooks) s.hooks = {};
    if (!s.hooks.SessionStart) s.hooks.SessionStart = [];
    const exists = s.hooks.SessionStart.some(h =>
      (h.command || '').includes('ownmind') ||
      (h.hooks && h.hooks.some(hh => (hh.command || '').includes('ownmind')))
    );
    if (!exists) {
      s.hooks.SessionStart.push({
        type: 'command',
        command: 'bash ~/.claude/hooks/ownmind-session-start.sh'
      });
      fs.writeFileSync(path, JSON.stringify(s, null, 2));
      console.log('   ✅ Gemini CLI SessionStart hook 已加入');
    }
  " 2>/dev/null
fi

# --- 5. GitHub Copilot hooks ---
if [ -d "$HOME/.github" ] || command -v gh &>/dev/null; then
  GH_HOOKS_DIR="$HOME/.github/hooks"
  GH_HOOKS_FILE="$GH_HOOKS_DIR/hooks.json"
  mkdir -p "$GH_HOOKS_DIR"
  node -e "
    const fs = require('fs');
    const path = '$GH_HOOKS_FILE';
    let s = { version: 1, hooks: {} };
    if (fs.existsSync(path)) {
      try { s = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
    }
    if (!s.hooks) s.hooks = {};
    if (!s.hooks.sessionStart) s.hooks.sessionStart = [];
    const exists = s.hooks.sessionStart.some(h => (h.command || '').includes('ownmind'));
    if (!exists) {
      s.hooks.sessionStart.push({ command: 'bash ~/.claude/hooks/ownmind-session-start.sh' });
      fs.writeFileSync(path, JSON.stringify(s, null, 2));
      console.log('   ✅ GitHub Copilot sessionStart hook 已加入');
    }
  " 2>/dev/null
fi

# --- 6. Cursor hooks ---
if [ -d "$HOME/.cursor" ]; then
  CURSOR_HOOKS="$HOME/.cursor/hooks.json"
  node -e "
    const fs = require('fs');
    const path = '$CURSOR_HOOKS';
    let s = { version: 1, hooks: {} };
    if (fs.existsSync(path)) {
      try { s = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
    }
    if (!s.hooks) s.hooks = {};
    if (!s.hooks['session-start']) s.hooks['session-start'] = [];
    const exists = s.hooks['session-start'].some(h => (h.command || '').includes('ownmind'));
    if (!exists) {
      s.hooks['session-start'].push({ command: 'bash ~/.claude/hooks/ownmind-session-start.sh' });
      fs.writeFileSync(path, JSON.stringify(s, null, 2));
      console.log('   ✅ Cursor session-start hook 已加入');
    }
  " 2>/dev/null
fi

# --- 標記 SessionStart hook 已安裝（避免 iron-rule-check 重複升級）---
touch "$HOME/.ownmind/.session-hook-installed"

echo "✅ OwnMind 同步完成"
