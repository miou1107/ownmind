#!/usr/bin/env node
/**
 * v1.17.71 — install-time helper: writes the OwnMind PostToolUse hook into ~/.claude/settings.json.
 *
 * Purpose: lets OwnMind tool-result banners bypass the Claude Code UI and go straight to the user terminal.
 *
 * Behavior (idempotent):
 *   - settings.json missing → create a new file with a hooks block.
 *   - exists but no hooks block → add one.
 *   - exists with PostToolUse but no OwnMind hook → append to the end of the PostToolUse array.
 *   - exists with an OwnMind hook already → no-op, report "skipped".
 *
 * Before write, backup to settings.json.bak.<ts>; rollback on failure.
 *
 * Usage:
 *   node add-post-tool-use-hook.cjs <settings.json path> [--ownmind-dir <path>]
 *
 * Exit codes:
 *   0  — success (including skipped)
 *   1  — failure (already rolled back)
 */

'use strict';

const fs = require('fs');
const path = require('path');
// v1.26.131 - os.homedir() as the last resort: HOME is unset on Windows, and the two
// expressions this replaced produced a relative path and a TypeError respectively.
const os = require('os');

const MATCHER = 'mcp__ownmind__.*';
// Identify whether the hook already exists by looking for 'ownmind-tty-echo' in the command string.
// We don't rely on a dedicated `name` field because the official Claude Code hook schema only
// has type + command + timeout — extra fields are tolerated but shouldn't be depended on.
const HOOK_IDENTIFIER_SUBSTR = 'ownmind-tty-echo';

function buildHookEntry(ownmindDir) {
  // Use an absolute path and invoke node directly — avoids PATH resolution issues.
  // The directory string may contain whitespace → wrap in double quotes so the shell parses correctly.
  const hookPath = path.join(ownmindDir, 'hooks', 'ownmind-tty-echo.cjs');
  const cmd = `node "${hookPath}"`;
  return {
    matcher: MATCHER,
    hooks: [
      { type: 'command', command: cmd },
    ],
  };
}

/**
 * @returns {{ status: 'created' | 'added' | 'skipped' | 'error', message?: string }}
 */
function addHook(settingsPath, ownmindDir) {
  const entry = buildHookEntry(ownmindDir);
  let raw = '';
  let existed = false;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
    existed = true;
  } catch (e) {
    if (e.code !== 'ENOENT') return { status: 'error', message: `read failed: ${e.message}` };
  }

  let settings;
  if (existed && raw.trim()) {
    try { settings = JSON.parse(raw); }
    catch (e) { return { status: 'error', message: `JSON parse failed: ${e.message}` }; }
  } else {
    settings = {};
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks.PostToolUse)) {
    settings.hooks.PostToolUse = [];
  }

  // Idempotency check: see if any hook.command contains ownmind-tty-echo.
  const alreadyAdded = settings.hooks.PostToolUse.some((group) => {
    if (!group || !Array.isArray(group.hooks)) return false;
    return group.hooks.some((h) => {
      if (!h || typeof h.command !== 'string') return false;
      return h.command.includes(HOOK_IDENTIFIER_SUBSTR);
    });
  });
  if (alreadyAdded) {
    return { status: 'skipped', message: 'already present' };
  }

  settings.hooks.PostToolUse.push(entry);

  // Backup the existing file (if any).
  let backupPath = null;
  if (existed) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${settingsPath}.bak.${ts}`;
    try { fs.copyFileSync(settingsPath, backupPath); }
    catch (e) { return { status: 'error', message: `backup failed: ${e.message}` }; }
  }

  // Atomic write: tmp + rename.
  const tmpPath = `${settingsPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    // Rollback: remove tmp, restore from backup.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (backupPath) {
      try { fs.copyFileSync(backupPath, settingsPath); } catch { /* ignore */ }
    }
    return { status: 'error', message: `write failed: ${e.message}` };
  }

  return { status: existed ? 'added' : 'created', message: backupPath ? `backup: ${backupPath}` : '' };
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node add-post-tool-use-hook.cjs <settings.json path> [--ownmind-dir <path>]');
    process.exit(1);
  }
  const settingsPath = args[0];
  let ownmindDir = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.ownmind');
  const idx = args.indexOf('--ownmind-dir');
  if (idx >= 0 && args[idx + 1]) ownmindDir = args[idx + 1];

  const result = addHook(settingsPath, ownmindDir);
  if (result.status === 'error') {
    console.error(`[add-post-tool-use-hook] ERROR: ${result.message}`);
    process.exit(1);
  }
  console.log(`[add-post-tool-use-hook] ${result.status}${result.message ? ' (' + result.message + ')' : ''}`);
  process.exit(0);
}

module.exports = { addHook, buildHookEntry, MATCHER, HOOK_IDENTIFIER_SUBSTR };
