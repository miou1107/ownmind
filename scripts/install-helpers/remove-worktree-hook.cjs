#!/usr/bin/env node
/**
 * Take OwnMind's WorktreeCreate hook back out of ~/.claude/settings.json.
 *
 * OwnMind used to register `ownmind-worktree-setup.sh` there to drop a `.mcp.json` into every
 * new worktree. WorktreeCreate is not a notification, though: Claude Code hands worktree
 * creation itself to whatever is registered on that event and expects the new path on stdout.
 * A side-effect hook that prints nothing therefore answers "hook succeeded but returned no
 * worktree path", and `EnterWorktree` stops working in every repository on the machine, not
 * only the one being worked on. bug-report id=29, and the same mechanism had already been
 * filed three times before that.
 *
 * The injection it was doing turned out to buy nothing. Every installer registers the ownmind
 * MCP server in `~/.claude.json` at user scope and verifies it by reading it back, and user
 * scope already covers every directory a worktree can be created in.
 *
 * Removal rather than repair, and removal on upgrade rather than only on fresh install:
 * everybody hitting this is already installed, so an installer that merely stops adding the
 * entry fixes nobody.
 *
 * Usage:
 *   node remove-worktree-hook.cjs <settings.json path>
 *
 * Exit codes:
 *   0 — settings.json now has no OwnMind WorktreeCreate hook (including "never had one")
 *   1 — could not be read or written; the file is untouched
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * The command carries no marker field, so the substring is the identity — the same convention
 * ensure-pretooluse-hooks.cjs and add-post-tool-use-hook.cjs use.
 */
const HOOK_IDENTIFIER_SUBSTR = 'ownmind-worktree-setup';

function isOurs(hook) {
  return Boolean(hook) && String(hook.command || '').includes(HOOK_IDENTIFIER_SUBSTR);
}

/**
 * @param {string} settingsPath
 * @returns {{status: 'ok'|'error', removed: number, message?: string}}
 */
function removeWorktreeHook(settingsPath) {
  if (!fs.existsSync(settingsPath)) return { status: 'ok', removed: 0 };

  let raw;
  let settings;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(raw);
  } catch (e) {
    // Rewriting a file people hand-edit, from a parse we already know failed, would lose more
    // than the hook does.
    return { status: 'error', removed: 0, message: `cannot read ${settingsPath}: ${e.message}` };
  }

  const entries = settings && settings.hooks && Array.isArray(settings.hooks.WorktreeCreate)
    ? settings.hooks.WorktreeCreate
    : null;
  if (!entries) return { status: 'ok', removed: 0 };

  let removed = 0;
  const kept = [];
  for (const entry of entries) {
    const hooks = Array.isArray(entry && entry.hooks) ? entry.hooks : [];
    const mine = hooks.filter(isOurs);
    if (mine.length === 0) {
      kept.push(entry);
      continue;
    }
    removed += mine.length;
    const theirs = hooks.filter((h) => !isOurs(h));
    // An entry can hold somebody else's command beside ours; drop the whole entry only when
    // nothing of theirs is left in it.
    if (theirs.length > 0) kept.push({ ...entry, hooks: theirs });
  }

  if (removed === 0) return { status: 'ok', removed: 0 };

  if (kept.length > 0) {
    settings.hooks.WorktreeCreate = kept;
  } else {
    // The key has to go, not just its contents. Claude Code branches on whether a
    // WorktreeCreate hook is configured at all, and an empty array still reads as configured
    // to anything that only asks whether the key is present — which would leave worktree
    // creation delegated to a list with nothing in it.
    delete settings.hooks.WorktreeCreate;
  }

  const tmp = `${settingsPath}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    fs.renameSync(tmp, settingsPath);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* nothing more to do */ }
    return { status: 'error', removed: 0, message: `write failed: ${e.message}` };
  }

  return { status: 'ok', removed };
}

if (require.main === module) {
  const arg = process.argv[2]
    || path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.claude', 'settings.json');
  const result = removeWorktreeHook(arg);
  if (result.status === 'error') {
    console.error(`[remove-worktree-hook] ERROR: ${result.message}`);
    process.exit(1);
  }
  if (result.removed > 0) {
    console.log(`[remove-worktree-hook] removed ${result.removed} WorktreeCreate hook(s); worktrees go back to git`);
  }
  process.exit(0);
}

module.exports = { removeWorktreeHook, HOOK_IDENTIFIER_SUBSTR };
