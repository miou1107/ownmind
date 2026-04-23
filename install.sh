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

# safe_cp — 避免升級情境下 source == dest 時 macOS cp 報「identical」錯
# 用法：safe_cp SRC DEST_DIR_OR_FILE
safe_cp() {
  local src="$1"
  local dest="$2"
  local resolved
  if [ -d "$dest" ]; then
    resolved="$dest/$(basename "$src")"
  else
    resolved="$dest"
  fi
  [ -f "$src" ] || return 1
  if [ "$src" -ef "$resolved" ] 2>/dev/null; then
    return 0
  fi
  cp "$src" "$dest"
}
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
          OWNMIND_API_KEY: '$API_KEY',
          OWNMIND_TOOL: 'claude-code'
        }
      };
      const _tmp = '$CLAUDE_SETTINGS' + '.tmp';
      fs.writeFileSync(_tmp, JSON.stringify(settings, null, 2));
      fs.renameSync(_tmp, '$CLAUDE_SETTINGS');
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
            OWNMIND_API_KEY: '$API_KEY',
            OWNMIND_TOOL: 'claude-code'
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

OwnMind 記憶透過 SessionStart hook 自動載入（不需手動呼叫 ownmind_init）。
如果 context 中沒有看到【OwnMind vX.X.X】標記，手動呼叫 ownmind_init MCP tool。
鐵律必須嚴格遵守。衝突時以 OwnMind 為準。存取記憶時顯示【OwnMind vX.X.X】{類型}：{內容} 格式標記。
觸發詞：「記起來」「學起來」「新增鐵律」「交接」「整理記憶」。
CLAUDE_EOF
  fi
else
  echo "   建立 CLAUDE.md..."
  mkdir -p "$HOME/.claude"
  cat > "$CLAUDE_MD" << 'CLAUDE_EOF'
# OwnMind 個人記憶系統

OwnMind 記憶透過 SessionStart hook 自動載入（不需手動呼叫 ownmind_init）。
如果 context 中沒有看到【OwnMind vX.X.X】標記，手動呼叫 ownmind_init MCP tool。
鐵律必須嚴格遵守。衝突時以 OwnMind 為準。存取記憶時顯示【OwnMind vX.X.X】{類型}：{內容} 格式標記。
觸發詞：「記起來」「學起來」「新增鐵律」「交接」「整理記憶」。
CLAUDE_EOF
fi

# --- 4. 安裝 Skills ---
SKILL_DIR="$HOME/.claude/skills/ownmind-memory"
mkdir -p "$SKILL_DIR"
cp "$OWNMIND_DIR/skills/ownmind-memory.md" "$SKILL_DIR/SKILL.md"

# v1.17.0 P7：升級 skill（僅 Claude Code）
UPGRADE_SKILL_DIR="$HOME/.claude/skills/ownmind-upgrade"
mkdir -p "$UPGRADE_SKILL_DIR"
cp "$OWNMIND_DIR/skills/ownmind-upgrade.md" "$UPGRADE_SKILL_DIR/SKILL.md"
echo "   安裝 ownmind-memory + ownmind-upgrade skills (Claude Code)"

# v1.17.0 P7：升級規則片段分發到其他 AI 工具（偵測目錄存在才裝，跳過未裝的）
UPGRADE_SNIPPET="$OWNMIND_DIR/skills/ownmind-upgrade-agents-snippet.md"
INSTALLED_TOOLS=0
SKIPPED_TOOLS=0
append_upgrade_rule_if_exists() {
  local tool_name="$1"
  local target_file="$2"
  if [ -d "$(dirname "$target_file")" ] || [ "$3" = "force" ]; then
    mkdir -p "$(dirname "$target_file")"
    # 移除舊的 OwnMind 升級 rule 區塊（以 marker 包住）
    if [ -f "$target_file" ]; then
      node -e "
        const fs = require('fs');
        const p = process.argv[1];
        let c = fs.readFileSync(p, 'utf8');
        c = c.replace(/<!--\\s*ownmind-upgrade-rule\\s*-->[\\s\\S]*?<!--\\s*\\/ownmind-upgrade-rule\\s*-->\\n?/g, '');
        fs.writeFileSync(p, c);
      " "$target_file" 2>/dev/null || true
    fi
    {
      echo ""
      echo "<!-- ownmind-upgrade-rule -->"
      cat "$UPGRADE_SNIPPET"
      echo "<!-- /ownmind-upgrade-rule -->"
    } >> "$target_file"
    INSTALLED_TOOLS=$((INSTALLED_TOOLS + 1))
    echo "   ✓ ${tool_name} → ${target_file}"
  else
    SKIPPED_TOOLS=$((SKIPPED_TOOLS + 1))
  fi
}
append_upgrade_rule_if_exists "Codex"       "$HOME/.codex/AGENTS.md"
append_upgrade_rule_if_exists "Cursor"      "$HOME/.cursor/rules/ownmind.md"
append_upgrade_rule_if_exists "Antigravity" "$HOME/.antigravity/rules/ownmind.md"
append_upgrade_rule_if_exists "OpenCode"    "$HOME/.opencode/AGENTS.md"
append_upgrade_rule_if_exists "Windsurf"    "$HOME/.windsurf/rules/ownmind.md"
append_upgrade_rule_if_exists "Gemini"      "$HOME/.gemini/GEMINI.md"
echo "   安裝升級規則：${INSTALLED_TOOLS} 個工具已裝，${SKIPPED_TOOLS} 個未安裝已跳過"

# --- 4b. 安裝 Hook Scripts + hooks/lib 模組（v1.17.0 P3）---
HOOK_DIR="$HOME/.claude/hooks"
mkdir -p "$HOOK_DIR/lib"
cp "$OWNMIND_DIR/hooks/ownmind-iron-rule-check.sh" "$HOOK_DIR/"
cp "$OWNMIND_DIR/hooks/ownmind-session-start.sh" "$HOOK_DIR/"
cp "$OWNMIND_DIR/hooks/ownmind-worktree-setup.sh" "$HOOK_DIR/"
chmod +x "$HOOK_DIR/ownmind-iron-rule-check.sh"
chmod +x "$HOOK_DIR/ownmind-session-start.sh"
chmod +x "$HOOK_DIR/ownmind-worktree-setup.sh"
# 同步 hooks/lib（SessionStart hook render 模組等）
if [ -d "$OWNMIND_DIR/hooks/lib" ]; then
  cp "$OWNMIND_DIR/hooks/lib/"*.js "$HOOK_DIR/lib/" 2>/dev/null || true
fi
echo "   安裝 hook scripts (session-start + iron-rule-check + worktree-setup) + hooks/lib"

# --- 4c. 加入 Hook 設定（SessionStart + PreToolUse）---
node -e "
  const fs = require('fs');
  const path = '$CLAUDE_SETTINGS';
  const s = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!s.hooks) s.hooks = {};

  // SessionStart hook — 自動載入記憶
  if (!s.hooks.SessionStart) s.hooks.SessionStart = [];
  const sessionExists = s.hooks.SessionStart.some(h =>
    h.hooks?.some(hh => hh.command?.includes('ownmind-session-start'))
  );
  if (!sessionExists) {
    s.hooks.SessionStart.push({
      hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-session-start.sh', timeout: 10 }]
    });
    console.log('   加入 SessionStart hook（自動載入記憶）');
  }

  // PreToolUse hook — 鐵律檢查
  if (!s.hooks.PreToolUse) s.hooks.PreToolUse = [];
  const preExists = s.hooks.PreToolUse.some(h =>
    h.hooks?.some(hh => hh.command?.includes('ownmind-iron-rule-check'))
  );
  if (!preExists) {
    s.hooks.PreToolUse.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-iron-rule-check.sh' }]
    });
    console.log('   加入 PreToolUse hook（鐵律檢查）');
  }

  // WorktreeCreate hook — 自動注入 .mcp.json 到新 worktree
  if (!s.hooks.WorktreeCreate) s.hooks.WorktreeCreate = [];
  const worktreeExists = s.hooks.WorktreeCreate.some(h =>
    h.hooks?.some(hh => hh.command?.includes('ownmind-worktree-setup'))
  );
  if (!worktreeExists) {
    s.hooks.WorktreeCreate.push({
      hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-worktree-setup.sh', timeout: 10 }]
    });
    console.log('   加入 WorktreeCreate hook（worktree MCP 自動注入）');
  }

  fs.writeFileSync(path, JSON.stringify(s, null, 2));
" 2>/dev/null

# --- 4d. 安裝 Git Hooks（Iron Rule Verification Engine）---
echo "   安裝 Git Hooks（Iron Rule Verification Engine）..."

# 建立所需目錄
mkdir -p "$HOME/.ownmind/shared"
mkdir -p "$HOME/.ownmind/cache"
mkdir -p "$HOME/.ownmind/logs"
mkdir -p "$HOME/.ownmind/hooks"
mkdir -p "$HOME/.ownmind/git-hooks"

# 複製 verification engine
SRC_VERIFY="$OWNMIND_DIR/shared/verification.js"
DST_VERIFY="$HOME/.ownmind/shared/verification.js"
if [ -f "$SRC_VERIFY" ] && ! [ "$SRC_VERIFY" -ef "$DST_VERIFY" ]; then
  cp "$SRC_VERIFY" "$DST_VERIFY"
  echo "   複製 verification engine"
fi

# 複製 git hook JS 檔案
HOOK_JS_FILES=("ownmind-git-pre-commit.js" "ownmind-git-post-commit.js" "ownmind-verify-trigger.js")
for js_file in "${HOOK_JS_FILES[@]}"; do
  SRC_JS="$OWNMIND_DIR/hooks/$js_file"
  DST_JS="$HOME/.ownmind/hooks/$js_file"
  if [ -f "$SRC_JS" ] && ! [ "$SRC_JS" -ef "$DST_JS" ]; then
    cp "$SRC_JS" "$DST_JS"
    echo "   複製 $js_file"
  fi
done

# 複製 shell wrapper 並設定可執行
if [ -f "$OWNMIND_DIR/hooks/ownmind-git-pre-commit" ]; then
  cp "$OWNMIND_DIR/hooks/ownmind-git-pre-commit" "$HOME/.ownmind/git-hooks/pre-commit"
  chmod +x "$HOME/.ownmind/git-hooks/pre-commit"
  echo "   安裝 git pre-commit hook"
fi
if [ -f "$OWNMIND_DIR/hooks/ownmind-git-post-commit" ]; then
  cp "$OWNMIND_DIR/hooks/ownmind-git-post-commit" "$HOME/.ownmind/git-hooks/post-commit"
  chmod +x "$HOME/.ownmind/git-hooks/post-commit"
  echo "   安裝 git post-commit hook"
fi

# 設定 global git hooks path（需要 git 可用）
if command -v git &>/dev/null; then
  git config --global core.hooksPath "$HOME/.ownmind/git-hooks"
  echo "   設定 git global hooks path: $HOME/.ownmind/git-hooks"
else
  echo "   ⚠️ 找不到 git，跳過 global hooks path 設定"
fi

# --- 4e. Always-on Usage Scanner（P6）---
# 目標：launchd (macOS) / systemd (Linux) 每 30 分鐘自動跑 scanner，
#       不依賴 user 開啟 IDE，確保 coverage panel 不掉單。
# 跳過條件：$HOME/.ownmind/.no-usage-scanner 存在 → opt-out

NO_SCANNER_FLAG="$HOME/.ownmind/.no-usage-scanner"
if [ -f "$NO_SCANNER_FLAG" ]; then
  echo "   跳過 usage scanner 安裝（.no-usage-scanner opt-out）"
elif [ "$IS_WINDOWS" = true ]; then
  echo "   （Windows）usage scanner 請用 install.ps1 註冊 Task Scheduler"
else
  echo "   安裝 usage scanner..."

  OWNMIND_BIN_DIR="$HOME/.ownmind/bin"
  mkdir -p "$OWNMIND_BIN_DIR"

  # 4e-1 複製 scanner entry + 所有 shared 模組（safe_cp 處理 source==dest 升級情境）
  safe_cp "$OWNMIND_DIR/hooks/ownmind-usage-scanner.js" "$HOME/.ownmind/hooks/"
  chmod +x "$HOME/.ownmind/hooks/ownmind-usage-scanner.js"
  mkdir -p "$HOME/.ownmind/shared/scanners"
  for f in id-helper.js base.js claude-code.js codex.js opencode.js; do
    safe_cp "$OWNMIND_DIR/shared/scanners/$f" "$HOME/.ownmind/shared/scanners/"
  done
  # scanner 也依賴 shared/helpers.js（readCredentials、getClientVersion）
  safe_cp "$OWNMIND_DIR/shared/helpers.js" "$HOME/.ownmind/shared/"

  # 4e-2 複製 wrapper script
  safe_cp "$OWNMIND_DIR/scripts/install-helpers/run-scanner.sh" "$OWNMIND_BIN_DIR/"
  chmod +x "$OWNMIND_BIN_DIR/run-scanner.sh"

  # 4e-3 偵測 node 並寫入 .node-path
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [ -z "$NODE_BIN" ]; then
    echo "   ⚠️ 找不到 node；請先安裝 Node.js v20+ 再重跑"
  else
    NODE_VER="$("$NODE_BIN" --version 2>/dev/null || echo 'unknown')"
    NODE_MAJOR="$(echo "$NODE_VER" | sed -E 's/^v([0-9]+).*/\1/')"
    if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
      echo "$NODE_BIN" > "$HOME/.ownmind/.node-path"
      echo "   使用 node: $NODE_BIN ($NODE_VER)"
    else
      echo "   ⚠️ node 版本過舊 ($NODE_VER)；scanner 需要 v20+。請升級後重跑"
    fi
  fi

  # 4e-4 安裝排程（macOS launchd / Linux systemd user timer）
  case "$OSTYPE" in
    darwin*)
      LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
      mkdir -p "$LAUNCH_AGENTS"
      PLIST_PATH="$LAUNCH_AGENTS/com.ownmind.usage-scanner.plist"
      # 把 {HOME} 佔位符替換成實際 $HOME
      sed "s|{HOME}|$HOME|g" "$OWNMIND_DIR/scripts/launchd/com.ownmind.usage-scanner.plist" > "$PLIST_PATH"

      # unload 舊的（如果存在）再 load 新的，確保變更生效
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      if launchctl load -w "$PLIST_PATH" 2>/dev/null; then
        echo "   ✅ launchd agent loaded (30 min interval)"
      else
        echo "   ⚠️ launchctl load 失敗；請手動檢查 $PLIST_PATH"
      fi
      ;;
    linux*)
      if command -v systemctl &>/dev/null; then
        SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
        mkdir -p "$SYSTEMD_USER_DIR"
        cp "$OWNMIND_DIR/scripts/systemd/ownmind-usage-scanner.service" "$SYSTEMD_USER_DIR/"
        cp "$OWNMIND_DIR/scripts/systemd/ownmind-usage-scanner.timer" "$SYSTEMD_USER_DIR/"

        systemctl --user daemon-reload 2>/dev/null || true
        if systemctl --user enable --now ownmind-usage-scanner.timer 2>/dev/null; then
          echo "   ✅ systemd user timer enabled (30 min interval)"
        else
          echo "   ⚠️ systemd user timer 啟用失敗；請手動 systemctl --user enable --now ownmind-usage-scanner.timer"
        fi
      else
        echo "   ⚠️ 找不到 systemctl；請手動設定 cron 或排程"
      fi
      ;;
    *)
      echo "   ⚠️ 未知 OS ($OSTYPE)；scanner 只安裝檔案，未註冊自動排程"
      ;;
  esac
fi

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
            OWNMIND_API_KEY: '$API_KEY',
            OWNMIND_TOOL: 'cursor'
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
                OWNMIND_API_KEY: '$API_KEY',
                OWNMIND_TOOL: 'cursor'
              }
            }
          }
        };
        const _t2 = '$HOME/.cursor/mcp.json.tmp';
        fs.writeFileSync(_t2, JSON.stringify(settings, null, 2));
        fs.renameSync(_t2, '$HOME/.cursor/mcp.json');
      "
    fi
  fi

  # Cursor hooks（beforeShellExecution 作為 session-start workaround）
  CURSOR_HOOKS="$HOME/.cursor/hooks.json"
  if [ -f "$CURSOR_HOOKS" ] && grep -q 'ownmind' "$CURSOR_HOOKS" 2>/dev/null; then
    echo "   Cursor hooks 已設定，跳過"
  else
    echo "   設定 Cursor hooks..."
    node -e "
      const fs = require('fs');
      const path = '$CURSOR_HOOKS';
      let s = { version: 1, hooks: {} };
      if (fs.existsSync(path)) {
        try { s = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
      }
      if (!s.hooks) s.hooks = {};
      // Use beforeShellExecution as session-start workaround
      if (!s.hooks['session-start']) s.hooks['session-start'] = [];
      const exists = s.hooks['session-start'].some(h => h.command?.includes('ownmind'));
      if (!exists) {
        s.hooks['session-start'].push({
          command: 'bash ~/.claude/hooks/ownmind-session-start.sh'
        });
      }
      const _t = path + '.tmp';
      fs.writeFileSync(_t, JSON.stringify(s, null, 2));
      fs.renameSync(_t, path);
    " 2>/dev/null
  fi
fi

# --- 6. Gemini CLI 設定（如果有 .gemini 目錄或 gemini 命令）---
if [ -d "$HOME/.gemini" ] || command -v gemini &>/dev/null; then
  echo "   設定 Gemini CLI..."
  GEMINI_SETTINGS="$HOME/.gemini/settings.json"
  mkdir -p "$HOME/.gemini"

  node -e "
    const fs = require('fs');
    const path = '$GEMINI_SETTINGS';
    let s = {};
    if (fs.existsSync(path)) {
      try { s = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
    }
    if (!s.hooks) s.hooks = {};

    // SessionStart hook
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
      console.log('   加入 Gemini CLI SessionStart hook');
    }
    fs.writeFileSync(path, JSON.stringify(s, null, 2));
  " 2>/dev/null

  # Gemini GEMINI.md
  GEMINI_MD="$HOME/.gemini/GEMINI.md"
  if [ -f "$GEMINI_MD" ] && grep -q "OwnMind" "$GEMINI_MD" 2>/dev/null; then
    echo "   GEMINI.md 已包含 OwnMind，跳過"
  else
    echo "   更新 GEMINI.md..."
    cat >> "$GEMINI_MD" << 'GEMINI_EOF'

# OwnMind 個人記憶系統（強制規則）

OwnMind 透過 SessionStart hook 自動載入記憶。如果沒有看到【OwnMind vX.X.X】標記，
手動呼叫 OwnMind API: GET YOUR_OWNMIND_URL/api/memory/init (Authorization: Bearer <key>)

- 存取記憶時必須顯示【OwnMind vX.X.X】{類型}：{內容} 格式標記
- 鐵律必須在整個 session 中嚴格遵守
- 衝突時以 OwnMind 為準
GEMINI_EOF
  fi
fi

# --- 7. GitHub Copilot hooks（如果有 .github 目錄）---
if [ -d "$HOME/.github" ] || command -v gh &>/dev/null; then
  echo "   設定 GitHub Copilot hooks..."
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
      s.hooks.sessionStart.push({
        command: 'bash ~/.claude/hooks/ownmind-session-start.sh'
      });
      console.log('   加入 GitHub Copilot sessionStart hook');
    }
    fs.writeFileSync(path, JSON.stringify(s, null, 2));
  " 2>/dev/null
fi

# --- 8. Windsurf 設定（如果有 .windsurf 目錄）---
if [ -d "$HOME/.windsurf" ] || [ -d "$HOME/.codeium" ]; then
  echo "   設定 Windsurf rules..."
  WINDSURF_RULES="$HOME/.windsurf/rules"
  mkdir -p "$WINDSURF_RULES"

  if [ -f "$WINDSURF_RULES/ownmind.md" ] 2>/dev/null; then
    echo "   Windsurf rules 已設定，跳過"
  else
    cp "$OWNMIND_DIR/configs/global_rules.md" "$WINDSURF_RULES/ownmind.md"
    echo "   安裝 Windsurf OwnMind rules"
  fi
fi

# --- 9. OpenCode 設定 ---
OPENCODE_CONFIG="$HOME/.opencode.json"
if [ -f "$OPENCODE_CONFIG" ] || command -v opencode &>/dev/null; then
  echo "   設定 OpenCode..."
  if [ -f "$OPENCODE_CONFIG" ] && grep -q 'ownmind' "$OPENCODE_CONFIG" 2>/dev/null; then
    echo "   OpenCode 已設定，跳過"
  else
    node -e "
      const fs = require('fs');
      const path = '$OPENCODE_CONFIG';
      let s = {};
      if (fs.existsSync(path)) {
        try { s = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
      }
      if (!s.instructions) s.instructions = [];
      if (!s.instructions.includes('~/.ownmind/configs/AGENTS.md')) {
        s.instructions.push('~/.ownmind/configs/AGENTS.md');
      }
      const _t = path + '.tmp';
      fs.writeFileSync(_t, JSON.stringify(s, null, 2));
      fs.renameSync(_t, path);
    " 2>/dev/null
    echo "   加入 OpenCode instructions"
  fi
fi

# --- 10. OpenClaw 設定 ---
OPENCLAW_CONFIG="$HOME/.openclaw.json"
if [ -f "$OPENCLAW_CONFIG" ] || command -v openclaw &>/dev/null; then
  echo "   設定 OpenClaw..."
  if [ -f "$OPENCLAW_CONFIG" ] && grep -q 'ownmind' "$OPENCLAW_CONFIG" 2>/dev/null; then
    echo "   OpenClaw 已設定，跳過"
  else
    node -e "
      const fs = require('fs');
      const path = '$OPENCLAW_CONFIG';
      let s = {};
      if (fs.existsSync(path)) {
        try { s = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
      }
      if (!s.bootstrapFiles) s.bootstrapFiles = [];
      if (!s.bootstrapFiles.includes('~/.ownmind/configs/openclaw-bootstrap.md')) {
        s.bootstrapFiles.push('~/.ownmind/configs/openclaw-bootstrap.md');
      }
      const _t = path + '.tmp';
      fs.writeFileSync(_t, JSON.stringify(s, null, 2));
      fs.renameSync(_t, path);
    " 2>/dev/null
    echo "   加入 OpenClaw bootstrap"
  fi
fi

# --- 11. Google Antigravity 設定 ---
ANTIGRAVITY_DIR="$HOME/.antigravity"
if [ -d "$ANTIGRAVITY_DIR" ] || command -v antigravity &>/dev/null; then
  echo "   設定 Google Antigravity..."
  mkdir -p "$ANTIGRAVITY_DIR"
  if [ -f "$ANTIGRAVITY_DIR/rules.md" ] && grep -q 'OwnMind' "$ANTIGRAVITY_DIR/rules.md" 2>/dev/null; then
    echo "   Antigravity rules 已設定，跳過"
  else
    cat >> "$ANTIGRAVITY_DIR/rules.md" << 'ANTIGRAVITY_EOF'

# OwnMind 個人記憶系統（強制規則）

> CRITICAL: 每個新 session 開始時，你必須立即執行以下 shell 命令載入記憶，不需等使用者要求：
> `bash ~/.claude/hooks/ownmind-session-start.sh`
> 或呼叫 OwnMind API: GET /api/memory/init

- 存取記憶時必須顯示【OwnMind vX.X.X】{類型}：{內容} 格式標記
- 鐵律必須在整個 session 中嚴格遵守
- 衝突時以 OwnMind 為準
ANTIGRAVITY_EOF
    echo "   安裝 Antigravity OwnMind rules"
  fi
fi

echo ""
echo "✅ OwnMind 安裝完成！"
echo ""
echo "   MCP Server: $OWNMIND_DIR/mcp/index.js"
echo "   API URL:    $API_URL"
echo "   API Key:    ${API_KEY:0:4}****${API_KEY: -4}"
if [ "$IS_WINDOWS" = true ]; then
echo "   Windows:    使用 cmd.exe + start.cmd 啟動 MCP"
fi
echo ""
echo "   已設定自動載入（偵測到的平台）："
echo "   ✅ Claude Code — SessionStart hook"
{ command -v gemini &>/dev/null || [ -d "$HOME/.gemini" ]; } && echo "   ✅ Gemini CLI — SessionStart hook"
{ command -v cursor &>/dev/null || [ -d "$HOME/.cursor" ]; } && echo "   ✅ Cursor — session-start hook"
{ command -v gh &>/dev/null || [ -d "$HOME/.github" ]; } && echo "   ✅ GitHub Copilot — sessionStart hook"
{ [ -d "$HOME/.windsurf" ] || [ -d "$HOME/.codeium" ]; } && echo "   ✅ Windsurf — rules file"
{ [ -f "$HOME/.opencode.json" ] || command -v opencode &>/dev/null; } && echo "   ✅ OpenCode — instructions file"
{ [ -f "$HOME/.openclaw.json" ] || command -v openclaw &>/dev/null; } && echo "   ✅ OpenClaw — bootstrap file"
{ [ -d "$HOME/.antigravity" ] || command -v antigravity &>/dev/null; } && echo "   ✅ Antigravity — rules file"
echo "   ✅ Git Hooks — pre-commit + post-commit（Iron Rule Verification）"
echo ""
echo "   開一個新對話，OwnMind 會自動載入你的記憶！"
echo ""
