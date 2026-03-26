#!/bin/bash
# OwnMind 一鍵安裝腳本
# 用法: curl -sL https://raw.githubusercontent.com/miou1107/ownmind/main/install.sh | bash -s -- YOUR_API_KEY

set -e

API_KEY="${1:-}"

if [ -z "$API_KEY" ]; then
  echo "❌ 請提供 API Key"
  echo "用法: bash install.sh YOUR_API_KEY"
  exit 1
fi

echo "🧠 OwnMind 安裝中..."

# --- 1. Clone MCP Server ---
OWNMIND_DIR="$HOME/.ownmind"
if [ -d "$OWNMIND_DIR" ]; then
  echo "   更新 OwnMind MCP Server..."
  cd "$OWNMIND_DIR" && git pull -q
else
  echo "   下載 OwnMind MCP Server..."
  git clone -q https://github.com/miou1107/ownmind.git "$OWNMIND_DIR"
fi

echo "   安裝依賴..."
cd "$OWNMIND_DIR/mcp" && npm install -q 2>/dev/null

# --- 2. Claude Code MCP 設定 ---
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
if [ -f "$CLAUDE_SETTINGS" ]; then
  # 檢查是否已有 ownmind 設定
  if grep -q '"ownmind"' "$CLAUDE_SETTINGS" 2>/dev/null; then
    echo "   Claude Code MCP 已設定，跳過"
  else
    echo "   設定 Claude Code MCP..."
    # 用 node 來安全地修改 JSON
    node -e "
      const fs = require('fs');
      const settings = JSON.parse(fs.readFileSync('$CLAUDE_SETTINGS', 'utf8'));
      if (!settings.mcpServers) settings.mcpServers = {};
      settings.mcpServers.ownmind = {
        command: 'node',
        args: ['$OWNMIND_DIR/mcp/index.js'],
        env: {
          OWNMIND_API_URL: 'https://kkvin.com/ownmind',
          OWNMIND_API_KEY: '$API_KEY'
        }
      };
      fs.writeFileSync('$CLAUDE_SETTINGS', JSON.stringify(settings, null, 2));
    "
  fi
else
  echo "   建立 Claude Code MCP 設定..."
  mkdir -p "$HOME/.claude"
  cat > "$CLAUDE_SETTINGS" << SETTINGS_EOF
{
  "mcpServers": {
    "ownmind": {
      "command": "node",
      "args": ["$OWNMIND_DIR/mcp/index.js"],
      "env": {
        "OWNMIND_API_URL": "https://kkvin.com/ownmind",
        "OWNMIND_API_KEY": "$API_KEY"
      }
    }
  }
}
SETTINGS_EOF
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
- 存取記憶時必須顯示 🧠 提示（詳見 ownmind-memory skill）
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
- 存取記憶時必須顯示 🧠 提示（詳見 ownmind-memory skill）
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
        const settings = JSON.parse(fs.readFileSync('$CURSOR_MCP', 'utf8'));
        if (!settings.mcpServers) settings.mcpServers = {};
        settings.mcpServers.ownmind = {
          command: 'node',
          args: ['$OWNMIND_DIR/mcp/index.js'],
          env: {
            OWNMIND_API_URL: 'https://kkvin.com/ownmind',
            OWNMIND_API_KEY: '$API_KEY'
          }
        };
        fs.writeFileSync('$CURSOR_MCP', JSON.stringify(settings, null, 2));
      "
    else
      mkdir -p "$HOME/.cursor"
      cat > "$CURSOR_MCP" << CURSOR_EOF
{
  "mcpServers": {
    "ownmind": {
      "command": "node",
      "args": ["$OWNMIND_DIR/mcp/index.js"],
      "env": {
        "OWNMIND_API_URL": "https://kkvin.com/ownmind",
        "OWNMIND_API_KEY": "$API_KEY"
      }
    }
  }
}
CURSOR_EOF
    fi
  fi
fi

echo ""
echo "✅ OwnMind 安裝完成！"
echo ""
echo "   MCP Server: $OWNMIND_DIR/mcp/index.js"
echo "   API URL:    https://kkvin.com/ownmind"
echo "   API Key:    $API_KEY"
echo ""
echo "   現在開一個新的 Claude Code 對話，說「載入我的 OwnMind」即可開始！"
echo ""
