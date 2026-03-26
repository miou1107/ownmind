#!/bin/bash
# OwnMind 一鍵安裝腳本
# 用法: curl -sL https://raw.githubusercontent.com/miou1107/ownmind/main/install.sh | bash -s -- YOUR_API_KEY YOUR_API_URL

set -e

API_KEY="${1:-}"
API_URL="${2:-}"

if [ -z "$API_KEY" ]; then
  echo "❌ 請提供 API Key 和 API URL"
  echo "用法: bash install.sh YOUR_API_KEY YOUR_API_URL"
  echo "範例: bash install.sh abc123 https://your-server.com/ownmind"
  exit 1
fi

if [ -z "$API_URL" ]; then
  echo "❌ 請提供 API URL"
  echo "用法: bash install.sh YOUR_API_KEY YOUR_API_URL"
  echo "範例: bash install.sh abc123 https://your-server.com/ownmind"
  exit 1
fi

echo "🧠 OwnMind 安裝中..."

# --- 偵測作業系統 ---
IS_WINDOWS=false
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
  IS_WINDOWS=true
  echo "   偵測到 Windows 環境（Git Bash）"
fi

# --- 1. Clone MCP Server ---
OWNMIND_DIR="$HOME/.ownmind"
if [ -d "$OWNMIND_DIR" ]; then
  echo "   更新 OwnMind MCP Server..."
  git -C "$OWNMIND_DIR" pull -q
else
  echo "   下載 OwnMind MCP Server..."
  git clone -q https://github.com/miou1107/ownmind.git "$OWNMIND_DIR"
fi

echo "   安裝依賴..."
cd "$OWNMIND_DIR/mcp" && npm install -q 2>/dev/null

# --- 決定 MCP command / args ---
if [ "$IS_WINDOWS" = true ]; then
  # Windows: 用 cmd.exe 透過 start.cmd 啟動，避免 Claude Code 找不到 node
  OWNMIND_DIR_WIN=$(cygpath -w "$OWNMIND_DIR" 2>/dev/null || echo "$OWNMIND_DIR")
  START_CMD_WIN="${OWNMIND_DIR_WIN}\\mcp\\start.cmd"
  MCP_ENTRY=$(node -e "
    const p = '$START_CMD_WIN'.replace(/\\\\/g, '\\\\\\\\');
    console.log(JSON.stringify({ command: 'cmd.exe', args: ['/c', p] }));
  ")
else
  MCP_ENTRY=$(node -e "
    const p = '$OWNMIND_DIR/mcp/index.js';
    console.log(JSON.stringify({ command: 'node', args: [p] }));
  ")
fi

# --- 2. Claude Code MCP 設定 ---
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
if [ -f "$CLAUDE_SETTINGS" ]; then
  if grep -q '"ownmind"' "$CLAUDE_SETTINGS" 2>/dev/null; then
    echo "   Claude Code MCP 已設定，跳過"
  else
    echo "   設定 Claude Code MCP..."
    node -e "
      const fs = require('fs');
      const entry = $MCP_ENTRY;
      const settings = JSON.parse(fs.readFileSync('$CLAUDE_SETTINGS', 'utf8'));
      if (!settings.mcpServers) settings.mcpServers = {};
      settings.mcpServers.ownmind = {
        ...entry,
        env: {
          OWNMIND_API_URL: '$API_URL',
          OWNMIND_API_KEY: '$API_KEY'
        }
      };
      fs.writeFileSync('$CLAUDE_SETTINGS', JSON.stringify(settings, null, 2));
    "
  fi
else
  echo "   建立 Claude Code MCP 設定..."
  mkdir -p "$HOME/.claude"
  node -e "
    const fs = require('fs');
    const entry = $MCP_ENTRY;
    const settings = {
      mcpServers: {
        ownmind: {
          ...entry,
          env: {
            OWNMIND_API_URL: '$API_URL',
            OWNMIND_API_KEY: '$API_KEY'
          }
        }
      }
    };
    fs.writeFileSync('$CLAUDE_SETTINGS', JSON.stringify(settings, null, 2));
  "
fi

# --- 3. CLAUDE.md 加入 OwnMind 引用 ---
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  if grep -q "OwnMind" "$CLAUDE_MD" 2>/dev/null; then
    echo "   CLAUDE.md 已包含 OwnMind，跳過"
  else
    echo "   更新 CLAUDE.md..."
    cat >> "$CLAUDE_MD" << 'CLAUDE_EOF'

# OwnMind 個人記憶系統

你已連接 OwnMind 跨平台 AI 個人記憶系統。

## 必須遵守
- 開始工作時，呼叫 ownmind_init 載入使用者記憶
- 個人偏好、鐵律、專案 context 以 OwnMind 為主要來源（跨平台共享）
- 本地 memory 可並存，但發生衝突時以 OwnMind 為準
- 存取記憶時必須顯示【OwnMind】提示（詳見 ownmind-memory skill）
- 完成重要工作後，主動儲存記憶
- 交接工作時，使用 OwnMind 交接機制

## 觸發詞
- 「記起來」「學起來」「新增鐵律」→ 儲存記憶
- 「交接給 XXX」→ 建立交接
- 「整理記憶」「我有哪些記憶」→ 查詢記憶
CLAUDE_EOF
  fi
else
  echo "   建立 CLAUDE.md..."
  mkdir -p "$HOME/.claude"
  cat > "$CLAUDE_MD" << 'CLAUDE_EOF'
# OwnMind 個人記憶系統

你已連接 OwnMind 跨平台 AI 個人記憶系統。

## 必須遵守
- 開始工作時，呼叫 ownmind_init 載入使用者記憶
- 個人偏好、鐵律、專案 context 以 OwnMind 為主要來源（跨平台共享）
- 本地 memory 可並存，但發生衝突時以 OwnMind 為準
- 存取記憶時必須顯示【OwnMind】提示（詳見 ownmind-memory skill）
- 完成重要工作後，主動儲存記憶
- 交接工作時，使用 OwnMind 交接機制

## 觸發詞
- 「記起來」「學起來」「新增鐵律」→ 儲存記憶
- 「交接給 XXX」→ 建立交接
- 「整理記憶」「我有哪些記憶」→ 查詢記憶
CLAUDE_EOF
fi

# --- 4. 安裝 Skill ---
SKILL_DIR="$HOME/.claude/skills/ownmind-memory"
mkdir -p "$SKILL_DIR"
cp "$OWNMIND_DIR/skills/ownmind-memory.md" "$SKILL_DIR/SKILL.md"
echo "   安裝 ownmind-memory skill"

# --- 4b. 安裝 Hook Script ---
HOOK_DIR="$HOME/.claude/hooks"
mkdir -p "$HOOK_DIR"
cp "$OWNMIND_DIR/hooks/ownmind-iron-rule-check.sh" "$HOOK_DIR/"
chmod +x "$HOOK_DIR/ownmind-iron-rule-check.sh"
echo "   安裝 ownmind-iron-rule-check hook"

# --- 4c. 加入 PreToolUse hook 設定 ---
node -e "
  const fs = require('fs');
  const path = '$CLAUDE_SETTINGS';
  const s = JSON.parse(fs.readFileSync(path, 'utf8'));
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
    fs.writeFileSync(path, JSON.stringify(s, null, 2));
    console.log('   加入 PreToolUse hook 設定');
  }
" 2>/dev/null

# --- 5. Cursor 設定（如果有 .cursor 目錄）---
if [ -d "$HOME/.cursor" ] || command -v cursor &>/dev/null; then
  CURSOR_MCP="$HOME/.cursor/mcp.json"
  if [ -f "$CURSOR_MCP" ] && grep -q '"ownmind"' "$CURSOR_MCP" 2>/dev/null; then
    echo "   Cursor MCP 已設定，跳過"
  else
    echo "   設定 Cursor MCP..."
    if [ -f "$CURSOR_MCP" ]; then
      node -e "
        const fs = require('fs');
        const entry = $MCP_ENTRY;
        const settings = JSON.parse(fs.readFileSync('$CURSOR_MCP', 'utf8'));
        if (!settings.mcpServers) settings.mcpServers = {};
        settings.mcpServers.ownmind = {
          ...entry,
          env: {
            OWNMIND_API_URL: '$API_URL',
            OWNMIND_API_KEY: '$API_KEY'
          }
        };
        fs.writeFileSync('$CURSOR_MCP', JSON.stringify(settings, null, 2));
      "
    else
      mkdir -p "$HOME/.cursor"
      node -e "
        const fs = require('fs');
        const entry = $MCP_ENTRY;
        const settings = {
          mcpServers: {
            ownmind: {
              ...entry,
              env: {
                OWNMIND_API_URL: '$API_URL',
                OWNMIND_API_KEY: '$API_KEY'
              }
            }
          }
        };
        fs.writeFileSync('$HOME/.cursor/mcp.json', JSON.stringify(settings, null, 2));
      "
    fi
  fi
fi

echo ""
echo "✅ OwnMind 安裝完成！"
echo ""
echo "   MCP Server: $OWNMIND_DIR/mcp/index.js"
echo "   API URL:    $API_URL"
echo "   API Key:    $API_KEY"
if [ "$IS_WINDOWS" = true ]; then
echo "   Windows:    使用 cmd.exe + start.cmd 啟動 MCP"
fi
echo ""
echo "   現在開一個新的 Claude Code 對話，說「載入我的 OwnMind」即可開始！"
echo ""
