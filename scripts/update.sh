#!/bin/bash
# OwnMind sync update script — light sync only
#
# ⚠️ This script only syncs skills / hooks / settings — it is NOT a full upgrade flow.
#    For OwnMind version upgrades, run:
#       bash ~/.ownmind/scripts/bootstrap.sh
#    bootstrap automatically detects install / upgrade / repair and dispatches.
#
# Use case: after `git pull` or at the tail of install.sh, syncs files in ~/.ownmind/
# into each tool's directory.
# v1.17.81 added an observability pipeline (IR-038): update_started beacon + report-error,
# matching install / upgrade.

OWNMIND_DIR="$HOME/.ownmind"

# v1.17.81 — load report-error helper.
if [ -f "$OWNMIND_DIR/scripts/install-helpers/report-error.sh" ]; then
  # shellcheck disable=SC1090
  . "$OWNMIND_DIR/scripts/install-helpers/report-error.sh"
else
  report_error() { :; }
fi

# v1.26.88 — Windows path normalization. Under Git Bash a POSIX path interpolated into
# `node -e` / `node -p` source reaches node.exe unconverted and resolves against the drive
# root. See install.sh and path-helpers.sh; bug report #15 (2026-08-06).
if [ -f "$OWNMIND_DIR/scripts/install-helpers/path-helpers.sh" ]; then
  # shellcheck disable=SC1091
  . "$OWNMIND_DIR/scripts/install-helpers/path-helpers.sh"
else
  to_win_path() { echo "$1"; }
fi
OWNMIND_DIR_WIN="$(to_win_path "$OWNMIND_DIR")"

# The log directory has to exist before anything below redirects into it. A failed `2>>`
# makes the command itself fail, which would turn "no log directory" into "the beacon
# never sends" — the same class of silent breakage this release is about. Created again
# further down for the same reason; both are idempotent.
mkdir -p "${HOME}/.ownmind/logs" 2>/dev/null || true

# v1.17.81 — update_started beacon (fire-and-forget + spool fallback).
send_update_beacon() {
  local trigger="$1"
  local claude_settings
  claude_settings="$(to_win_path "$HOME/.claude/settings.json")"
  [ -f "$HOME/.claude/settings.json" ] || return
  local api_key api_url
  api_key=$(node -p "try { require('$claude_settings').mcpServers.ownmind.env.OWNMIND_API_KEY } catch { '' }" 2>>"${HOME}/.ownmind/logs/update-err.log")
  api_url=$(node -p "try { require('$claude_settings').mcpServers.ownmind.env.OWNMIND_API_URL } catch { '' }" 2>>"${HOME}/.ownmind/logs/update-err.log")
  [ -n "$api_key" ] && [ -n "$api_url" ] || return
  local ts machine platform body
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  machine="$(hostname 2>/dev/null || echo unknown)"
  case "$OSTYPE" in
    darwin*) platform='darwin' ;;
    linux*) platform='linux' ;;
    msys*|cygwin*|win32*) platform='win32' ;;
    *) platform="$OSTYPE" ;;
  esac
  body=$(printf '{"ts":"%s","trigger":"%s","client_version":"update-script","platform":"%s","machine":"%s"}' \
    "$ts" "$trigger" "$platform" "$machine")
  if curl -fsS -m 5 -X POST \
    -H "Authorization: Bearer $api_key" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${api_url%/}/api/debug/install-check" >/dev/null 2>&1; then
    return
  fi
  # spool fallback (same as v1.17.80)
  local spool_dir="${HOME}/.ownmind/logs"
  mkdir -p "$spool_dir" 2>/dev/null || return
  printf '%s\n' "$body" >> "${spool_dir}/.upload-spool.jsonl" 2>/dev/null || true
}
send_update_beacon 'update_started'

echo "OwnMind sync (light path)"
echo "─────────────────────────────────────────────"

# --- 0. Root-level dependencies ---
# install.sh and interactive-upgrade.sh only run `npm install` inside ~/.ownmind/mcp/,
# so these explicit installs are the only path by which a root dependency reaches a
# user machine.
#
# v1.26.41: the guard used to be "does node_modules/<pkg> exist?", which meant a
# package was never touched again once present, so js-yaml stayed at 4.1.1 on
# machines carrying CVE-2026-59869. The install command was never the problem:
# `npm install js-yaml@^4.1.1` re-resolves and installs 4.3.0 even against a lock
# pinning 4.1.1. The guard simply never let it run. Gate on the installed version
# instead, so raising a floor here actually pushes the upgrade out.
#
# Anything unreadable counts as "below the floor" and triggers a reinstall: a
# missing helper, a missing node, a corrupt manifest. The cost is a redundant
# idempotent install; the cost of guessing the other way is a patch that never
# arrives. node's own diagnostics go to the update log rather than /dev/null so a
# permanently broken node leaves a trace instead of silently reinstalling forever.
#
# The log directory is created here rather than assumed. send_update_beacon above
# only creates it on its spool fallback, so on a machine whose beacon succeeds it
# may not exist — and a failed `2>>` redirect would make this function report
# "needs install" on every single sync. The npm install redirects below have
# depended on the same directory since v1.18.5.
mkdir -p "${HOME}/.ownmind/logs" 2>/dev/null || true

needs_root_dep() {
  ! node "$OWNMIND_DIR/scripts/install-helpers/dep-floor-cli.mjs" "$OWNMIND_DIR" "$1" "$2" \
    >/dev/null 2>>"${HOME}/.ownmind/logs/update-err.log"
}

# v1.18.5: conditional-sync-cli.js needs js-yaml. Without it the module fails to load
# with ERR_MODULE_NOT_FOUND, the SessionStart hook silently fails, and the big skill
# (~/.claude/skills/ownmind-iron-rules/) stops updating.
# Floor 4.3.1 — CVE-2026-59869 (quadratic CPU via YAML merge-key chains) plus the
# 4.3.1 backport of the same shape in `!!omap` duplicate-key detection. Reachable
# because iron-rule frontmatter is parsed on this machine and shared team standards
# come from other accounts. Keep this in step with package.json: dep-floor-guard
# turns red when this floor drops below the one package.json declares.
if needs_root_dep js-yaml 4.3.1; then
  echo "   📦 Installing / updating conditional-sync dependency: js-yaml..."
  (cd "$OWNMIND_DIR" && npm install js-yaml@^4.3.1 --no-save --silent --no-audit --no-fund 2>>"${HOME}/.ownmind/logs/update-err.log") \
    && echo "   ✅ js-yaml ready" \
    || echo "   ⚠️ js-yaml install failed (see ~/.ownmind/logs/update-err.log); big skill sync will fall back to skip — other features unaffected"
fi

# v1.19.14: device-fingerprint needs node-machine-id. Uses OS-level machine identifiers
# for a stable "same machine" identifier, replacing the v3 "hostname + MAC" design that
# was unstable under Docker / VPN.
if needs_root_dep node-machine-id 1.1.12; then
  echo "   📦 Installing / updating bug-report-tool dependency: node-machine-id..."
  (cd "$OWNMIND_DIR" && npm install node-machine-id@^1.1.12 --no-save --silent --no-audit --no-fund 2>>"${HOME}/.ownmind/logs/update-err.log") \
    && echo "   ✅ node-machine-id ready" \
    || echo "   ⚠️ node-machine-id install failed; ownmind_report_bug will use a fallback fingerprint (less stable, still functional)"
fi

# --- 1. Sync Claude Code skills ---
if [ -d "$HOME/.claude" ]; then
  mkdir -p "$HOME/.claude/skills/ownmind-memory"
  cp "$OWNMIND_DIR/skills/ownmind-memory.md" "$HOME/.claude/skills/ownmind-memory/SKILL.md"
  # v1.17.0 P7: upgrade skill
  if [ -f "$OWNMIND_DIR/skills/ownmind-upgrade.md" ]; then
    mkdir -p "$HOME/.claude/skills/ownmind-upgrade"
    cp "$OWNMIND_DIR/skills/ownmind-upgrade.md" "$HOME/.claude/skills/ownmind-upgrade/SKILL.md"
  fi
  echo "[ OK ] Skills synced (ownmind-memory + ownmind-upgrade)"
fi

# --- 1b. Sync upgrade rules to other AI tools (skip ones that aren't installed) ---
UPGRADE_SNIPPET="$OWNMIND_DIR/skills/ownmind-upgrade-agents-snippet.md"
if [ -f "$UPGRADE_SNIPPET" ]; then
  append_rule() {
    local target_file="$1"
    if [ -d "$(dirname "$target_file")" ]; then
      mkdir -p "$(dirname "$target_file")"
      if [ -f "$target_file" ]; then
        node -e "
          const fs = require('fs');
          const p = process.argv[1];
          let c = fs.readFileSync(p, 'utf8');
          c = c.replace(/<!--\\s*ownmind-upgrade-rule\\s*-->[\\s\\S]*?<!--\\s*\\/ownmind-upgrade-rule\\s*-->\\n?/g, '');
          fs.writeFileSync(p, c);
        " "$(to_win_path "$target_file")" 2>>"${HOME}/.ownmind/logs/update-err.log" || true
      fi
      { echo ''; echo '<!-- ownmind-upgrade-rule -->'; cat "$UPGRADE_SNIPPET"; echo '<!-- /ownmind-upgrade-rule -->'; } >> "$target_file"
    fi
  }
  append_rule "$HOME/.codex/AGENTS.md"
  append_rule "$HOME/.cursor/rules/ownmind.md"
  append_rule "$HOME/.antigravity/rules/ownmind.md"
  append_rule "$HOME/.opencode/AGENTS.md"
  append_rule "$HOME/.windsurf/rules/ownmind.md"
  append_rule "$HOME/.gemini/GEMINI.md"
  echo "[ OK ] Upgrade rules synced to detected AI tools"
fi

# --- 2. Sync hook scripts + hooks/lib modules ---
if [ -d "$HOME/.claude" ]; then
  HOOK_DIR="$HOME/.claude/hooks"
  mkdir -p "$HOOK_DIR/lib"
  for hook_file in "$OWNMIND_DIR/hooks/"*.sh; do
    if [ -f "$hook_file" ]; then
      cp "$hook_file" "$HOOK_DIR/"
      chmod +x "$HOOK_DIR/$(basename "$hook_file")"
    fi
  done
  # v1.17.0 P3: the SessionStart hook needs the render module under lib/.
  if [ -d "$OWNMIND_DIR/hooks/lib" ]; then
    cp "$OWNMIND_DIR/hooks/lib/"*.js "$HOOK_DIR/lib/" 2>/dev/null || true
  fi
  echo "[ OK ] Hook scripts synced"
fi

# --- 2a2. Reinstall the git hook wrappers (v1.26.104), stripping CR (v1.26.96) ---
#
# This used to repair CRLF only, on the reasoning that "install.sh owns their content".
# That reasoning cost v1.26.104 its enforcement: the auto-update path is `git pull` →
# `npm install` → this script, and it never runs install.sh. `~/.ownmind` IS the checkout,
# so the pull instantly replaces the hook logic under `hooks/`, while `git-hooks/` still
# holds the copies made whenever install.sh last ran — which can be many versions ago.
#
# When a release moves work from one wrapper to another, that split leaves the user with
# the new half and not the old one, and nothing says so. Copying from the checkout on every
# update is what keeps the two halves the same age.
#
# CR is stripped in the same pass: `.gitattributes` governs checkout only, so a machine that
# already holds these files as CRLF is never rewritten by git — normalised comparison hides
# it from `status` and `pull` alike.
GIT_HOOK_DIR="$HOME/.ownmind/git-hooks"
if [ -d "$GIT_HOOK_DIR" ]; then
  repaired=0
  for gh_name in pre-commit post-commit commit-msg; do
    gh="$GIT_HOOK_DIR/$gh_name"
    gh_src="$OWNMIND_DIR/hooks/ownmind-git-$gh_name"
    # Only ever refresh a hook that is already installed: creating one here would enable
    # OwnMind's git hooks on a machine whose owner never asked install.sh for them.
    [ -f "$gh" ] || continue
    if [ -f "$gh_src" ]; then
      if ! tr -d '\015' < "$gh_src" | cmp -s - "$gh"; then
        tr -d '\015' < "$gh_src" > "$gh.tmp" && mv "$gh.tmp" "$gh" && chmod +x "$gh" \
          && repaired=$((repaired + 1))
        continue
      fi
    fi
    case "$(tr -cd '\015' < "$gh" | wc -c | tr -d ' ')" in
      0) ;;
      *) tr -d '\015' < "$gh" > "$gh.tmp" && mv "$gh.tmp" "$gh" && chmod +x "$gh" && repaired=$((repaired + 1)) ;;
    esac
  done
  [ "$repaired" -gt 0 ] && echo "[ OK ] Repaired CRLF in $repaired git hook(s)"
fi

# --- 2b. Sync usage scanner (needs shared/ module; kept under $OWNMIND_DIR for execution) ---
# P6 launchd / systemd invokes $OWNMIND_DIR/hooks/ownmind-usage-scanner.js.
if [ -f "$OWNMIND_DIR/hooks/ownmind-usage-scanner.js" ]; then
  chmod +x "$OWNMIND_DIR/hooks/ownmind-usage-scanner.js"
  echo "[ OK ] Usage scanner ready"
fi

# --- 2c. Repair the scanner's schedule if it has died (v1.26.79) ---
# Syncing the scanner file says nothing about whether anything still runs it. Adam's
# machine had a current scanner on disk and no live schedule for three weeks.
#
# The exit code is deliberately not propagated. The update itself succeeded — files are
# synced — and failing the whole run would mislead mcp/index.js into logging update_failed
# and retrying. A failed repair is not swallowed either: the helper reports it to the
# server, so it lands on the error-report page instead of a terminal nobody is watching.
# --- 2d. Have the machine report its own health (v1.26.81) ---
# The self-check has only ever run during install and manual upgrade. Adam's last full
# report is dated 2026-05-29; his machine auto-updated daily for two months afterwards and
# told us nothing, while his scanner sat dead. The report he did send in May already
# contained the answer to the question that took a week to work out
# (`bash_resolution.selected === 'WSL_RELAY'`).
#
# `--quick` drops the one check that scans every local database. Fire-and-forget, in the
# background, never blocking the update.
SELF_CHECK="$OWNMIND_DIR/scripts/install-helpers/self-check.cjs"
if [ -f "$SELF_CHECK" ]; then
  (node "$SELF_CHECK" --trigger=auto_update --quick >/dev/null 2>&1 &) || true
fi

ENSURE_SCHEDULE="$OWNMIND_DIR/scripts/install-helpers/ensure-scanner-schedule.sh"
if [ -f "$ENSURE_SCHEDULE" ]; then
  # Captured rather than let through, so the helper's machine-readable line does not land
  # at column 0 in the middle of this script's own output.
  if SCHEDULE_RESULT="$(bash "$ENSURE_SCHEDULE" 2>&1)"; then
    echo "   Usage scanner schedule: $SCHEDULE_RESULT"
  else
    echo "   [ WARN ] $SCHEDULE_RESULT"
    echo "   [ WARN ] scanner schedule is not running and could not be repaired; reported to server"
  fi
fi

# --- 3. Ensure Claude Code settings.json has every hook entry ---
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_SETTINGS_WIN="$(to_win_path "$CLAUDE_SETTINGS")"
ERR_LOG="$HOME/.ownmind/logs/update-errors.log"
mkdir -p "$(dirname "$ERR_LOG")"
if [ -f "$CLAUDE_SETTINGS" ]; then
  node -e "
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { loadOrSkip } = require('$OWNMIND_DIR_WIN/scripts/install-helpers/load-settings-safe.cjs');
    const s = loadOrSkip('$CLAUDE_SETTINGS_WIN', {});
    let changed = false;
    if (!s.hooks) { s.hooks = {}; changed = true; }

    // v1.26.86 — SessionStart is handled by ensure-session-hook.cjs in section 3.4 below
    // (single implementation with behavioral tests; it also honors the
    // ~/.ownmind/.no-session-hook opt-out). This script used to make that decision inline,
    // one divergent copy per installer, and the daily one always won.

    // v1.26.105 — PreToolUse is handled by ensure-pretooluse-hooks.cjs in section 3.3b below.
    // What used to be here was the oldest copy of that logic: one matcher, and a presence
    // check across the whole array, in a script whose entire audience is upgrades.

    // WorktreeCreate hook — auto-inject .mcp.json into new worktrees.
    if (!s.hooks.WorktreeCreate) s.hooks.WorktreeCreate = [];
    const worktreeExists = s.hooks.WorktreeCreate.some(h =>
      h.hooks?.some(hh => (hh.command || '').includes('ownmind-worktree-setup'))
    );
    if (!worktreeExists) {
      s.hooks.WorktreeCreate.push({
        hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-worktree-setup.sh', timeout: 10 }]
      });
      changed = true;
      console.log('   ✅ Added WorktreeCreate hook (auto-inject worktree MCP)');
    }

    if (changed) {
      // Atomic write: write to temp file then rename to prevent corruption
      const tmp = '$CLAUDE_SETTINGS_WIN' + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, '$CLAUDE_SETTINGS_WIN');
    }
  " 2>>"$ERR_LOG"
fi

# --- 3.3b PreToolUse iron-rule hooks (v1.26.105, delegated to the shared implementation) ---
ENSURE_PRE_HOOK="$OWNMIND_DIR/scripts/install-helpers/ensure-pretooluse-hooks.cjs"
if [ -f "$ENSURE_PRE_HOOK" ]; then
  if pre_hook_result=$(node "$ENSURE_PRE_HOOK" "$CLAUDE_SETTINGS" --ownmind-dir "$OWNMIND_DIR" --bash 2>&1); then
    echo "   PreToolUse iron-rule hook: $pre_hook_result"
  else
    echo "   [FAIL] PreToolUse iron-rule hook: $pre_hook_result"
  fi
fi

# --- 3.4 SessionStart hook (v1.26.86, delegated to the shared implementation) ---
ENSURE_HOOK="$OWNMIND_DIR/scripts/install-helpers/ensure-session-hook.cjs"
if [ -f "$ENSURE_HOOK" ]; then
  if hook_result=$(node "$ENSURE_HOOK" --ownmind-dir "$OWNMIND_DIR" 2>&1); then
    echo "   SessionStart hook: $hook_result"
  else
    echo "   [FAIL] SessionStart hook: $hook_result"
  fi
fi

# --- 3.4b Background credentials (v1.26.87, delegated to the shared implementation) ---
# The key can be valid, the MCP can be uploading, and every scheduled run can still be
# blind — launchd / Task Scheduler do not inherit a shell's environment.
ENSURE_KEY_FILE="$OWNMIND_DIR/scripts/install-helpers/ensure-key-file.cjs"
if [ -f "$ENSURE_KEY_FILE" ]; then
  if key_result=$(node "$ENSURE_KEY_FILE" --ownmind-dir "$OWNMIND_DIR" 2>&1); then
    echo "   Background credentials: $key_result"
  else
    echo "   [FAIL] Background credentials: $key_result"
  fi
fi

# --- 3.5 v1.18.3 fix: existing v1.17.96 users were missing the reply-lint Stop hook on upgrade ---
# install.sh originally ran add-stop-hook, but update.sh didn't. Users upgrading v1.17.95 →
# v1.17.96 (Vin's machine included) never had Stop hook registered — reply-lint never caught
# IR-036/037. Idempotent: the helper skips when already present.
ADD_STOP_HOOK_HELPER="$OWNMIND_DIR/scripts/install-helpers/add-stop-hook.cjs"
if [ -f "$ADD_STOP_HOOK_HELPER" ] && [ -f "$CLAUDE_SETTINGS" ]; then
  STOP_RESULT=$(node "$ADD_STOP_HOOK_HELPER" "$CLAUDE_SETTINGS" --ownmind-dir "$OWNMIND_DIR" 2>&1)
  echo "   Stop reply-lint hook: $STOP_RESULT"
fi

# Same idea — backfill the PostToolUse banner hook (v1.17.71) so it's never missed either.
ADD_POST_HOOK_HELPER="$OWNMIND_DIR/scripts/install-helpers/add-post-tool-use-hook.cjs"
if [ -f "$ADD_POST_HOOK_HELPER" ] && [ -f "$CLAUDE_SETTINGS" ]; then
  POST_RESULT=$(node "$ADD_POST_HOOK_HELPER" "$CLAUDE_SETTINGS" --ownmind-dir "$OWNMIND_DIR" 2>&1)
  echo "   PostToolUse banner hook: $POST_RESULT"
fi

# --- 4. Gemini CLI hooks ---
if [ -d "$HOME/.gemini" ]; then
  GEMINI_SETTINGS="$HOME/.gemini/settings.json"
  GEMINI_SETTINGS_WIN="$(to_win_path "$GEMINI_SETTINGS")"
  node -e "
    const fs = require('fs');
    const { loadOrSkip } = require('$OWNMIND_DIR_WIN/scripts/install-helpers/load-settings-safe.cjs');
    const path = '$GEMINI_SETTINGS_WIN';
    const s = loadOrSkip(path, {});
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
      const tmp = path + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, path);
      console.log('   ✅ Gemini CLI SessionStart hook added');
    }
  " 2>>"$ERR_LOG"
fi

# --- 5. GitHub Copilot hooks ---
if [ -d "$HOME/.github" ] || command -v gh &>/dev/null; then
  GH_HOOKS_DIR="$HOME/.github/hooks"
  GH_HOOKS_FILE="$GH_HOOKS_DIR/hooks.json"
  GH_HOOKS_FILE_WIN="$(to_win_path "$GH_HOOKS_FILE")"
  mkdir -p "$GH_HOOKS_DIR"
  node -e "
    const fs = require('fs');
    const { loadOrSkip } = require('$OWNMIND_DIR_WIN/scripts/install-helpers/load-settings-safe.cjs');
    const path = '$GH_HOOKS_FILE_WIN';
    const s = loadOrSkip(path, { version: 1, hooks: {} });
    if (!s.hooks) s.hooks = {};
    if (!s.hooks.sessionStart) s.hooks.sessionStart = [];
    const exists = s.hooks.sessionStart.some(h => (h.command || '').includes('ownmind'));
    if (!exists) {
      s.hooks.sessionStart.push({ command: 'bash ~/.claude/hooks/ownmind-session-start.sh' });
      const tmp = path + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, path);
      console.log('   ✅ GitHub Copilot sessionStart hook added');
    }
  " 2>>"$ERR_LOG"
fi

# --- 6. Cursor hooks ---
if [ -d "$HOME/.cursor" ]; then
  CURSOR_HOOKS="$HOME/.cursor/hooks.json"
  CURSOR_HOOKS_WIN="$(to_win_path "$CURSOR_HOOKS")"
  node -e "
    const fs = require('fs');
    const { loadOrSkip } = require('$OWNMIND_DIR_WIN/scripts/install-helpers/load-settings-safe.cjs');
    const path = '$CURSOR_HOOKS_WIN';
    const s = loadOrSkip(path, { version: 1, hooks: {} });
    if (!s.hooks) s.hooks = {};
    if (!s.hooks['session-start']) s.hooks['session-start'] = [];
    const exists = s.hooks['session-start'].some(h => (h.command || '').includes('ownmind'));
    if (!exists) {
      s.hooks['session-start'].push({ command: 'bash ~/.claude/hooks/ownmind-session-start.sh' });
      const tmp = path + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, path);
      console.log('   ✅ Cursor session-start hook added');
    }
  " 2>>"$ERR_LOG"
fi

# --- Mark that the SessionStart hook is installed (avoids repeated iron-rule-check upgrades) ---
touch "$HOME/.ownmind/.session-hook-installed"

echo "─────────────────────────────────────────────"
echo "OwnMind sync complete"
