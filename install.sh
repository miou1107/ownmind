#!/bin/bash
# OwnMind 一鍵安裝腳本
# 用法: curl -sL https://raw.githubusercontent.com/miou1107/ownmind/main/install.sh | bash -s -- YOUR_API_KEY YOUR_API_URL

set -eE  # -E so the ERR trap below also fires inside shell functions

API_KEY="${1:-}"
API_URL="${2:-}"

if [ -z "$API_KEY" ]; then
  echo "[ERROR] API Key and API URL required"
  echo "Usage:   bash install.sh YOUR_API_KEY YOUR_API_URL"
  echo "Example: bash install.sh abc123 https://your-server.com/ownmind"
  exit 1
fi

if [ -z "$API_URL" ]; then
  echo "[ERROR] API URL required"
  echo "Usage:   bash install.sh YOUR_API_KEY YOUR_API_URL"
  echo "Example: bash install.sh abc123 https://your-server.com/ownmind"
  exit 1
fi

echo "OwnMind installer"
echo "─────────────────────────────────────────────"

# --- v1.17.78 IR-038：install_started beacon（觀測管道補洞）---
# install.sh 中段任何 set -e 失敗都會直接 exit，end-of-file self-check 跑不到，
# admin 看不到 user 試過裝。送一個輕量 beacon 至少留紀錄。fire-and-forget。
send_install_beacon() {
  local trigger="$1"
  if [ -z "$API_URL" ] || [ -z "$API_KEY" ]; then return; fi
  local ts machine platform body
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  machine="$(hostname 2>/dev/null || echo unknown)"
  case "$OSTYPE" in
    darwin*) platform='darwin' ;;
    linux*) platform='linux' ;;
    msys*|cygwin*|win32*) platform='win32' ;;
    *) platform="$OSTYPE" ;;
  esac
  body=$(printf '{"ts":"%s","trigger":"%s","client_version":"install-script","platform":"%s","machine":"%s"}' \
    "$ts" "$trigger" "$platform" "$machine")
  if curl -fsS -m 5 -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${API_URL%/}/api/debug/install-check" >/dev/null 2>&1; then
    return
  fi
  # v1.17.80（vin-windows-test 第四輪）：POST 失敗 → spool 到 .upload-spool.jsonl
  # 下次 self-check retrySpool() 自動補傳，不再 fire-and-forget 丟資料。
  local spool_dir="${HOME}/.ownmind/logs"
  mkdir -p "$spool_dir" 2>/dev/null || return
  printf '%s\n' "$body" >> "${spool_dir}/.upload-spool.jsonl" 2>/dev/null || true
}
send_install_beacon 'install_started'

# v1.17.79 — 載入 report-error helper（IR-038 觀測管道）
# 注意：第一次安裝時 ~/.ownmind 還沒 clone 下來，helper 還不存在 — 後續 clone 後可用。
# 設一個本地 fallback 先擋著，clone 完才覆蓋。
report_error() { :; }
maybe_load_report_error() {
  local h="${HOME}/.ownmind/scripts/install-helpers/report-error.sh"
  if [ -f "$h" ]; then
    # shellcheck disable=SC1090
    . "$h"
  fi
}

# --- sqlite3 偵測（v1.17.14，Tier 2 scanner 需要）---
# Mac 預設內建 sqlite3，Linux 多半要 apt install。Windows（Git Bash）交由 install.ps1 處理。
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[WARN] sqlite3 CLI not found (required by Tier 2 usage scanner: Cursor / Antigravity / OpenCode)"
  case "$OSTYPE" in
    linux*) echo "       Install: sudo apt install sqlite3 (Debian/Ubuntu) or sudo dnf install sqlite (Fedora/RHEL)" ;;
    darwin*) echo "       macOS usually ships sqlite3; install with: brew install sqlite" ;;
    msys*|cygwin*|win32*) echo "       Windows: install.ps1 installs via winget, or download from https://www.sqlite.org/download.html" ;;
  esac
  echo "       Skipping does not affect Claude Code / Codex usage; only Tier 2 session counts are unavailable"
fi

# --- 偵測作業系統 ---
IS_WINDOWS=false
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
  IS_WINDOWS=true
  echo "[INFO] Detected Windows environment (Git Bash)"
fi

# --- node 偵測 + 自動安裝（v1.17.76, 回報者 vin-windows-test）---
# v1.17.75 之前：完全沒查 node，直到下面 npm install 才神秘失敗。
# 現在：mac 用 brew 自動裝、linux 提示 apt/dnf 指令、windows 改走 install.ps1。
if ! command -v node >/dev/null 2>&1; then
  echo "[WARN] Node.js not found (required by OwnMind)"
  case "$OSTYPE" in
    darwin*)
      if command -v brew >/dev/null 2>&1; then
        echo "       Attempting: brew install node"
        if brew install node; then
          echo "[ OK ] Node.js installed"
        else
          echo "[ERROR] brew install node failed. Install Node.js v20+ manually (https://nodejs.org/) and retry"
          exit 1
        fi
      else
        echo "[ERROR] Homebrew not installed. Choose one:"
        echo "        1. Download Node.js v20+ LTS from https://nodejs.org/"
        echo "        2. Install Homebrew (https://brew.sh/) and re-run this script"
        exit 1
      fi
      ;;
    linux*)
      echo "[ERROR] Linux: install Node.js v20+ manually and re-run:"
      echo "        Debian/Ubuntu: sudo apt install nodejs npm"
      echo "        Fedora/RHEL:   sudo dnf install nodejs npm"
      echo "        Or via nvm (recommended for version flexibility): https://github.com/nvm-sh/nvm"
      exit 1
      ;;
    msys*|cygwin*|win32*)
      echo "[ERROR] Windows: run install.ps1 instead (it auto-installs Node.js via winget)"
      exit 1
      ;;
    *)
      echo "[ERROR] Unknown OS ($OSTYPE); install Node.js v20+ manually and retry"
      exit 1
      ;;
  esac
fi

# Node version check (>= v20, required by scanner / mcp)
NODE_VER=$(node --version 2>/dev/null | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  echo "[ERROR] Node.js too old (v$NODE_VER); OwnMind requires v20+. Upgrade and retry"
  exit 1
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
  echo "[INFO] Updating OwnMind MCP server"
  if ! git -C "$OWNMIND_DIR" pull -q; then
    maybe_load_report_error
    report_error "install_git_pull_failed" "git pull failed (existing OwnMind directory cannot be updated)"
    echo "[ERROR] git pull failed. Run bootstrap.sh or fix manually"
    exit 1
  fi
else
  echo "[INFO] Cloning OwnMind MCP server"
  if ! git clone -q https://github.com/miou1107/ownmind.git "$OWNMIND_DIR"; then
    report_error "install_git_clone_failed" "git clone github.com/miou1107/ownmind failed"
    echo "[ERROR] git clone failed (network or GitHub access)"
    exit 1
  fi
fi
maybe_load_report_error

echo "[INFO] Installing dependencies"
cd "$OWNMIND_DIR/mcp"
if ! npm install -q 2>/dev/null; then
  report_error "install_npm_failed" "npm install in ${OWNMIND_DIR}/mcp failed"
  echo "[ERROR] npm install failed. Try: npm install -g npm@latest and retry"
  exit 1
fi

# --- v1.26.88 Windows path normalization + a place for Node's stderr to go ---
#
# Under Git Bash, $HOME is a POSIX path (/c/Users/Vin). Paths passed to node as ARGUMENTS
# are converted by the MSYS runtime, but paths interpolated into the source text of
# `node -e` are not: node.exe resolves the leading slash against the drive root and fails
# with ENOENT. Bug report #15 (2026-08-06) traced a silent, complete abort of this script
# to exactly that, on the block that writes the PreToolUse hook.
#
# path-helpers.sh has existed since v1.26.7 for this reason and was only ever wired into
# interactive-upgrade.sh. Everything below that embeds a path in Node source must use it.
if [ -f "$OWNMIND_DIR/scripts/install-helpers/path-helpers.sh" ]; then
  # shellcheck disable=SC1091
  . "$OWNMIND_DIR/scripts/install-helpers/path-helpers.sh"
else
  to_win_path() { echo "$1"; }
fi

# Node stderr from the blocks below goes here, never to /dev/null. `set -e` plus a
# discarded stderr is how a fatal error produced no output at all for four months.
# This lives outside ~/.ownmind so an upgrade rollback cannot delete it.
INSTALL_LOG_DIR="$HOME/.ownmind-logs"
mkdir -p "$INSTALL_LOG_DIR" 2>/dev/null || true
INSTALL_LOG="$INSTALL_LOG_DIR/install-$(date +%Y%m%d-%H%M%S).log"
: > "$INSTALL_LOG" 2>/dev/null || INSTALL_LOG="/dev/stderr"

# Report the step that just failed, then let `set -e` do its job. Without this the user
# sees a script that simply stops.
on_install_error() {
  local line="$1"
  echo "[FAIL] install.sh aborted at line ${line}"
  echo "       Details: $INSTALL_LOG"
  if [ -s "$INSTALL_LOG" ]; then
    echo "       Last error:"
    tail -n 5 "$INSTALL_LOG" | sed 's/^/         /'
  fi
  report_error "install_aborted" "install.sh aborted at line ${line}" "$INSTALL_LOG" 2>/dev/null || true
}
trap 'on_install_error "$LINENO"' ERR


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
  # Unreachable on Windows (that is the branch above), but routed through to_win_path all
  # the same: it is identity off Windows, and one uniform rule is cheaper to hold than an
  # exception nobody remembers is safe.
  MCP_ENTRY_PATH_WIN="$(to_win_path "$OWNMIND_DIR/mcp/index.js")"
  MCP_ENTRY=$(node -e "
    const p = '$MCP_ENTRY_PATH_WIN';
    console.log(JSON.stringify({ command: 'node', args: [p] }));
  ")
fi

# --- 2. Claude Code MCP 設定 ---
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_SETTINGS_WIN="$(to_win_path "$CLAUDE_SETTINGS")"
if [ -f "$CLAUDE_SETTINGS" ]; then
  if grep -q '"ownmind"' "$CLAUDE_SETTINGS" 2>/dev/null; then
    echo "[INFO] Claude Code MCP already configured, skipping"
  else
    echo "[INFO] Configuring Claude Code MCP"
    node -e "
      const fs = require('fs');
      const entry = $MCP_ENTRY;
      const settings = JSON.parse(fs.readFileSync('$CLAUDE_SETTINGS_WIN', 'utf8'));
      if (!settings.mcpServers) settings.mcpServers = {};
      settings.mcpServers.ownmind = {
        ...entry,
        env: {
          OWNMIND_API_URL: '$API_URL',
          OWNMIND_API_KEY: '$API_KEY',
          OWNMIND_TOOL: 'claude-code'
        }
      };
      const _tmp = '$CLAUDE_SETTINGS_WIN' + '.tmp';
      fs.writeFileSync(_tmp, JSON.stringify(settings, null, 2));
      fs.renameSync(_tmp, '$CLAUDE_SETTINGS_WIN');
    "
  fi
else
  echo "[INFO] Creating Claude Code MCP config"
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
    fs.writeFileSync('$CLAUDE_SETTINGS_WIN', JSON.stringify(settings, null, 2));
  "
fi

# --- 2.0 v1.17.97：算出傳給 hook installer 的 OwnMind 路徑（給 §2.1 + §2.2 共用）---
# Git Bash on Windows 必須傳 Win32 path（C:\...），否則 Claude Code 在 Windows
# 原生 command runner 找不到 hook 檔（POSIX path /c/Users/... 不認）。
# 抽到兩個 section 之外算、避免 §2.1 helper 不存在時 §2.2 用到空字串
# （review B1 — 之前就是這個 bug）。
if [ "$IS_WINDOWS" = true ]; then
  OWNMIND_DIR_FOR_HOOK=$(cygpath -w "$OWNMIND_DIR" 2>/dev/null || echo "$OWNMIND_DIR")
else
  OWNMIND_DIR_FOR_HOOK="$OWNMIND_DIR"
fi

# --- 2.1 v1.17.71 OwnMind 在場感：加 PostToolUse hook 把 banner 印到 user terminal ---
# helper 是 idempotent，已加過會回 skipped；既有 user 設定必保留 + atomic write + backup
ADD_HOOK_HELPER="$OWNMIND_DIR/scripts/install-helpers/add-post-tool-use-hook.cjs"
if [ -f "$ADD_HOOK_HELPER" ]; then
  HOOK_RESULT=$(node "$ADD_HOOK_HELPER" "$CLAUDE_SETTINGS" --ownmind-dir "$OWNMIND_DIR_FOR_HOOK" 2>&1)
  echo "   PostToolUse banner hook：$HOOK_RESULT"
else
  echo "[WARN] add-post-tool-use-hook.cjs 不存在（升級殘留？）— 跳過 PostToolUse hook 註冊"
fi

# --- 2.2 v1.17.96 IR-037/IR-036 邏輯卡控：加 Stop hook 跑 reply-lint ---
# 每輪 AI 回話結束自動掃中英混雜 + 行話沒附白話說明、違反就印 banner 到 terminal
ADD_STOP_HOOK_HELPER="$OWNMIND_DIR/scripts/install-helpers/add-stop-hook.cjs"
if [ -f "$ADD_STOP_HOOK_HELPER" ]; then
  STOP_HOOK_RESULT=$(node "$ADD_STOP_HOOK_HELPER" "$CLAUDE_SETTINGS" --ownmind-dir "$OWNMIND_DIR_FOR_HOOK" 2>&1)
  echo "   Stop reply-lint hook：$STOP_HOOK_RESULT"
else
  echo "[WARN] add-stop-hook.cjs 不存在（升級殘留？）— 跳過 Stop hook 註冊"
fi

# --- 3. CLAUDE.md 加入 OwnMind 引用 ---
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  if grep -q "OwnMind" "$CLAUDE_MD" 2>/dev/null; then
    echo "[INFO] CLAUDE.md already references OwnMind, skipping"
  else
    echo "[INFO] Updating CLAUDE.md"
    cat >> "$CLAUDE_MD" << 'CLAUDE_EOF'

# OwnMind 個人記憶系統

OwnMind 記憶透過 SessionStart hook 自動載入（不需手動呼叫 ownmind_init）。
如果 context 中沒有看到【OwnMind vX.X.X】標記，手動呼叫 ownmind_init MCP tool。
鐵律必須嚴格遵守。衝突時以 OwnMind 為準。存取記憶時顯示【OwnMind vX.X.X】{類型}：{內容} 格式標記。
觸發詞：「記起來」「學起來」「新增鐵律」「交接」「整理記憶」。
CLAUDE_EOF
  fi
else
  echo "[INFO] Creating CLAUDE.md"
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
echo "[INFO] Installed ownmind-memory + ownmind-upgrade skills (Claude Code)"

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
      " "$(to_win_path "$target_file")" 2>>"$INSTALL_LOG" || true
    fi
    {
      echo ""
      echo "<!-- ownmind-upgrade-rule -->"
      cat "$UPGRADE_SNIPPET"
      echo "<!-- /ownmind-upgrade-rule -->"
    } >> "$target_file"
    INSTALLED_TOOLS=$((INSTALLED_TOOLS + 1))
    echo "[ OK ] ${tool_name} -> ${target_file}"
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
echo "[INFO] Upgrade rules synced: ${INSTALLED_TOOLS} installed, ${SKIPPED_TOOLS} skipped"

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
echo "[INFO] Installed hook scripts (session-start + iron-rule-check + worktree-setup) + hooks/lib"

# --- 4c. 加入 Hook 設定（SessionStart + PreToolUse）---
node -e "
  const fs = require('fs');
  const nodePath = require('path');
  const os = require('os');
  const path = '$CLAUDE_SETTINGS_WIN';
  const s = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!s.hooks) s.hooks = {};

  // SessionStart is handled by ensure-session-hook.cjs (v1.26.86, see that file), which
  // runs as its own step after this block. All four install/update scripts share it.
  // PreToolUse hook — iron rule check
  //
  // v1.26.92: two matchers now, and the presence check has to be per-matcher. It used to
  // ask 'is ownmind-iron-rule-check registered anywhere in PreToolUse', which is true for
  // every existing install — so a second entry added here would never reach anyone who
  // already had the first. Upgrades are the whole population.
  if (!s.hooks.PreToolUse) s.hooks.PreToolUse = [];
  const preToolUseMatchers = [
    { matcher: 'Bash', label: '鐵律檢查' },
    // The file-editing tools carry no command, which is why no rule tagged trigger:edit had
    // ever fired. The hook throttles itself to one full listing per hour.
    { matcher: 'Edit|Write|MultiEdit|NotebookEdit', label: '改檔案時的鐵律提醒' },
  ];
  for (const { matcher, label } of preToolUseMatchers) {
    const exists = s.hooks.PreToolUse.some(h =>
      h.matcher === matcher && h.hooks?.some(hh => hh.command?.includes('ownmind-iron-rule-check'))
    );
    if (!exists) {
      s.hooks.PreToolUse.push({
        matcher,
        hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-iron-rule-check.sh' }]
      });
      console.log('   加入 PreToolUse hook（' + label + '）');
    }
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
" 2>>"$INSTALL_LOG"

# --- 4c-2. SessionStart hook (v1.26.86, delegated to the shared implementation) ---
ENSURE_HOOK="$OWNMIND_DIR/scripts/install-helpers/ensure-session-hook.cjs"
if [ -f "$ENSURE_HOOK" ]; then
  if hook_result=$(node "$ENSURE_HOOK" --ownmind-dir "$OWNMIND_DIR" 2>&1); then
    echo "[ OK ] SessionStart hook: $hook_result"
  else
    echo "[FAIL] SessionStart hook: $hook_result"
  fi
else
  echo "[WARN] ensure-session-hook.cjs not found; SessionStart hook left as-is"
fi

# --- 4c-3. Background credentials (v1.26.87) ---
# A key that lives only in the environment works for the MCP and for nothing else: the
# usage scanner runs from launchd / Task Scheduler and cannot inherit a shell. Copy it into
# a file. Opt out with `touch ~/.ownmind/.no-key-file`.
ENSURE_KEY_FILE="$OWNMIND_DIR/scripts/install-helpers/ensure-key-file.cjs"
if [ -f "$ENSURE_KEY_FILE" ]; then
  if key_result=$(node "$ENSURE_KEY_FILE" --ownmind-dir "$OWNMIND_DIR" 2>&1); then
    echo "[ OK ] Background credentials: $key_result"
  else
    echo "[FAIL] Background credentials: $key_result"
  fi
else
  echo "[WARN] ensure-key-file.cjs not found; credentials left as-is"
fi

# --- 4d. 安裝 Git Hooks（Iron Rule Verification Engine）---
echo "[INFO] Installing Git hooks (Iron Rule Verification Engine)"

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
  echo "[INFO] Copied verification engine"
fi

# 複製 git hook JS 檔案
HOOK_JS_FILES=("ownmind-git-pre-commit.js" "ownmind-git-post-commit.js" "ownmind-verify-trigger.js")
for js_file in "${HOOK_JS_FILES[@]}"; do
  SRC_JS="$OWNMIND_DIR/hooks/$js_file"
  DST_JS="$HOME/.ownmind/hooks/$js_file"
  if [ -f "$SRC_JS" ] && ! [ "$SRC_JS" -ef "$DST_JS" ]; then
    cp "$SRC_JS" "$DST_JS"
    echo "[INFO] Copied $js_file"
  fi
done

# 複製 shell wrapper 並設定可執行
if [ -f "$OWNMIND_DIR/hooks/ownmind-git-pre-commit" ]; then
  cp "$OWNMIND_DIR/hooks/ownmind-git-pre-commit" "$HOME/.ownmind/git-hooks/pre-commit"
  chmod +x "$HOME/.ownmind/git-hooks/pre-commit"
  echo "[ OK ] Installed git pre-commit hook"
fi
if [ -f "$OWNMIND_DIR/hooks/ownmind-git-post-commit" ]; then
  cp "$OWNMIND_DIR/hooks/ownmind-git-post-commit" "$HOME/.ownmind/git-hooks/post-commit"
  chmod +x "$HOME/.ownmind/git-hooks/post-commit"
  echo "[ OK ] Installed git post-commit hook"
fi
if [ -f "$OWNMIND_DIR/hooks/ownmind-git-commit-msg" ]; then
  cp "$OWNMIND_DIR/hooks/ownmind-git-commit-msg" "$HOME/.ownmind/git-hooks/commit-msg"
  chmod +x "$HOME/.ownmind/git-hooks/commit-msg"
  echo "[ OK ] Installed git commit-msg hook (IR-024)"
fi

# 設定 global git hooks path（需要 git 可用）
if command -v git &>/dev/null; then
  git config --global core.hooksPath "$HOME/.ownmind/git-hooks"
  echo "[ OK ] Set git global hooks path: $HOME/.ownmind/git-hooks"
else
  echo "[WARN] git not found, skipping global hooks path"
fi

# --- 4e. Always-on Usage Scanner（P6）---
# 目標：launchd (macOS) / systemd (Linux) 每 30 分鐘自動跑 scanner，
#       不依賴 user 開啟 IDE，確保 coverage panel 不掉單。
# 跳過條件：$HOME/.ownmind/.no-usage-scanner 存在 → opt-out

NO_SCANNER_FLAG="$HOME/.ownmind/.no-usage-scanner"
if [ -f "$NO_SCANNER_FLAG" ]; then
  echo "[INFO] Skipping usage scanner install (.no-usage-scanner opt-out)"
elif [ "$IS_WINDOWS" = true ]; then
  echo "[INFO] Windows: register usage scanner via install.ps1 / Task Scheduler"
else
  echo "[INFO] Installing usage scanner"

  OWNMIND_BIN_DIR="$HOME/.ownmind/bin"
  mkdir -p "$OWNMIND_BIN_DIR"

  # 4e-1 複製 scanner entry + 所有 shared 模組
  #
  # 正常情況下這一整段什麼都不做：OWNMIND_DIR 就是 ~/.ownmind，來源跟目的地是同一個
  # 檔案，safe_cp 用 -ef 比對之後直接跳過。真正把檔案送到位的是上面那個 git clone /
  # git pull。這段是留給 OWNMIND_DIR 不等於 ~/.ownmind 的情況。
  #
  # 用 glob 不用手寫檔名：這裡原本寫死五個檔名，是 2026-04-22 跟用量追蹤一起寫的，
  # 之後 shared/scanners/ 長到十一個檔案都沒有人回來加。手寫清單不會報錯，它只會
  # 安靜地漏。tests/install-scanner-module-list.test.js 盯著這件事。
  safe_cp "$OWNMIND_DIR/hooks/ownmind-usage-scanner.js" "$HOME/.ownmind/hooks/"
  chmod +x "$HOME/.ownmind/hooks/ownmind-usage-scanner.js"
  mkdir -p "$HOME/.ownmind/shared/scanners"
  for f in "$OWNMIND_DIR"/shared/scanners/*.js; do
    [ -f "$f" ] && safe_cp "$f" "$HOME/.ownmind/shared/scanners/"
  done
  # scanner 也依賴 shared/helpers.js（readCredentials、getClientVersion）
  safe_cp "$OWNMIND_DIR/shared/helpers.js" "$HOME/.ownmind/shared/"

  # 4e-2 複製 wrapper script
  safe_cp "$OWNMIND_DIR/scripts/install-helpers/run-scanner.sh" "$OWNMIND_BIN_DIR/"
  chmod +x "$OWNMIND_BIN_DIR/run-scanner.sh"

  # 4e-3 偵測 node 並寫入 .node-path
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [ -z "$NODE_BIN" ]; then
    echo "[WARN] node not found; install Node.js v20+ and retry"
  else
    NODE_VER="$("$NODE_BIN" --version 2>/dev/null || echo "unknown")"
    NODE_MAJOR="$(echo "$NODE_VER" | sed -E 's/^v([0-9]+).*/\1/')"
    if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
      echo "$NODE_BIN" > "$HOME/.ownmind/.node-path"
      echo "[INFO] Using node: $NODE_BIN ($NODE_VER)"
    else
      echo "[WARN] node too old ($NODE_VER); scanner requires v20+. Upgrade and retry"
    fi
  fi

  # 4e-4 安裝排程（macOS launchd / Linux systemd user timer）
  case "$OSTYPE" in
    darwin*)
      LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
      mkdir -p "$LAUNCH_AGENTS"
      PLIST_PATH="$LAUNCH_AGENTS/com.ownmind.usage-scanner.plist"
      # 把 {HOME} 佔位符替換成實際 $HOME
      # v1.26.79 — 兩層跳脫，缺一不可。目標是 XML，所以 & < > 要先變成實體，不然
      # plist 根本無法解析；接著才是 sed 自己的替換語法：`&` 代表「剛才配對到的整段」、
      # 反斜線是跳脫字元、`|` 會提早結束 s 指令。順序不能反：XML 那層產出的 `&amp;`
      # 本身含 `&`，要靠 sed 那層保護。
      HOME_XML=$(printf '%s' "$HOME" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
      HOME_ESCAPED=$(printf '%s' "$HOME_XML" | sed 's/[\\&|]/\\&/g')
      sed "s|{HOME}|$HOME_ESCAPED|g" "$OWNMIND_DIR/scripts/launchd/com.ownmind.usage-scanner.plist" > "$PLIST_PATH"

      # unload 舊的（如果存在）再 load 新的，確保變更生效
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      launchctl load -w "$PLIST_PATH" 2>/dev/null || true

      # v1.26.79 — 問 launchd 一次，不要只信 load 的 exit code。
      # register-scanner-task.ps1 從 v1.17.12 就會驗證自己的成果，macOS 這邊一直沒有。
      # 上面是 unload-then-load：中間失敗就會停在「舊的已刪、新的沒建」，而原本的寫法
      # 只印一行 WARN 到安裝畫面上，之後永遠不會有人發現。Adam 的掃描器就是這樣死了
      # 三個星期（那台是 Windows，同一個形狀）。
      if launchctl list "com.ownmind.usage-scanner" >/dev/null 2>&1; then
        echo "   ✅ launchd agent loaded (30 min interval)"
      else
        echo "[WARN] launchd has no com.ownmind.usage-scanner after loading $PLIST_PATH;"
        echo "       usage collection will not run. Retry: launchctl load -w $PLIST_PATH"
        report_error "scanner_schedule_install_failed" "launchctl list has no com.ownmind.usage-scanner after load" 2>/dev/null || true
      fi
      ;;
    linux*)
      if command -v systemctl &>/dev/null; then
        SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
        mkdir -p "$SYSTEMD_USER_DIR"
        cp "$OWNMIND_DIR/scripts/systemd/ownmind-usage-scanner.service" "$SYSTEMD_USER_DIR/"
        cp "$OWNMIND_DIR/scripts/systemd/ownmind-usage-scanner.timer" "$SYSTEMD_USER_DIR/"

        systemctl --user daemon-reload 2>/dev/null || true
        systemctl --user enable --now ownmind-usage-scanner.timer 2>/dev/null || true

        # v1.26.79 — 同 darwin 分支：問 systemd 一次，不要只信 enable 的 exit code。
        # is-active 跟 is-enabled 問的是兩件事：現在有沒有在跑、重開機後會不會回來。
        # 只有其中一個成立的 timer，等於是一個延後發作的同型缺陷。
        if systemctl --user is-active ownmind-usage-scanner.timer >/dev/null 2>&1 \
           && systemctl --user is-enabled ownmind-usage-scanner.timer >/dev/null 2>&1; then
          echo "   ✅ systemd user timer enabled (30 min interval)"
        else
          echo "[WARN] ownmind-usage-scanner.timer is not both active and enabled;"
          echo "       usage collection will not run. Retry: systemctl --user enable --now ownmind-usage-scanner.timer"
          report_error "scanner_schedule_install_failed" "ownmind-usage-scanner.timer not active+enabled after enable" 2>/dev/null || true
        fi
      else
        echo "[WARN] systemctl not found; configure cron or scheduler manually"
      fi
      ;;
    *)
      echo "[WARN] Unknown OS ($OSTYPE); scanner files installed but auto-schedule not registered"
      ;;
  esac
fi

# --- 5. Cursor 設定（如果有 .cursor 目錄）---
if [ -d "$HOME/.cursor" ] || command -v cursor &>/dev/null; then
  CURSOR_MCP="$HOME/.cursor/mcp.json"
  CURSOR_MCP_WIN="$(to_win_path "$CURSOR_MCP")"
  if [ -f "$CURSOR_MCP" ] && grep -q '"ownmind"' "$CURSOR_MCP" 2>/dev/null; then
    echo "[INFO] Cursor MCP already configured, skipping"
  else
    echo "[INFO] Configuring Cursor MCP"
    if [ -f "$CURSOR_MCP" ]; then
      node -e "
        const fs = require('fs');
        const entry = $MCP_ENTRY;
        const settings = JSON.parse(fs.readFileSync('$CURSOR_MCP_WIN', 'utf8'));
        if (!settings.mcpServers) settings.mcpServers = {};
        settings.mcpServers.ownmind = {
          ...entry,
          env: {
            OWNMIND_API_URL: '$API_URL',
            OWNMIND_API_KEY: '$API_KEY',
            OWNMIND_TOOL: 'cursor'
          }
        };
        fs.writeFileSync('$CURSOR_MCP_WIN', JSON.stringify(settings, null, 2));
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
        const _t2 = '$CURSOR_MCP_WIN' + '.tmp';
        fs.writeFileSync(_t2, JSON.stringify(settings, null, 2));
        fs.renameSync(_t2, '$CURSOR_MCP_WIN');
      "
    fi
  fi

  # Cursor hooks（beforeShellExecution 作為 session-start workaround）
  CURSOR_HOOKS="$HOME/.cursor/hooks.json"
  CURSOR_HOOKS_WIN="$(to_win_path "$CURSOR_HOOKS")"
  if [ -f "$CURSOR_HOOKS" ] && grep -q 'ownmind' "$CURSOR_HOOKS" 2>/dev/null; then
    echo "[INFO] Cursor hooks already configured, skipping"
  else
    echo "[INFO] Configuring Cursor hooks"
    node -e "
      const fs = require('fs');
      const path = '$CURSOR_HOOKS_WIN';
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
    " 2>>"$INSTALL_LOG"
  fi
fi

# --- 6. Gemini CLI 設定（如果有 .gemini 目錄或 gemini 命令）---
if [ -d "$HOME/.gemini" ] || command -v gemini &>/dev/null; then
  echo "[INFO] Configuring Gemini CLI"
  GEMINI_SETTINGS="$HOME/.gemini/settings.json"
  GEMINI_SETTINGS_WIN="$(to_win_path "$GEMINI_SETTINGS")"
  mkdir -p "$HOME/.gemini"

  node -e "
    const fs = require('fs');
    const path = '$GEMINI_SETTINGS_WIN';
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
  " 2>>"$INSTALL_LOG"

  # Gemini GEMINI.md
  GEMINI_MD="$HOME/.gemini/GEMINI.md"
  if [ -f "$GEMINI_MD" ] && grep -q "OwnMind" "$GEMINI_MD" 2>/dev/null; then
    echo "[INFO] GEMINI.md already references OwnMind, skipping"
  else
    echo "[INFO] Updating GEMINI.md"
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
  echo "[INFO] Configuring GitHub Copilot hooks"
  GH_HOOKS_DIR="$HOME/.github/hooks"
  GH_HOOKS_FILE="$GH_HOOKS_DIR/hooks.json"
  GH_HOOKS_FILE_WIN="$(to_win_path "$GH_HOOKS_FILE")"
  mkdir -p "$GH_HOOKS_DIR"

  node -e "
    const fs = require('fs');
    const path = '$GH_HOOKS_FILE_WIN';
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
  " 2>>"$INSTALL_LOG"
fi

# --- 8. Windsurf 設定（如果有 .windsurf 目錄）---
if [ -d "$HOME/.windsurf" ] || [ -d "$HOME/.codeium" ]; then
  echo "[INFO] Configuring Windsurf rules"
  WINDSURF_RULES="$HOME/.windsurf/rules"
  mkdir -p "$WINDSURF_RULES"

  if [ -f "$WINDSURF_RULES/ownmind.md" ] 2>/dev/null; then
    echo "[INFO] Windsurf rules already configured, skipping"
  else
    cp "$OWNMIND_DIR/configs/global_rules.md" "$WINDSURF_RULES/ownmind.md"
    echo "[ OK ] Installed Windsurf OwnMind rules"
  fi
fi

# --- 9. OpenCode 設定 ---
OPENCODE_CONFIG="$HOME/.opencode.json"
OPENCODE_CONFIG_WIN="$(to_win_path "$OPENCODE_CONFIG")"
if [ -f "$OPENCODE_CONFIG" ] || command -v opencode &>/dev/null; then
  echo "[INFO] Configuring OpenCode"
  if [ -f "$OPENCODE_CONFIG" ] && grep -q 'ownmind' "$OPENCODE_CONFIG" 2>/dev/null; then
    echo "[INFO] OpenCode already configured, skipping"
  else
    node -e "
      const fs = require('fs');
      const path = '$OPENCODE_CONFIG_WIN';
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
    " 2>>"$INSTALL_LOG"
    echo "[ OK ] Added OpenCode instructions"
  fi
fi

# --- 10. OpenClaw 設定 ---
OPENCLAW_CONFIG="$HOME/.openclaw.json"
OPENCLAW_CONFIG_WIN="$(to_win_path "$OPENCLAW_CONFIG")"
if [ -f "$OPENCLAW_CONFIG" ] || command -v openclaw &>/dev/null; then
  echo "[INFO] Configuring OpenClaw"
  if [ -f "$OPENCLAW_CONFIG" ] && grep -q 'ownmind' "$OPENCLAW_CONFIG" 2>/dev/null; then
    echo "[INFO] OpenClaw already configured, skipping"
  else
    node -e "
      const fs = require('fs');
      const path = '$OPENCLAW_CONFIG_WIN';
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
    " 2>>"$INSTALL_LOG"
    echo "[ OK ] Added OpenClaw bootstrap"
  fi
fi

# --- 11. Google Antigravity 設定 ---
ANTIGRAVITY_DIR="$HOME/.antigravity"
if [ -d "$ANTIGRAVITY_DIR" ] || command -v antigravity &>/dev/null; then
  echo "[INFO] Configuring Google Antigravity"
  mkdir -p "$ANTIGRAVITY_DIR"
  if [ -f "$ANTIGRAVITY_DIR/rules.md" ] && grep -q 'OwnMind' "$ANTIGRAVITY_DIR/rules.md" 2>/dev/null; then
    echo "[INFO] Antigravity rules already configured, skipping"
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
    echo "[ OK ] Installed Antigravity OwnMind rules"
  fi
fi

echo ""
echo "─────────────────────────────────────────────"
echo "OwnMind installation complete"
echo "─────────────────────────────────────────────"
echo "  MCP Server: $OWNMIND_DIR/mcp/index.js"
echo "  API URL:    $API_URL"
echo "  API Key:    ${API_KEY:0:4}****${API_KEY: -4}"
if [ "$IS_WINDOWS" = true ]; then
echo "  Windows:    MCP launched via cmd.exe + start.cmd"
fi
echo ""
echo "Auto-load configured for detected platforms:"
echo "  [ OK ] Claude Code        SessionStart hook"
{ command -v gemini &>/dev/null || [ -d "$HOME/.gemini" ]; } && echo "  [ OK ] Gemini CLI         SessionStart hook"
{ command -v cursor &>/dev/null || [ -d "$HOME/.cursor" ]; } && echo "  [ OK ] Cursor             session-start hook"
{ command -v gh &>/dev/null || [ -d "$HOME/.github" ]; } && echo "  [ OK ] GitHub Copilot     sessionStart hook"
{ [ -d "$HOME/.windsurf" ] || [ -d "$HOME/.codeium" ]; } && echo "  [ OK ] Windsurf           rules file"
{ [ -f "$HOME/.opencode.json" ] || command -v opencode &>/dev/null; } && echo "  [ OK ] OpenCode           instructions file"
{ [ -f "$HOME/.openclaw.json" ] || command -v openclaw &>/dev/null; } && echo "  [ OK ] OpenClaw           bootstrap file"
{ [ -d "$HOME/.antigravity" ] || command -v antigravity &>/dev/null; } && echo "  [ OK ] Antigravity        rules file"
echo "  [ OK ] Git hooks          pre-commit + post-commit (Iron Rule Verification)"
echo ""

SELF_CHECK_SCRIPT="$OWNMIND_DIR/scripts/install-helpers/self-check.cjs"

# --- v1.26.88: did this run actually finish? ---
# Everything above can abort halfway and leave a machine that reports the right version
# and has none of the parts. See install-artifacts.cjs and bug report #15. This runs
# before the self-check so a truncated install says so in its own words, and the
# self-check then reports the same condition to the server.
ARTIFACT_CHECK="$OWNMIND_DIR/scripts/install-helpers/install-artifacts.cjs"
if [ -f "$ARTIFACT_CHECK" ]; then
  # --home is passed explicitly. Every path this script writes derives from the shell's
  # $HOME, but node resolves os.homedir() from USERPROFILE on Windows and from the passwd
  # entry on POSIX. Under Git Bash those can differ (MSYS2 defaults HOME to /home/<user>),
  # and a mismatch would report all six artifacts missing on a perfectly healthy install.
  if artifact_result=$(node "$ARTIFACT_CHECK" --ownmind-dir "$OWNMIND_DIR" --home "$HOME" 2>&1); then
    echo "[ OK ] $artifact_result"
  else
    # EXIT CODE 2, NOT 1 — deliberately.
    #
    # interactive-upgrade.sh treats a non-zero install.sh as "the install blew up" and calls
    # rollback(), which is `rm -rf ~/.ownmind` + `mv backup ~/.ownmind`. That restores the
    # code and nothing else: ~/.claude/settings.json, the hook scripts, the skill files and
    # git's core.hooksPath all keep the new values. Rolling back here would leave old code
    # wired to new configuration — strictly worse than the truncated install we are
    # reporting, and it cannot create the missing artifacts either way.
    #
    # 2 means "it ran, and it is incomplete". The caller reports it and leaves the machine
    # alone. The self-check below has already told the server, which is how a human hears
    # about it.
    echo "[FAIL] Installation did not complete."
    printf '%s\n' "$artifact_result" | sed 's/^/       /'
    echo "       Log: $INSTALL_LOG"
    report_error "install_incomplete" "$artifact_result" "$INSTALL_LOG" 2>/dev/null || true
    [ -f "$SELF_CHECK_SCRIPT" ] && { node "$SELF_CHECK_SCRIPT" --trigger=post_install || true; }
    exit 2
  fi
fi

# v1.17.63: 跑 self-check 把所有元件的真實狀態抓下來、寫 log + 上傳。
# 包 || true 保證 self-check 出錯不擋安裝完成的訊息。
if [ -f "$SELF_CHECK_SCRIPT" ]; then
  node "$SELF_CHECK_SCRIPT" --trigger=post_install || true
fi

echo "Open a new AI session — OwnMind will auto-load your memory."
echo ""
