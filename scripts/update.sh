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

# v1.17.81 — update_started beacon (fire-and-forget + spool fallback).
send_update_beacon() {
  local trigger="$1"
  local claude_settings="$HOME/.claude/settings.json"
  [ -f "$claude_settings" ] || return
  local api_key api_url
  api_key=$(node -p "try { require('$claude_settings').mcpServers.ownmind.env.OWNMIND_API_KEY } catch { '' }" 2>/dev/null)
  api_url=$(node -p "try { require('$claude_settings').mcpServers.ownmind.env.OWNMIND_API_URL } catch { '' }" 2>/dev/null)
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

# --- 0. v1.18.5 fix: conditional-sync-cli.js needs js-yaml ---
# Originally user installs only ran npm install in ~/.ownmind/mcp/, so the root-level deps
# weren't installed and js-yaml was missing. conditional-sync-cli would crash at module
# load with ERR_MODULE_NOT_FOUND, the SessionStart hook silently failed, and big skill
# (~/.claude/skills/ownmind-iron-rules/) never updated after v1.18.0 shipped.
# Fix: install js-yaml at the root (used by conditional-sync), idempotent (skip if installed).
if [ ! -d "$OWNMIND_DIR/node_modules/js-yaml" ]; then
  echo "   📦 Installing missing conditional-sync dependency: js-yaml..."
  (cd "$OWNMIND_DIR" && npm install js-yaml@^4.1.1 --no-save --silent --no-audit --no-fund 2>>"${HOME}/.ownmind/logs/update-err.log") \
    && echo "   ✅ js-yaml installed" \
    || echo "   ⚠️ js-yaml install failed (see ~/.ownmind/logs/update-err.log); big skill sync will fall back to skip — other features unaffected"
fi

# --- 0b. v1.19.14 fix: device-fingerprint needs node-machine-id ---
# Uses OS-level machine identifiers to compute a device fingerprint (stable "same machine" identifier).
# Replaces the v3 design of "hostname + MAC" (unstable under Docker / VPN environments).
if [ ! -d "$OWNMIND_DIR/node_modules/node-machine-id" ]; then
  echo "   📦 Installing bug-report-tool dependency: node-machine-id..."
  (cd "$OWNMIND_DIR" && npm install node-machine-id@^1.1.12 --no-save --silent --no-audit --no-fund 2>>"${HOME}/.ownmind/logs/update-err.log") \
    && echo "   ✅ node-machine-id installed" \
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
        " "$target_file" 2>/dev/null || true
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

# --- 2b. Sync usage scanner (needs shared/ module; kept under $OWNMIND_DIR for execution) ---
# P6 launchd / systemd invokes $OWNMIND_DIR/hooks/ownmind-usage-scanner.js.
if [ -f "$OWNMIND_DIR/hooks/ownmind-usage-scanner.js" ]; then
  chmod +x "$OWNMIND_DIR/hooks/ownmind-usage-scanner.js"
  echo "[ OK ] Usage scanner ready"
fi

# --- 3. Ensure Claude Code settings.json has every hook entry ---
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
ERR_LOG="$HOME/.ownmind/logs/update-errors.log"
mkdir -p "$(dirname "$ERR_LOG")"
# User opt-out sentinel: touch ~/.ownmind/.no-session-hook to disable auto-install of SessionStart.
NO_SESSION_HOOK_FLAG="$HOME/.ownmind/.no-session-hook"
if [ -f "$CLAUDE_SETTINGS" ]; then
  node -e "
    const fs = require('fs');
    const { loadOrSkip } = require('$HOME/.ownmind/scripts/install-helpers/load-settings-safe.cjs');
    const s = loadOrSkip('$CLAUDE_SETTINGS', {});
    const noSessionHook = fs.existsSync('$NO_SESSION_HOOK_FLAG');
    let changed = false;
    if (!s.hooks) { s.hooks = {}; changed = true; }

    // SessionStart hook — auto-load memory (startup/resume/clear/compact all need loading).
    // Respect user opt-out: if ~/.ownmind/.no-session-hook exists, skip this whole block.
    if (!noSessionHook) {
      if (!s.hooks.SessionStart) s.hooks.SessionStart = [];
      const ownmindCmd = 'bash ~/.claude/hooks/ownmind-session-start.sh';
      const isOwnmindEntry = h => h.hooks?.some(hh => (hh.command || '').includes('ownmind-session-start'));
      const existing = s.hooks.SessionStart.filter(isOwnmindEntry);
      const expectedMatchers = ['startup', 'resume', 'clear', 'compact'];
      const hasAllMatchers = expectedMatchers.every(m =>
        existing.some(h => h.matcher === m)
      );
      // Two cases write entries:
      // 1. No ownmind SessionStart entry at all (fresh install).
      // 2. An entry exists but matchers are incomplete (legacy migration).
      // If the user already has all 4 matchers, don't touch it; if they manually removed them
      // and left it blank, treat that as opt-out.
      if (existing.length > 0 && !hasAllMatchers) {
        // Migration: drop old entries, rebuild 4 complete matchers.
        s.hooks.SessionStart = s.hooks.SessionStart.filter(h => !isOwnmindEntry(h));
        for (const matcher of expectedMatchers) {
          s.hooks.SessionStart.push({ matcher, hooks: [{ type: 'command', command: ownmindCmd, timeout: 10 }] });
        }
        changed = true;
        console.log('   ✅ SessionStart hook upgraded to 4 complete matchers (startup/resume/clear/compact)');
      } else if (existing.length === 0 && s.hooks.SessionStart.length === 0) {
        // Fresh install: no SessionStart in settings — add the 4 matchers.
        for (const matcher of expectedMatchers) {
          s.hooks.SessionStart.push({ matcher, hooks: [{ type: 'command', command: ownmindCmd, timeout: 10 }] });
        }
        changed = true;
        console.log('   ✅ SessionStart hook installed (4 matchers)');
      }
      // Other cases (already complete, or user removed but kept other SessionStart entries): leave alone.
    }

    // PreToolUse hook — iron rule check.
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
      console.log('   ✅ Added PreToolUse hook (iron rule check)');
    }

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
      const tmp = '$CLAUDE_SETTINGS' + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, '$CLAUDE_SETTINGS');
    }
  " 2>>"$ERR_LOG"
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
  node -e "
    const fs = require('fs');
    const { loadOrSkip } = require('$HOME/.ownmind/scripts/install-helpers/load-settings-safe.cjs');
    const path = '$GEMINI_SETTINGS';
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
  mkdir -p "$GH_HOOKS_DIR"
  node -e "
    const fs = require('fs');
    const { loadOrSkip } = require('$HOME/.ownmind/scripts/install-helpers/load-settings-safe.cjs');
    const path = '$GH_HOOKS_FILE';
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
  node -e "
    const fs = require('fs');
    const { loadOrSkip } = require('$HOME/.ownmind/scripts/install-helpers/load-settings-safe.cjs');
    const path = '$CURSOR_HOOKS';
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
