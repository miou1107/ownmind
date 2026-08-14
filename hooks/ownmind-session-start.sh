#!/bin/bash
# OwnMind SessionStart Hook
# 每個新 session 自動檢查更新 + 載入使用者記憶，注入到 AI context

OWNMIND_DIR="$HOME/.ownmind"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
MARKER_FILE="$OWNMIND_DIR/.last-update-check"
LOCK_FILE="$OWNMIND_DIR/.update-lock"
LOG_DIR="$OWNMIND_DIR/logs"
# Same derivation as resolveProjectName() in shared/helpers.js: the working directory's own
# name, and nothing at the home directory or the filesystem root — a basename there would
# describe the machine's owner rather than a project. Control characters and quotes are
# stripped because this value is interpolated into hand-built JSON below.
OWNMIND_PROJECT_DIR_RESOLVED="${CLAUDE_PROJECT_DIR:-${OWNMIND_PROJECT_DIR:-$PWD}}"
OWNMIND_PROJECT_NAME=""
if [ -n "$OWNMIND_PROJECT_DIR_RESOLVED" ] \
   && [ "$OWNMIND_PROJECT_DIR_RESOLVED" != "/" ] \
   && [ "$OWNMIND_PROJECT_DIR_RESOLVED" != "$HOME" ]; then
  OWNMIND_PROJECT_NAME=$(basename "$OWNMIND_PROJECT_DIR_RESOLVED" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')
fi
UPDATE_MSG=""

# v1.26.7 — normalize paths for Node.exe on Windows + Git Bash.
# Without this, $OWNMIND_DIR=/c/Users/<user>/.ownmind makes require() fail with
# MODULE_NOT_FOUND. See path-helpers.sh.
if [ -f "$OWNMIND_DIR/scripts/install-helpers/path-helpers.sh" ]; then
  # shellcheck disable=SC1091
  . "$OWNMIND_DIR/scripts/install-helpers/path-helpers.sh"
else
  to_win_path() { echo "$1"; }
fi
OWNMIND_DIR_WIN="$(to_win_path "$OWNMIND_DIR")"
CLAUDE_SETTINGS_WIN="$(to_win_path "$CLAUDE_SETTINGS")"

# v1.17.71：補印上次 session 因 tty 不可用沒寫成的 banner（規格 #3 不被 AI 過濾）。
# SessionStart 的 stderr → user terminal，是 user-visible 通道。
# JSON Lines format：每行一個 { "ts", "block" } record。
# 單次 spawn node 串流讀整個檔（不在 bash while loop 裡 per-line spawn）—
# 50+ banner 積壓時 per-line spawn 會卡住數秒。
PENDING_BANNER_FILE="$LOG_DIR/banner-pending.jsonl"
SCRIPT_DIR_FOR_FLUSH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# v1.26.129 — run the lib modules out of the checkout, not out of the copy beside this file.
#
# update.sh copies hooks/lib/*.js into ~/.claude/hooks/lib/ and has never copied shared/. So
# any module that imports ../../shared/ resolves to ~/.claude/shared/, which does not exist,
# and dies at load with ERR_MODULE_NOT_FOUND. That is not hypothetical: conditional-sync.js
# imports shared/scanners/base.js, and running the installed copy fails outright — every call
# site here redirects stderr to /dev/null, so it degraded into "no init data" without a word.
# The comment on update.sh's usage-scanner block already says this out loud: anything needing
# shared/ is "kept under $OWNMIND_DIR for execution". This makes the session hook agree.
#
# The checkout has shared/ as a sibling of hooks/, so imports resolve there. Falling back to
# the local copy keeps a machine with no checkout working exactly as it does today.
LIB_DIR="$OWNMIND_DIR/hooks/lib"
# shared/ is the whole reason for the preference, so it is what gets checked.
{ [ -d "$LIB_DIR" ] && [ -d "$OWNMIND_DIR/shared" ]; } || LIB_DIR="$SCRIPT_DIR_FOR_FLUSH/lib"
# v1.26.171: the banner spool is no longer flushed here. Notices are delivered at the turn
# they happen, via systemMessage on the Stop hook's stdout; the spool is an audit record and
# stays on disk (the writer rotates it at 1MB). The old flush piped every stale banner into
# this hook's stdout — which SessionStart feeds to the MODEL, not the user — and then erased
# the file, destroying the audit trail it was supposed to be.

# --- v1.26.172: P1 action gate — session provisioning ---
# The SessionStart payload arrives on stdin (the same contract iron-rule-check.sh reads);
# the lib script parses session_id out of it itself, so the payload is piped through whole.
# This runs before the credential guard on purpose: the gate works off the local
# enforcement cache, so a machine with no API key still gets its signing key, this
# session's nonce, and the gate-current-session pointer the approval CLI reads — plus the
# 30-day sweep of dead per-session state. Failure is a silent skip (the gate CLI
# provisions loudly at first use), and the `-t 0` guard keeps a manual terminal run from
# hanging on a stdin that never closes.
GATE_STDIN_PAYLOAD=""
if [ ! -t 0 ]; then
  GATE_STDIN_PAYLOAD=$(cat 2>/dev/null || true)
fi
printf '%s' "$GATE_STDIN_PAYLOAD" | node "$LIB_DIR/gate-provision.js" >/dev/null 2>&1 || true

# --- Gate message i18n, task 2 of 7: SessionStart OS-locale detection ---
# getLocale() (hooks/lib/locale.js) must stay sync and subprocess-free so it can run on every
# hook message, so this is the one place allowed to shell out for the machine's OS locale,
# once per session. Same pre-credential position and failure shape as gate-provision.js just
# above: local-only, no session id or stdin payload needed, no API key required, and
# `</dev/null` keeps a manual terminal run from inheriting a TTY it never reads from.
node "$LIB_DIR/locale-provision.js" </dev/null >/dev/null 2>&1 || true

# v1.17.97：補送 reply-lint Stop hook 上次 POST 失敗 / 離線時 spool 的合規事件。
# helper 自己處理：沒檔/沒 credentials/POST 失敗 → 留檔等下次；POST 200 → 刪檔。
# 嚴禁外漏 stderr/stdout（user-visible 通道）— helper 內部已做防護、這邊也丟到 /dev/null 雙保險。
COMPLIANCE_SPOOL_FILE="$LOG_DIR/reply-lint-pending.jsonl"
if [ -s "$COMPLIANCE_SPOOL_FILE" ]; then
  node "$LIB_DIR/flush-compliance-spool.js" >/dev/null 2>&1 || true
fi

# --- Log function (local + server) ---
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
  # v1.26.98 — carry the project. A session the server has to rebuild from activity had no
  # way to know which project it belonged to, so the team page showed a blank for anyone
  # whose AI never called ownmind_log_session. Directory name only, never the path.
  if [ -n "${OWNMIND_PROJECT_NAME:-}" ]; then
    if [ -n "$details" ]; then details="$details,"; fi
    details="$details\"project\":\"$OWNMIND_PROJECT_NAME\""
  fi
  local entry="{\"ts\":\"$ts\",\"event\":\"$event\",\"tool\":\"claude-code\",\"source\":\"hook\",\"details\":{$details}}"
  # Local log
  echo "$entry" >> "$LOG_DIR/$date_str.jsonl"
  # Server upload (background, non-blocking)
  if [ -n "$API_KEY" ] && [ -n "$API_URL" ]; then
    curl -sf --max-time 3 -X POST \
      -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
      -d "{\"events\":[$entry]}" \
      "${API_URL}/api/activity/batch" >/dev/null 2>&1 &
  fi
}

# --- 讀取設定（一次 node 呼叫取 KEY + URL）---
# v1.26.82 — this used to read only $CLAUDE_SETTINGS. Claude Code keeps MCP config in
# ~/.claude.json now, and some machines get the key from an OWNMIND_API_KEY environment
# variable instead. On those machines this block came back empty, the `exit 0` below fired
# on every single session, and memories silently never loaded. Now it asks the shared
# resolver, so this hook, the Node hook, the scanner and the self-check cannot disagree.
CREDS_RESOLVER="$OWNMIND_DIR/scripts/install-helpers/resolve-credentials.cjs"
CREDS_RESOLVER_WIN="$(to_win_path "$CREDS_RESOLVER")"
if [ -f "$CREDS_RESOLVER" ]; then
  CREDS=$(node -e "
    try {
      const r = require('$CREDS_RESOLVER_WIN').resolveCredentials();
      console.log((r.apiKey || '') + '\n' + (r.apiUrl || ''));
    } catch { console.log('\n'); }
  " 2>/dev/null)
elif [ -f "$CLAUDE_SETTINGS" ]; then
  # Fallback for the one update that delivers the resolver.
  CREDS=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$CLAUDE_SETTINGS_WIN', 'utf8'));
      const o = s.mcpServers?.ownmind?.env || {};
      console.log((o.OWNMIND_API_KEY || '') + '\n' + (o.OWNMIND_API_URL || ''));
    } catch { console.log('\n'); }
  " 2>/dev/null)
fi
if [ -n "${CREDS:-}" ]; then
  API_KEY=$(echo "$CREDS" | head -1)
  API_URL=$(echo "$CREDS" | tail -1)
fi

if [ -z "$API_KEY" ] || [ -z "$API_URL" ]; then
  exit 0
fi

# --- 自動更新（背景執行，不阻塞 session 啟動）---
#
# v1.26.98 — the lock protocol. This mirrors shared/update-lock.js step for step; that file
# carries the full reasoning, including why a stale lock cannot simply be unlinked. Spawning
# node to take a lock would cost more than the lock saves, hence the duplication; the two are
# run against the same scenarios in tests/update-lock-mutual-exclusion.test.js.

# Age of a file in seconds. Prints nothing and returns non-zero when it is not there.
# stat -f %m = macOS/BSD, stat -c %Y = GNU.
#
# v1.26.107 — the two forms are tried separately and the result is checked for digits,
# because the losing form is not necessarily quiet. `-f` means "format string" on BSD and
# `--file-system` on GNU, so on Linux `stat -f %m` prints a five-line filesystem report to
# **stdout** before exiting non-zero, and a `A || B` chain then appends B's answer
# underneath it. The variable ends up holding the report, a newline, and the correct epoch,
# and the arithmetic below dies with "syntax error in expression". The comment above already
# named the difference; the code assumed one side would fail silently, and `2>/dev/null`
# only ever covered stderr.
#
# The `|| echo 0` fallback this used to carry is deliberately gone. It made an unreadable
# mtime mean "infinitely old", so a lock nobody could stat was reclaimed by everybody at
# once. Failing closed instead means an unreadable lock is never reclaimed; on every
# platform this script runs on, one of the two `stat` forms works.
lock_age_seconds() {
  [ -f "$1" ] || return 1
  local mtime
  mtime=$(stat -c %Y "$1" 2>/dev/null)
  case "$mtime" in
    ''|*[!0-9]*) mtime=$(stat -f %m "$1" 2>/dev/null) ;;
  esac
  case "$mtime" in
    ''|*[!0-9]*)
      # Each `2>/dev/null` above covers exactly one expected message: the form that is wrong
      # for this platform objecting to its own flag, on every call of every session. A
      # machine where *neither* form works is a different thing and must not be silent —
      # returning non-zero with no explanation is how the defect above stayed invisible for
      # nine releases. The caller still fails closed; it just says why first.
      echo "ownmind: cannot read the mtime of $1 — neither 'stat -c %Y' (GNU) nor 'stat -f %m' (BSD) returned an integer; the update lock cannot be aged on this machine" >&2
      return 1
      ;;
  esac
  echo $(( $(date +%s) - mtime ))
}

# Create a file only if it does not exist, stamping $2 into it. `set -C` (noclobber) makes
# the redirect O_CREAT|O_EXCL, so exactly one process out of any number can succeed. The
# subshell keeps noclobber from leaking into the rest of the hook.
create_exclusive() {
  # v1.26.145 — a token that could not be written takes the file with it.
  #
  # `set -C` makes the redirect O_CREAT|O_EXCL, so the file exists the moment the redirect
  # succeeds — before `printf` has written anything. If the write then fails (a full disk, a
  # quota), the subshell reports failure and an *empty* file is left at that path. Every
  # ownership check treats an empty file as somebody else's, so the process that created it
  # will not remove it either, and it sits there until the leaked-marker path clears it ten
  # minutes later. Reproduced under `ulimit -f 0`.
  # The create and the write are separate commands so that failure can be told apart. Doing
  # both in one subshell reports the same non-zero for "somebody else already has it" and
  # "the disk is full", and the only way to tell them apart afterwards is to look at what is
  # at the path — where an empty file is just as likely to be another process's marker
  # between its own create and its own write. Guessing there deletes somebody's live marker,
  # which is the defect this release exists to fix.
  ( set -C; : > "$1" ) 2>/dev/null || return 1   # lost the exclusive create; not ours
  [ -n "${2:-}" ] || return 0
  printf '%s' "$2" > "$1" 2>/dev/null && return 0
  # Ours, and unusable: every ownership check reads an empty file as somebody else's, so
  # leaving it would strand a marker nobody will remove until it ages out.
  rm -f "$1"
  return 1
}

# Is the file at $1 still the one that wrote $2? `read` rather than $(cat …): every caller
# uses this immediately before deleting something, and a fork is exactly the gap that makes
# the deletion land on a file that arrived in the meantime.
marker_is_ours() {
  local cur=''
  # An empty token would match an empty file, and an empty file is what a marker looks like
  # between being created and being written — so a degenerate token turns this check inside
  # out and licenses deleting somebody else's lock. No caller can produce one ($$ is always
  # set), which is exactly why it would go unnoticed if one ever could.
  [ -n "$2" ] || return 1
  # The redirect is grouped, not trailing. `read -r cur < "$1" 2>/dev/null` applies the
  # redirections left to right, so the failure to open a missing file happens before stderr
  # has been pointed anywhere — and this function is called precisely when the file may have
  # just been deleted. Measured: the trailing form prints "No such file or directory" to the
  # user's terminal on exactly the race path it exists to handle.
  { read -r cur < "$1"; } 2>/dev/null
  [ "$cur" = "$2" ]
}

# Take the update lock. Returns non-zero when somebody else holds it.
#
# Mirrors shared/update-lock.js; that file explains why reclaiming a stale lock takes four
# steps rather than one. In short: deleting a path and re-creating it cannot be made atomic,
# so removal is serialised behind a marker, the marker's holder proves the marker is still
# its own before deleting anything, the deleter re-reads the age, and the winner then checks
# that the file at the path is still the one it created.
#
# What shipped before was `[ ! -f "$LOCK_FILE" ]` ten lines above a `touch`, which is not a
# lock twice over: the test and the create are far apart, and `touch` succeeds on a file that
# already exists. Measured 2026-08-07 — four hooks racing, four winners, every morning.
# v1.26.142 — 600, not 300. Kept identical to STALE_MS in shared/update-lock.js: two
# implementations of one protocol that disagree about when a lock is dead is a protocol
# where each one reclaims the other's live lock. The upgrade's own worst case is 280
# seconds of legitimate work, which left twenty seconds of headroom, and the scheduled
# scanner became a fourth contender running every two hours on every machine.
LOCK_STALE_SECONDS=600

acquire_update_lock() {
  # Defaulted in place as well as set at file scope, so the function stays correct when it
  # is lifted out on its own — which the concurrency tests do, and which is the only way to
  # run eight of these against one lock. Without the default the comparisons below get an
  # empty string and bash answers "integer expression expected" for every contender, so
  # nobody acquires and nobody reclaims.
  local stale="${LOCK_STALE_SECONDS:-600}"
  local age rage dage token rtoken reclaim="$LOCK_FILE.reclaim"

  age=$(lock_age_seconds "$LOCK_FILE")
  if [ -n "$age" ] && [ "$age" -gt "$stale" ]; then
    # Stale: the run that took it died. Deletion is serialised behind its own exclusive file,
    # otherwise two processes both delete and both create, and both think they hold it.
    rage=$(lock_age_seconds "$reclaim")
    if [ -n "$rage" ] && [ "$rage" -gt "$stale" ]; then
      # Clearing a leaked marker is itself a delete-and-recreate, so it gets the same
      # treatment: move it aside under a name only this process uses, and whoever loses the
      # move skips this round rather than racing for it.
      if mv "$reclaim" "$reclaim.dead.$$" 2>/dev/null; then
        # v1.26.111 — what got moved is not necessarily what was measured. Between the read
        # above and this rename, another process can win the same move, clear it, and create
        # its own fresh marker; the rename then succeeds on that one. Both processes are now
        # inside the reclaim section, and the age re-read below only protects the first one's
        # new lock if it happens after that lock exists. So check what was actually taken:
        # a fresh marker means somebody is reclaiming right now, and this call stands down.
        #
        # v1.26.145 — standing down is not enough, because the marker this call just deleted
        # may have been a live one. The marker IS the mutex, so deleting somebody's live one
        # leaves them inside the section with nothing guarding the door. Measured 2026-08-11,
        # sixteen contenders under load: three processes inside at once, two reaching `WIN`.
        #
        #   17460 ENTER reclaim section
        #   17530 moved a fresh marker -> stand down    <- deleted 17460's live marker
        #   17516 ENTER reclaim section                 <- nothing left to stop it
        #   17460 RM   17516 RM   17572 created/verify  <- 17572 holds the lock
        #   17460 created/verify                        <- and so does 17460
        #
        # Putting the marker back was tried and measured worse than the bug (45 double
        # acquires in 120 rounds against 5): a restore is a second window in which the mutex
        # is absent. What works is the other end — the occupant checks that the marker is
        # still its own immediately before it deletes anything (see below). This deletion
        # therefore stays, and is now detected rather than prevented.
        dage=$(lock_age_seconds "$reclaim.dead.$$")
        rm -f "$reclaim.dead.$$"
        if [ -z "$dage" ] || [ "$dage" -le "$stale" ]; then return 1; fi
      else
        return 1
      fi
    fi
    rtoken="$$-$(date +%s)-${RANDOM}${RANDOM}"
    if create_exclusive "$reclaim" "$rtoken"; then
      # Re-read the age now that we are the only reclaimer: an earlier winner may already
      # have put a fresh lock here, and deleting that is exactly the bug being fixed.
      age=$(lock_age_seconds "$LOCK_FILE")
      # ...and re-check that we still ARE the only reclaimer. The marker is this section's
      # mutex, and it can be taken away: a cleanup that mistook it for a leaked one deletes
      # it, and another occupant's exit deletes it. Either way the door is open behind us and
      # the age above was read in a section we no longer hold.
      # `read`, not `$(cat ...)`: a fork here is the gap this check exists to close.
      #
      # Ownership is checked LAST, so that nothing at all runs between it and the `rm`. The
      # two `[` builtins are cheap, but they are still instructions the scheduler can preempt
      # between, and everything this check buys is spent in that interval. Same order as
      # `reclaimIfStale` in shared/update-lock.js — the two halves of one protocol have
      # to hold the same guard with the same exposure, or they disagree about who holds it.
      [ -n "$age" ] && [ "$age" -gt "$stale" ] \
        && marker_is_ours "$reclaim" "$rtoken" && rm -f "$LOCK_FILE"
      # Only ever remove a marker that is still ours — removing somebody else's is how the
      # mutex evaporated in the first place.
      marker_is_ours "$reclaim" "$rtoken" && rm -f "$reclaim"
    fi
  fi

  # A value only this call writes, so the check below compares our lock against whatever is
  # actually at that path — not the path against itself, which would always agree.
  token="$$-$(date +%s)-${RANDOM}${RANDOM}"
  create_exclusive "$LOCK_FILE" "$token" || return 1

  # Did somebody delete the lock we just made and put their own there? Then they hold it,
  # not us. Same check as the marker's, through the same function: two spellings of one rule
  # is two things to keep in step, and they would already disagree about a file with
  # trailing content.
  marker_is_ours "$LOCK_FILE" "$token"
}

# v1.26.129: queue what the background update did, so the next session can tell the user.
# The message text lives in shared/update-banner.js — written once, not once per language.
queue_update_banner() {
  node "$LIB_DIR/queue-update-banner.js" "$1" "$2" >/dev/null 2>&1 || true
}

if [ -d "$OWNMIND_DIR/.git" ]; then
  TODAY=$(date +%Y-%m-%d)
  LAST_CHECK=$(cat "$MARKER_FILE" 2>/dev/null || echo "")

  # The marker is checked first because it is the common case and costs only a read. The lock
  # is taken before anything is logged, so the log shows one check rather than a stampede of
  # four.
  UPDATE_LOCK_TAKEN=""
  if [ "$LAST_CHECK" != "$TODAY" ]; then
    if acquire_update_lock; then
      UPDATE_LOCK_TAKEN=1
    elif [ -f "$LOCK_FILE" ]; then
      # Somebody else — another hook, or the MCP — is already doing it. That is not a failed
      # upgrade: the work is happening, just not here. Recording it as `update_failed` is what
      # put 18 phantom failures on one account across six days and sent us looking for a fault
      # that did not exist. Same event name and reason the MCP uses for this case.
      log_event "update_skipped" "reason" "lock_held"
    elif acquire_update_lock; then
      # No lock file, yet the create failed a moment ago: the holder released it in between.
      # Retrying once tells that apart from a genuine write failure, rather than reporting a
      # phantom failure — which is the whole point of this release.
      UPDATE_LOCK_TAKEN=1
    else
      # The create failed and there is no lock file to account for it: a read-only filesystem
      # or a full disk. `set -C` cannot report an errno, so presence of the file is the only
      # way to tell the two apart here — the MCP, which can read the errno, makes the same
      # distinction. This case is a real failure and has to stay visible; keeping it is why
      # the branch logged anything in the first place.
      log_event "update_failed" "step" "lock"
      queue_update_banner failed lock
    fi
  fi

  if [ -n "$UPDATE_LOCK_TAKEN" ]; then
    log_event "update_check"
    # 背景執行更新，不阻塞記憶載入
    # P3 修正（Bob case 2026-04-26）：原本 silent 吞失敗後無條件寫 update_applied，
    # 即使 git pull / npm / update.sh 任一失敗都會誤報「已更新」。對齊 mcp/index.js
    # 的修法：每步顯式檢查；分流寫 update_applied / update_clean / update_failed。
    (
      cd "$OWNMIND_DIR" || { rm -f "$LOCK_FILE"; log_event "update_failed" "step" "cd"; queue_update_banner failed cd; exit 0; }
      if ! git fetch -q 2>/dev/null; then
        rm -f "$LOCK_FILE"
        log_event "update_failed" "step" "fetch"
        queue_update_banner failed fetch
        exit 0
      fi
      UPDATES=$(git log HEAD..origin/main --oneline 2>/dev/null)
      if [ -n "$UPDATES" ]; then
        # v1.26.144 — this was `git stash -q` followed by a pull, with no `stash pop` on any
        # path out of this block, including the successful one. Whatever the user had
        # uncommitted went into the stash and stayed there. v1.17.22 shipped exactly this
        # bug in the MCP and it is what made uncommitted work disappear; the fix landed
        # there and never reached here.
        #
        # Measured on one machine on 2026-08-11: 30 stash entries, one per upgrade back to
        # v1.17.x. They were mode changes rather than anybody's work, because the installer
        # chmods a file committed 644 — but the mechanism does not know the difference, and
        # the day it holds a real edit it keeps it.
        #
        # `--autostash` is the operation that stashes *and* puts it back, and it is what
        # shared/auto-update.js already uses. The fallback deliberately omits it: on git
        # older than 2.6 the flag is unknown, and `--ff-only` refuses a dirty tree rather
        # than touching it, which is the safe way to decline.
        if ! { git pull -q --rebase --autostash 2>/dev/null || git pull -q --ff-only 2>/dev/null; }; then
          rm -f "$LOCK_FILE"
          log_event "update_failed" "step" "pull"
          queue_update_banner failed pull
          exit 0
        fi
        if ! ( cd "$OWNMIND_DIR/mcp" && npm install -q 2>/dev/null ); then
          rm -f "$LOCK_FILE"
          log_event "update_failed" "step" "npm"
          queue_update_banner failed npm
          exit 0
        fi
        if ! bash "$OWNMIND_DIR/scripts/update.sh" >/dev/null 2>&1; then
          rm -f "$LOCK_FILE"
          log_event "update_failed" "step" "update_sh"
          queue_update_banner failed update_sh
          exit 0
        fi
        log_event "update_applied"
        # No version argument: the shim reads package.json off disk itself. That read has to
        # happen after the pull — a value captured any earlier names the version the user was
        # leaving, not the one they just got.
        queue_update_banner applied
      else
        log_event "update_clean"
      fi
      echo "$TODAY" > "$MARKER_FILE"
      rm -f "$LOCK_FILE"
    ) &
  fi
fi

# v1.17.86 觀測性收尾：drain .upload-spool.jsonl（v1.17.85 reviewer I1 + fixture/prod mismatch 同類雷收尾）
# 場景：升級成功末段的 upgrade_complete beacon / post_upgrade self-check 上傳失敗時
# 寫進 .upload-spool.jsonl，原本要等下次 self-check.cjs 才 drain。但若 user 升完就
# quit Claude Code，永遠沒下次 self-check 來觸發 → spool 卡在他本機、server 永遠
# 看不到 user 升上去了。
# 改在 SessionStart 也跑 drain — 任何新 Claude Code session 起來都 retry 一次、
# 縮短「user 升完 → server 看到」的延遲到「下次開 Claude Code」即可。
# Fire-and-forget、3 秒 timeout、絕不擋 SessionStart。
SELF_CHECK_SCRIPT="$OWNMIND_DIR/scripts/install-helpers/self-check.cjs"
SELF_CHECK_SCRIPT_WIN="$(to_win_path "$SELF_CHECK_SCRIPT")"
if [ -f "$SELF_CHECK_SCRIPT" ] && [ -n "$API_KEY" ] && [ -n "$API_URL" ]; then
  timeout 3 node -e "
    const sc = require('$SELF_CHECK_SCRIPT_WIN');
    if (sc.retrySpool) {
      sc.retrySpool('$API_URL', '$API_KEY').catch(() => {});
    }
  " >/dev/null 2>&1 &
fi

# --- v1.18.0: Conditional sync — 用 sync_token 跳過 99% sessions 的 download ---
# helper 流程：
#   1. 讀 ~/.ownmind/cache/memories.json (sync_token + saved_at)
#   2. 24hr 過期 → 強制走全量 init
#   3. 否則 GET /sync-token (~50 bytes) 比對
#   4. 相同 → 跳過 init download、用 cache (~95% sessions 走這條)
#   5. 不同 → 全量 init + 寫新 cache + 重寫 ~/.claude/skills/ownmind-iron-rules/
# helper 內建 fallback：fetch 失敗 → 用 cache、cache 也沒 → 印空 string
INIT_DATA=$(timeout 10 node "$LIB_DIR/conditional-sync-cli.js" \
  "$API_URL" "$API_KEY" 2>/dev/null)

if [ -z "$INIT_DATA" ]; then
  # conditional-sync 完全失敗（無網 + 無 cache）→ fallback 到 v1.17.x 直接 curl
  INIT_DATA=$(curl -sf --max-time 5 \
    -H "Authorization: Bearer $API_KEY" \
    "${API_URL}/api/memory/init?compact=true" 2>/dev/null)
fi

if [ -z "$INIT_DATA" ]; then
  log_event "init_fail" "status" "api_timeout"
  exit 0
fi

log_event "init" "status" "ok"

# --- v1.17.0 P3: 抓當前應顯示的廣播（fail-silent，不擋 SessionStart）---
# v1.17.18: 帶 client_version 讓 server semver filter 生效
# （否則 broadcast-filter.js 的 min/max_version 過濾會跳過 → 已升級用戶仍見舊升級廣播）
CLIENT_VERSION=$(node -p "require('$OWNMIND_DIR_WIN/package.json').version" 2>/dev/null || echo "")
BROADCAST_URL="${API_URL}/api/broadcast/active?tool=claude-code"
if [ -n "$CLIENT_VERSION" ]; then
  BROADCAST_URL="${BROADCAST_URL}&client_version=${CLIENT_VERSION}"
  BROADCAST_DATA=$(curl -sf --max-time 3 \
    -H "Authorization: Bearer $API_KEY" \
    -H "X-Ownmind-Version: ${CLIENT_VERSION}" \
    "${BROADCAST_URL}" 2>/dev/null)
else
  BROADCAST_DATA=$(curl -sf --max-time 3 \
    -H "Authorization: Bearer $API_KEY" \
    "${BROADCAST_URL}" 2>/dev/null)
fi
# 空值 / 失敗一律當 "[]"（就是沒廣播）
[ -z "$BROADCAST_DATA" ] && BROADCAST_DATA="[]"

# --- 解析記憶 + 廣播 + 輸出 JSON ---
# render 邏輯拆到 hooks/lib/render-session-context.js（可被 unit test）
node "$LIB_DIR/session-start-output.js" "$INIT_DATA" "$BROADCAST_DATA" 2>/dev/null

# --- v1.17.8: delta sync 本地記憶 md 檔（A+C 方案，不阻塞，fail-silent）---
# 把雲端 iron_rule/project/feedback 同步到 $CLAUDE_PROJECT_DIR 的 auto-memory dir，
# 避免 AI 讀到過期快照。CLAUDE_PROJECT_DIR 未設時 node script 自己 exit 0。
if [ -n "$CLAUDE_PROJECT_DIR" ]; then
  SYNC_DATA=$(curl -sf --max-time 4 \
    -H "Authorization: Bearer $API_KEY" \
    "${API_URL}/api/memory/sync?types=iron_rule,project,feedback" 2>/dev/null)
  if [ -n "$SYNC_DATA" ]; then
    echo "$SYNC_DATA" | node "$LIB_DIR/sync-memory-files.js" 2>/dev/null
  else
    node "$LIB_DIR/sync-memory-files.js" --fail 2>/dev/null
    log_event "memory_sync_fail"
  fi
fi

exit 0
