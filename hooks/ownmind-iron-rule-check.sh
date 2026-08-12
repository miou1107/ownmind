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
  # v1.26.95: the extra key/value pairs go inside `details`, not alongside it.
  #
  # They used to be written flat — {"ts":…,"event":…,"step":"pull"} — and the upload posts
  # this same object straight to /api/activity/batch, where the handler reads only
  # `e.details`. So every field either hook has ever logged was dropped on arrival and
  # stored as `{}`. Measured 2026-08-07: 18 `update_failed` rows for one user and 9 for
  # another, all with empty details, so nobody could see which step failed. The local file
  # had the answer; the server, where anyone would look, did not.
  # `-gt 1`, not `-gt 0`: `shift 2` with one argument left fails and shifts nothing, so the
  # loop spins forever and the hook never returns — a stalled session with no output at all.
  # Reachable only by a caller passing a key with no value, which none do today; dropping a
  # trailing keyless argument is strictly better than hanging.
  local details=""
  while [ $# -gt 1 ]; do
    # Strip control characters before escaping. A newline or tab in a value produces a line
    # that is not valid JSON, the whole POST body is rejected, and the event disappears —
    # exactly the silent loss this release exists to end. No current caller passes free text,
    # but the obvious next use of this channel is an error message.
    local val=$(printf '%s' "$2" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')
    if [ -n "$details" ]; then details="$details,"; fi
    details="$details\"$1\":\"$val\""
    shift 2
  done
  local entry="{\"ts\":\"$ts\",\"event\":\"$event\",\"tool\":\"claude-code\",\"source\":\"hook\",\"details\":{$details}}"
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
      const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const has = (s.hooks?.SessionStart || []).some(h =>
        h.hooks?.some(hh => (hh.command || '').includes('ownmind'))
      );
      console.log(has ? 'yes' : 'no');
    } catch { console.log('no'); }
  " "$CLAUDE_SETTINGS_WIN")

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
# v1.26.92: two values now come out of the payload, so they are emitted as
#   line 1  → tool_name
#   line 2+ → command
# in that order on purpose. A tool name is a bare identifier and can never contain a
# newline; a command can (git commit -m with a multi-line message), so it has to be the one
# that owns the tail.
PAYLOAD=$(echo "$INPUT" | node -e "
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
    // Non-string values are dropped: a number or object is truthy, would clear the
    // empty-value guard, and would reach grep as '[object Object]'.
    const raw = (p.tool_input && p.tool_input.command) || p.command;
    console.log(typeof p.tool_name === 'string' ? p.tool_name : '');
    console.log(typeof raw === 'string' ? raw : '');
  } catch { console.log(''); console.log(''); }
" 2>/dev/null)

TOOL_NAME=$(printf '%s\n' "$PAYLOAD" | head -1)
COMMAND=$(printf '%s\n' "$PAYLOAD" | tail -n +2)

# v1.26.92: a file-editing tool carries no command, so this used to exit here — which is why
# no rule tagged trigger:edit had ever fired. The edit path is delegated whole to
# ownmind-edit-reminder.js, run by path exactly as ownmind-verify-trigger.js already is
# below, so the one-hour window logic exists once rather than once per hook copy.
# It never blocks: it emits a hookSpecificOutput envelope or nothing.
if [ -z "$COMMAND" ]; then
  case "$TOOL_NAME" in
    Edit|Write|MultiEdit|NotebookEdit)
      # The payload goes in on stdin so the reminder can read session_id: the one-hour
      # window is per session, because the listing exists to put the rules into one AI's
      # context and a second session that never saw them would only be told the count.
      #
      # Failures are recorded rather than dropped. `2>/dev/null` plus `exit 0` is precisely
      # how v1.26.87, v1.26.88 and v1.26.90 each stayed invisible for weeks.
      # stderr stays off stdout: whatever lands on stdout is echoed to Claude Code and has
      # to be the JSON envelope, nothing else. The failure is carried by the exit status.
      EDIT_OUT=$(printf '%s' "$INPUT" | node "$HOME/.ownmind/hooks/ownmind-edit-reminder.js" 2>/dev/null)
      EDIT_STATUS=$?
      if [ "$EDIT_STATUS" -ne 0 ]; then
        log_event "edit_reminder_failed" "status" "$EDIT_STATUS"
      elif [ -n "$EDIT_OUT" ]; then
        echo "$EDIT_OUT"
      fi
      ;;
  esac
  exit 0
fi

# 偵測觸發關鍵字
#
# issue #92 — a line-by-line transcription of detectCommandTrigger in shared/helpers.js,
# in its order. It used to be an independent chain, and by the time anyone compared them 7
# of 17 sample commands were classified differently. install.sh registers this copy on mac
# and Linux, so the drifting half was the half most users were running:
#
#   git tag                 reached no trigger here, so a release tag — the moment the
#                           version-sync rules are written for — was silent
#   docker compose build    likewise, and `push` too: the old deploy pattern was
#   docker compose push     `docker.*up`, which neither contains
#   docker logs backup      matched `docker.*up`, because `backup` contains "up". Reading a
#   docker ps | grep uptime log printed a full deployment rule listing. Same for `uptime`.
#   Remove-Item             absent here, present in the reference
#   deploy && delete        the delete branch was tested first, so a command that deploys
#                           and then tidies up classified as a delete
#
# tests/iron-rule-trigger-parity.test.js runs this file for real and requires every answer
# to match the reference. Editing either side alone now fails there.
#
# Where the two disagreed about something only this copy recognised, the reference is the
# side that moved: `docker.*deploy` became `docker stack deploy` in shared/helpers.js, so a
# Swarm deploy is now a deploy on every platform rather than on half of them.
#
# One pattern is simply gone: `del `, the cmd.exe delete. It cannot appear on the platforms
# this copy runs on, and PowerShell's own name for it — Remove-Item — is matched above.
# Anything else wanted here belongs in shared/helpers.js first; adding it back only here
# rebuilds the drift this change removed.
TRIGGER=""
if echo "$COMMAND" | grep -qiE "\bgit[[:space:]]+(commit|reset|rebase|merge)\b"; then
  TRIGGER="commit"
elif echo "$COMMAND" | grep -qiE "\bgit[[:space:]]+tag\b"; then
  TRIGGER="commit"
elif echo "$COMMAND" | grep -qiE "\bgit[[:space:]]+push\b"; then
  TRIGGER="deploy"
elif echo "$COMMAND" | grep -qiE "\b(docker[[:space:]]+compose[[:space:]]+(up|build|push)|docker[[:space:]]+stack[[:space:]]+deploy|kubectl[[:space:]]+apply|npm[[:space:]]+run[[:space:]]+deploy)\b"; then
  TRIGGER="deploy"
elif echo "$COMMAND" | grep -qiE "\b(rm[[:space:]]+-rf|rmdir|Remove-Item|drop[[:space:]]+table|DELETE[[:space:]]+FROM)\b"; then
  TRIGGER="delete"
# v1.26.132 — install and credential work had no trigger, so the two rules written for it
# could not fire during it. KEEP IN SYNC with detectCommandTrigger in shared/helpers.js.
# `npm install` / `pip install` stay out: this matches a script filename or a key name, and
# neither of those appears in a dependency install.
elif echo "$COMMAND" | grep -qiE "(^|[[:space:]/\\])[[:alnum:]._~-]*(install|setup|bootstrap|update)\.(sh|ps1|bat|cmd)([[:space:]]|$)"; then
  TRIGGER="install"
# Not `\bAPI_KEY\b`: an underscore is a word character, so there is no boundary before the
# `A` in OWNMIND_API_KEY — the prefixed form every real env var uses.
elif echo "$COMMAND" | grep -qiE "(^|[^A-Za-z])API[_-]?KEYS?\b|\bcredentials?\b"; then
  TRIGGER="install"
fi

if [ -z "$TRIGGER" ]; then exit 0; fi

# 從 Claude Code settings.json 取得 API key
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
API_URL=""
API_KEY=""

if [ -f "$CLAUDE_SETTINGS" ]; then
  # v1.26.120 — the path goes in as argv, never interpolated into the source.
  #
  # It used to be spliced into a single-quoted JS string. That is safe only while
  # `to_win_path` returns `cygpath -m` output (forward slashes) — and it silently is not
  # whenever `path-helpers.sh` is missing, because the fallback is a no-op that hands back
  # whatever $HOME held. On Windows that is a backslash path, so `C:Users...` reached the
  # JS parser as escape sequences, the read threw, the catch printed an empty key, and this
  # hook exited 0 without a word. A half-installed machine therefore had no iron-rule check
  # at all and no way to find out. Same class as v1.26.94 and v1.26.112.
  #
  # argv is escape-proof: backslashes, spaces and apostrophes all survive it, which the
  # header of path-helpers.sh already recommended and nothing had adopted here.
  #
  # No `2>/dev/null` here: a redirect that turns a failure into silence is what hid this
  # bug, and the project rule against it is the reason it was found. If node cannot read
  # that file, the reason belongs on stderr,
  # where Claude Code's hook debugging shows it. The empty-value guard below still keeps the
  # hook silent for the ordinary "not configured yet" case.
  API_KEY=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      console.log(s.mcpServers?.ownmind?.env?.OWNMIND_API_KEY || '');
    } catch (e) { console.error('[ownmind] cannot read credentials: ' + e.message); console.log(''); }
  " "$CLAUDE_SETTINGS_WIN")
  API_URL=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      console.log(s.mcpServers?.ownmind?.env?.OWNMIND_API_URL || '');
    } catch { console.log(''); }
  " "$CLAUDE_SETTINGS_WIN")
fi

if [ -z "$API_KEY" ] || [ -z "$API_URL" ]; then exit 0; fi

# 從 OwnMind 取得相關鐵律
#
# v1.26.132 — this fetch used to be `curl -sf --max-time 3 ... 2>/dev/null`, three silencers
# on one line. `-f` returns an empty body on any 4xx/5xx, and an empty RULES is the same
# code path as "no rule matched" — so a dead server, a revoked key and a genuinely quiet
# operation were indistinguishable. A safety mechanism that can switch itself off without a
# word is worse than one that is missing, because a missing one is visible.
#
# The body goes to a file and the status code to a variable, so a failure can be told apart
# from an empty result and recorded. The record goes to the activity log, not to stdout:
# stdout is handed to Claude Code and has to stay a valid envelope.
#
# 3s → 5s: the timeout is a ceiling on how long a reminder may delay a command, but at 3
# seconds an ordinary slow connection dropped the rules by the same silent road.
RULES_BODY=$(mktemp)
RULES_HTTP=$(curl -s --max-time 5 -o "$RULES_BODY" -w '%{http_code}' \
  -H "Authorization: Bearer $API_KEY" "${API_URL}/api/memory/type/iron_rule")
RULES_CURL_EXIT=$?
if [ "$RULES_CURL_EXIT" -ne 0 ]; then
  # Network-level failure: no HTTP status exists. curl's own exit code says which kind
  # (6 = DNS, 7 = refused, 28 = timeout), which is the part worth keeping.
  log_event "iron_rule_fetch_failed" "reason" "curl_exit_${RULES_CURL_EXIT}" "trigger" "$TRIGGER"
elif [ "$RULES_HTTP" != "200" ]; then
  log_event "iron_rule_fetch_failed" "reason" "http_${RULES_HTTP}" "trigger" "$TRIGGER"
fi
RULES=$(node -e "
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
      // v1.26.91: this used to match only 'trigger:' + trigger (plus commit/git), so a rule
      // tagged in any other vocabulary was dropped here and the hook exited without a word.
      // KEEP IN SYNC with TRIGGER_TAG_ALIASES in shared/helpers.js — duplicated on purpose,
      // see the comment there. Widens which rules match; does not widen when this hook runs.
      const ALIASES = {
        edit: ['edit', 'write', '編輯', '寫檔', '改檔', 'modify'],
        commit: ['commit', 'git', '提交', 'checkin'],
        deploy: ['deploy', '部署', 'release', '發布', '上線', 'publish', 'upgrade', '升級'],
        delete: ['delete', '刪除', 'cleanup', '清理', 'rollback', '回滾', '還原', 'restore'],
        install: ['install', 'setup', 'config', '安裝', '設定', 'api_key', 'credential_rotation', '換金鑰', '切換帳號']
      };
      const accepted = new Set((ALIASES[trigger] || [trigger]).map(w => 'trigger:' + w));
      accepted.add('trigger:command');
      const relevant = rules.filter(r => {
        if (!r.tags || r.tags.length === 0) return true;
        return r.tags.some(t => accepted.has(String(t).toLowerCase()));
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
  " < "$RULES_BODY")
# stderr is deliberately not redirected: if node cannot parse what the server sent, the
# reason belongs where Claude Code's hook debugging shows it. Only stdout is read back.
rm -f "$RULES_BODY"

# commit trigger 且無相關 rules：靜默退出
# deploy/delete：即使無 rules 也要跑 verification engine（下方）
if [ -z "$RULES" ] && [ "$TRIGGER" != "deploy" ] && [ "$TRIGGER" != "delete" ]; then
  exit 0
fi

if [ -n "$RULES" ]; then
  log_event "iron_rule_trigger" "trigger" "$TRIGGER"
fi

# For git push: check that git tag matches package.json version.
#
# v1.26.90: this gate compares OwnMind's OWN version against `git tag -l` run in whatever
# directory the user happens to be in. It is a maintainer release gate for the OwnMind
# checkout, and it only ever made sense there. It never ran before this release — the hook
# exited at the empty-command guard on every call — so pushing in any other repository
# would now be blocked with an instruction to create OwnMind's version tag in that repo.
# Scope it to the OwnMind checkout.
REPO_TOP=$(git rev-parse --show-toplevel 2>/dev/null)
OWNMIND_TOP=$(cd "$HOME/.ownmind" 2>/dev/null && pwd -P || echo '')
if [ -n "$REPO_TOP" ]; then REPO_TOP=$(cd "$REPO_TOP" 2>/dev/null && pwd -P || echo "$REPO_TOP"); fi
if echo "$COMMAND" | grep -qiE "git push" && [ -n "$REPO_TOP" ] && [ "$REPO_TOP" = "$OWNMIND_TOP" ]; then
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

# For deploy/delete operations: run verification engine.
#
# v1.26.90: this reports, it does not block. Reason: the engine evaluates
# `metadata.verification` from the local rule cache, and that cache is a mirror of the
# server — the MCP layer overwrites it from the API on init and after every rule mutation.
# A server bug fixed one release earlier (v1.26.89) had been attaching verification
# templates to rules on save, from a weak keyword match, with `block_on_fail: true` on
# every template. v1.26.89 stopped new attachments; it did not clean the ones already
# stored, and there is no supported way for a user to remove one.
#
# Until this release the hook exited at the empty-command guard, so this path had never
# executed for anybody. Restoring the hook restores the blocking too — enforcing conditions
# no user authored, naming a rule unrelated to what they were doing. Measured on one real
# account: 20 of 27 cached rules carry a blocking mark, and `git push` would be stopped by
# six of them, including rules about credential choice and tag naming.
#
# Clearing a local cache does not help: it is refetched from the server. The data has to be
# cleaned server-side, and users need a way to manage these, before enforcement can be
# switched on. Both are recorded in the backlog. The failures are still shown, so nothing
# is hidden — they simply do not abort the command.
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
          const warnTag = '【OwnMind v' + version + '】鐵律提醒（' + trigger + '）';
          lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          lines.push(warnTag);
          lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          (r.failures || []).forEach(f => lines.push('  ⚠️  ' + f));
          lines.push('');
          lines.push('回應格式要求：AI 的第一行必須是「' + warnTag + '」，並說明上面這幾點的狀況。這是提醒，不會擋下 ' + trigger + '。');
          const output = {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: lines.join('\n')
            }
          };
          console.log(JSON.stringify(output));
        } catch { process.exit(0); }
      " "$RULES" 2>/dev/null)
      echo "$BLOCK_CONTEXT"
      exit 0
    fi
  fi
fi

# Output reminder text (commit: always allow; deploy/delete: verification passed)
#
# v1.26.90: wrap it as hookSpecificOutput. A PreToolUse hook that exits 0 has its bare
# stdout shown only in transcript mode — it never reaches the model. The reminder text
# itself ends with 「回應格式要求：AI 的第一行必須是…」, an instruction that could not
# possibly arrive through that channel. The block and version-gate paths in this same file
# already emit the JSON envelope; only the reminder path did not. This was invisible until
# now because the hook exited at the empty-command guard on every call.
if [ -n "$RULES" ]; then
  echo "$RULES" | node -e "
    const d = require('fs').readFileSync(0,'utf8').replace(/\n+\$/, '');
    if (!d) process.exit(0);
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d }
    }));
  " 2>/dev/null
fi

exit 0
