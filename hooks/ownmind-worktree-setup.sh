#!/bin/bash
# OwnMind Worktree Setup Hook
# 當 Claude Code 建立新 worktree 時自動執行
# 在 worktree 注入 .mcp.json，確保 ownmind_* MCP tools 可用

# 讀取 hook input JSON（WorktreeCreate 事件由 stdin 傳入）
INPUT=$(cat 2>/dev/null)

# 嘗試從 hook input 取得 worktree 路徑
WORKTREE_PATH=$(echo "$INPUT" | node -e "
  try {
    const chunks = [];
    process.stdin.on('data', d => chunks.push(d));
    process.stdin.on('end', () => {
      const d = JSON.parse(chunks.join(''));
      const p = d.worktree_path
        || d.path
        || d.tool_input?.path
        || d.tool_input?.worktree_path
        || d.cwd
        || '';
      process.stdout.write(p);
    });
  } catch { process.stdout.write(''); }
" 2>/dev/null)

# fallback: 若 hook input 沒有路徑，嘗試用環境變數或 cwd
if [ -z "$WORKTREE_PATH" ]; then
  WORKTREE_PATH="${CLAUDE_WORKTREE_PATH:-}"
fi

if [ -z "$WORKTREE_PATH" ] || [ ! -d "$WORKTREE_PATH" ]; then
  exit 0
fi

# 讀取全域 MCP 設定（從 ~/.claude/settings.json 取 ownmind server config）
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
if [ ! -f "$CLAUDE_SETTINGS" ]; then
  exit 0
fi

HAS_OWNMIND=$(node -e "
  try {
    const s = JSON.parse(require('fs').readFileSync('$CLAUDE_SETTINGS', 'utf8'));
    process.stdout.write(s.mcpServers?.ownmind ? 'yes' : 'no');
  } catch { process.stdout.write('no'); }
" 2>/dev/null)

if [ "$HAS_OWNMIND" != "yes" ]; then
  exit 0
fi

# --- 注入 .mcp.json ---
MCP_FILE="$WORKTREE_PATH/.mcp.json"
if [ ! -f "$MCP_FILE" ]; then
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$CLAUDE_SETTINGS', 'utf8'));
    const srv = s.mcpServers.ownmind;
    const out = { mcpServers: { ownmind: srv } };
    fs.writeFileSync('$MCP_FILE', JSON.stringify(out, null, 2));
  " 2>/dev/null
fi

# --- 注入 .claude/settings.local.json（enableAllProjectMcpServers）---
WORKTREE_CLAUDE_DIR="$WORKTREE_PATH/.claude"
WORKTREE_SETTINGS="$WORKTREE_CLAUDE_DIR/settings.local.json"
mkdir -p "$WORKTREE_CLAUDE_DIR"

if [ ! -f "$WORKTREE_SETTINGS" ]; then
  echo '{"enableAllProjectMcpServers":true}' > "$WORKTREE_SETTINGS"
elif ! grep -q '"enableAllProjectMcpServers"' "$WORKTREE_SETTINGS" 2>/dev/null; then
  node -e "
    const fs = require('fs');
    const path = '$WORKTREE_SETTINGS';
    let s = {};
    try { s = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
    s.enableAllProjectMcpServers = true;
    const tmp = path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, path);
  " 2>/dev/null
fi

exit 0
