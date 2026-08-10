#!/usr/bin/env node
/**
 * v1.17.96 — install-time helper: writes the OwnMind Stop hook into ~/.claude/settings.json.
 *
 * Purpose: at the end of every AI turn, automatically run hooks/ownmind-reply-lint.js to scan
 *          for IR-037 / IR-036 violations, print the banner to the user terminal, and report
 *          compliance data.
 *
 * Design mirrors v1.17.71's add-post-tool-use-hook.cjs idempotent merge semantics:
 *   - settings.json missing → create a new file with a hooks block.
 *   - exists but no hooks block → add one.
 *   - exists with Stop but no OwnMind reply-lint hook → append to the end of the Stop array.
 *   - exists with an OwnMind reply-lint hook already → no-op, report "skipped".
 *
 * Before write, backup to settings.json.bak.<ts>; rollback on failure.
 *
 * Usage:
 *   node add-stop-hook.cjs <settings.json path> [--ownmind-dir <path>]
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

// Identify whether the hook already exists by looking for 'ownmind-reply-lint' in the command string.
const HOOK_IDENTIFIER_SUBSTR = 'ownmind-reply-lint';

function buildHookEntry(ownmindDir) {
  // Use an absolute path and invoke node directly — avoids PATH resolution issues.
  // The directory string may contain whitespace → wrap in double quotes.
  // Stop hook spec: no matcher (Stop doesn't attach to a tool).
  const hookPath = path.join(ownmindDir, 'hooks', 'ownmind-reply-lint.js');
  const cmd = `node "${hookPath}"`;
  return {
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
  if (!Array.isArray(settings.hooks.Stop)) {
    settings.hooks.Stop = [];
  }

  // Idempotency check: see if any hook.command contains ownmind-reply-lint.
  const alreadyAdded = settings.hooks.Stop.some((group) => {
    if (!group || !Array.isArray(group.hooks)) return false;
    return group.hooks.some((h) => {
      if (!h || typeof h.command !== 'string') return false;
      return h.command.includes(HOOK_IDENTIFIER_SUBSTR);
    });
  });
  if (alreadyAdded) {
    return { status: 'skipped', message: 'already present' };
  }

  settings.hooks.Stop.push(entry);

  // Backup the existing file.
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
    console.error('Usage: node add-stop-hook.cjs <settings.json path> [--ownmind-dir <path>]');
    process.exit(1);
  }
  const settingsPath = args[0];
  let ownmindDir = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.ownmind');
  const idx = args.indexOf('--ownmind-dir');
  if (idx >= 0 && args[idx + 1]) ownmindDir = args[idx + 1];

  const result = addHook(settingsPath, ownmindDir);
  if (result.status === 'error') {
    console.error(`[add-stop-hook] ERROR: ${result.message}`);
    process.exit(1);
  }
  console.log(`[add-stop-hook] ${result.status}${result.message ? ' (' + result.message + ')' : ''}`);
  process.exit(0);
}

module.exports = { addHook, buildHookEntry, HOOK_IDENTIFIER_SUBSTR };
