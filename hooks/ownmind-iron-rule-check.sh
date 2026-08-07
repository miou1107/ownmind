#!/bin/bash
# OwnMind Iron Rule Check — Claude Code PreToolUse Hook
# 在執行 git/deploy/delete 等高風險指令前，自動提示相關鐵律
# 附帶：一次性自動升級檢查（搭便車機制）

LOG_DIR="$HOME/.ownmind/logs"

# v1.26.88 — Windows path normalization. Under Git Bash a POSIX path interpolated into
# `node -e` source reaches node.exe unconverted and resolves against the drive root.
# This hook IS installed on Windows (install.sh registers it with no platform branch), so
# without this every credential read below came back empty and the hook exited silently.
if [ -f "$HOME/.ownmind/scripts/install-helpers/path-helpers.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.ownmind/scripts/install-helpers/path-helpers.sh"
else
  to_win_path() { echo "$1"; }
fi
# Assigned here, not next to its first use: the upgrade block near the top reads it too.
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_SETTINGS_WIN="$(to_win_path "$CLAUDE_SETTINGS")"

# 統一從根目錄 package.json 讀取版號（單一來源）
VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.ownmind/package.json','utf8')).version)}catch{console.log('?')}" 2>/dev/null || echo '?')
log_event() {
  local event="$1"; shift
  mkdir -p "$LOG_DIR"
  local ts=$(date +%Y-%m-%dT%H:%M:%S%z | sed 's/\([0-9][0-9]\)$/:\1/')
  local date_str=$(date +%Y-%m-%d)
  local extra=""
  while [ $# -gt 0 ]; do
    local val=$(echo "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')
    extra="$extra,\"$1\":\"$val\""
    shift 2
  done
  local entry="{\"ts\":\"$ts\",\"event\":\"$event\",\"tool\":\"claude-code\",\"source\":\"hook\"$extra}"
  echo "$entry" >> "$LOG_DIR/$date_str.jsonl"
  # Server upload (background)
  if [ -n "$API_KEY" ] && [ -n "$API_URL" ]; then
    curl -sf --max-time 3 -X POST \
      -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
      -d "{\"events\":[$entry]}" \
      "${API_URL}/api/activity/batch" >/dev/null 2>&1 &
  fi
}

# --- 一次性升級：偵測到缺少 SessionStart hook → 自動安裝 ---
UPGRADE_MARKER="$HOME/.ownmind/.session-hook-installed"
if [ ! -f "$UPGRADE_MARKER" ] && [ -d "$HOME/.ownmind/.git" ]; then
  # 檢查 settings.json 是否已有 SessionStart hook
  HAS_SESSION_HOOK=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$CLAUDE_SETTINGS_WIN', 'utf8'));
      const has = (s.hooks?.SessionStart || []).some(h =>
        h.hooks?.some(hh => (hh.command || '').includes('ownmind'))
      );
      console.log(has ? 'yes' : 'no');
    } catch { console.log('no'); }
  " 2>/dev/null)

  if [ "$HAS_SESSION_HOOK" = "no" ]; then
    # 自動升級：pull + update
    (
      cd "$HOME/.ownmind" && \
      git pull -q --rebase 2>/dev/null && \
      cd mcp && npm install -q 2>/dev/null && \
      bash "$HOME/.ownmind/scripts/update.sh" >/dev/null 2>&1
    )
    echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"【OwnMind v${VERSION}】自動升級：已安裝 SessionStart hook，下次開新 session 記憶會自動載入，不用再手動說「載入 OwnMind」。\"}}"
  fi

  # 標記已檢查，不再重複
  touch "$UPGRADE_MARKER"
fi

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | node -e "
  // v1.26.90: read fd 0, not '/dev/stdin'. Windows node resolves that POSIX path to
  // C:\\dev\\stdin and throws ENOENT before the try block, so the extracted command came
  // back empty and this hook exited at the empty-value guard below. Same failure class as
  // the install.sh CLAUDE_SETTINGS path fixed in v1.26.88.
  // NOTE: keep shell variable references out of these comments. The v1.26.88 guard test
  // scans this block for interpolated paths and cannot tell a comment from live source.
  const d = require('fs').readFileSync(0,'utf8');
  try {
    const p = JSON.parse(d);
    // Claude Code sends { tool_name, tool_input: { command } }. Reading a top-level
    // .command yielded undefined on EVERY platform, not just Windows — so even where the
    // stdin read worked, this hook still exited at the empty-value guard on every call.
    // A bare { command } is still accepted so manual invocation keeps working.
    console.log((p.tool_input && p.tool_input.command) || p.command || '');
  } catch { console.log(''); }
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
API_URL=""
API_KEY=""

if [ -f "$CLAUDE_SETTINGS" ]; then
  API_KEY=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$CLAUDE_SETTINGS_WIN', 'utf8'));
      console.log(s.mcpServers?.ownmind?.env?.OWNMIND_API_KEY || '');
    } catch { console.log(''); }
  " 2>/dev/null)
  API_URL=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$CLAUDE_SETTINGS_WIN', 'utf8'));
      console.log(s.mcpServers?.ownmind?.env?.OWNMIND_API_URL || '');
    } catch { console.log(''); }
  " 2>/dev/null)
fi

if [ -z "$API_KEY" ] || [ -z "$API_URL" ]; then exit 0; fi

# 從 OwnMind 取得相關鐵律
RULES=$(curl -sf --max-time 3 -H "Authorization: Bearer $API_KEY" \
  "${API_URL}/api/memory/type/iron_rule" 2>/dev/null | \
  node -e "
    const d = require('fs').readFileSync(0,'utf8');
    const trigger = '$TRIGGER';
    const version = '$VERSION';
    try {
      // v1.26.87: the API wraps responses as { data: [...] }. Calling .filter on
      // the envelope throws, the whole snippet dies, and the surrounding \$( )
      // swallows it — so this hook has been silently producing no reminders.
      // The .js sibling was fixed for this in v1.19.20; this copy was missed.
      const parsed = JSON.parse(d);
      const rules = Array.isArray(parsed) ? parsed : (parsed.data || []);
      const relevant = rules.filter(r => {
        if (!r.tags || r.tags.length === 0) return true;
        return r.tags.some(t =>
          t === 'trigger:' + trigger ||
          (trigger === 'commit' && t === 'trigger:git')
        );
      });
      if (relevant.length === 0) process.exit(0);
      // commit trigger（頻率高）：精簡模式；deploy/delete（頻率低風險高）：完整模式
      if (trigger === 'commit') {
        console.log('【OwnMind v' + version + '】鐵律檢查：commit 操作，' + relevant.length + ' 條規則已確認 ✓');
      } else {
        const tag = '【OwnMind v' + version + '】鐵律觸發（' + trigger + '）';
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(tag);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        relevant.forEach(r => console.log('  ⚠️  ' + (r.code || 'IR-?') + ': ' + r.title));
        console.log('');
        console.log('回應格式要求：AI 的第一行必須是「' + tag + '」，讓使用者看到鐵律觸發。');
      }
    } catch { process.exit(0); }
  " 2>/dev/null)

# commit trigger 且無相關 rules：靜默退出
# deploy/delete：即使無 rules 也要跑 verification engine（下方）
if [ -z "$RULES" ] && [ "$TRIGGER" != "deploy" ] && [ "$TRIGGER" != "delete" ]; then
  exit 0
fi

if [ -n "$RULES" ]; then
  log_event "iron_rule_trigger" "trigger" "$TRIGGER"
fi

# For git push: check that git tag matches package.json version
if echo "$COMMAND" | grep -qiE "git push"; then
  PKG_VER=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.ownmind/package.json','utf8')).version)}catch{console.log('')}" 2>/dev/null)
  if [ -n "$PKG_VER" ]; then
    TAG_EXISTS=$(git tag -l "v${PKG_VER}")
    if [ -z "$TAG_EXISTS" ]; then
      node -e "
        const v = '$VERSION', pv = '$PKG_VER';
        const tag = '【OwnMind v' + v + '】版號卡控';
        const sep = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
        const msg = sep + '\n' + tag + '\n' + sep + '\n  package.json 版號為 ' + pv + '，但沒有對應的 git tag v' + pv + '\n  ❌ 請先執行：git tag v' + pv + '\n  然後再 git push --tags\n\n回應格式要求：AI 的第一行必須是「' + tag + '」。';
        console.log(JSON.stringify({decision:'block',reason:'Missing git tag for version ' + pv,hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:msg}}));
      "
      exit 0
    fi
  fi
fi

# For deploy/delete operations: run verification engine
if [ "$TRIGGER" = "deploy" ] || [ "$TRIGGER" = "delete" ]; then
  VERIFY_RESULT=$(node "$HOME/.ownmind/hooks/ownmind-verify-trigger.js" "$TRIGGER" 2>/dev/null)
  if [ -n "$VERIFY_RESULT" ]; then
    VERIFY_PASS=$(echo "$VERIFY_RESULT" | node -e "
      const d = require('fs').readFileSync(0,'utf8');
      try { console.log(JSON.parse(d).pass ? 'true' : 'false'); } catch { console.log('true'); }
    " 2>/dev/null)
    if [ "$VERIFY_PASS" = "false" ]; then
      BLOCK_CONTEXT=$(echo "$VERIFY_RESULT" | node -e "
        const d = require('fs').readFileSync(0,'utf8');
        const trigger = '$TRIGGER';
        const version = '$VERSION';
        const rules = process.argv[1] || '';
        try {
          const r = JSON.parse(d);
          const lines = [];
          if (rules) lines.push(rules);
          const blockTag = '【OwnMind v' + version + '】鐵律攔截（' + trigger + '）';
          lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          lines.push(blockTag);
          lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          (r.failures || []).forEach(f => lines.push('  ❌ ' + f));
          lines.push('');
          lines.push('回應格式要求：AI 的第一行必須是「' + blockTag + '」，並說明為何被擋下。請先完成上述步驟再執行 ' + trigger + '。');
          const output = {
            decision: 'block',
            reason: 'Iron rule verification failed for ' + trigger + ' operation',
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: lines.join('\n')
            }
          };
          console.log(JSON.stringify(output));
        } catch {
          console.log(JSON.stringify({decision:'block',reason:'Iron rule verification failed'}));
        }
      " "$RULES" 2>/dev/null)
      echo "$BLOCK_CONTEXT"
      exit 0
    fi
  fi
fi

# Output reminder text (commit: always allow; deploy/delete: verification passed)
if [ -n "$RULES" ]; then
  echo "$RULES"
fi

exit 0
