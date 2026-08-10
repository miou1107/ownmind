#!/usr/bin/env node
/**
 * v1.26.105 — install-time helper: writes (and repairs) the OwnMind PreToolUse iron-rule hooks
 * in ~/.claude/settings.json.
 *
 * Why this exists as a helper rather than inline in the installers: the logic lived twice, once
 * in PowerShell and once in a node block inside install.sh, and only the bash copy was ever
 * reachable from CI. The half that rotted was the half no test could run.
 *
 * Behavior (idempotent, and repairing):
 *   - no entry for a matcher            → append one
 *   - entry exists, command matches     → no-op, report "unchanged"
 *   - entry exists, command differs     → rewrite the command, report "repaired"
 *
 * That last case is the whole point. The previous check asked only whether some entry for the
 * matcher mentioned 'ownmind-iron-rule-check', which a stale entry does — so a stale entry
 * satisfied its own repair and kept its old command forever. Upgrades are the whole population;
 * an installer that only appends never reaches them.
 *
 * Before write, backup to settings.json.bak.<ts>; rollback on failure. Mirrors
 * add-post-tool-use-hook.cjs so the two read the same way.
 *
 * Usage:
 *   node ensure-pretooluse-hooks.cjs <settings.json path> --ownmind-dir <path> [--bash]
 *
 * Exit codes:
 *   0  — success (any mix of added / repaired / unchanged)
 *   1  — failure (already rolled back)
 */

'use strict';

const fs = require('fs');
const path = require('path');
// v1.26.131 - os.homedir() as the last resort: HOME is unset on Windows, and the two
// expressions this replaced produced a relative path and a TypeError respectively.
const os = require('os');

// The command carries no marker field, so identity is the substring — same convention as
// add-post-tool-use-hook.cjs, and the reason a stale command is recognisable at all.
const HOOK_IDENTIFIER_SUBSTR = 'ownmind-iron-rule-check';

const MATCHERS = [
  'Bash',
  // The file-editing tools carry no command, which is why no rule tagged trigger:edit had ever
  // fired before v1.26.92. The hook throttles itself to one full listing per hour.
  'Edit|Write|MultiEdit|NotebookEdit',
];

/**
 * The one place that decides what the hook command should be.
 *
 * node mode points at the git checkout, not at the copy in ~/.claude/hooks: that copy imports
 * ../shared/helpers.js, ~/.claude/shared/ does not exist, and no installer creates it, so node
 * exits with ERR_MODULE_NOT_FOUND before reading a byte of the payload. In ~/.ownmind, shared/
 * and hooks/ sit where the imports expect.
 */
function buildPreCmd(ownmindDir, useBash) {
  if (useBash) return 'bash ~/.claude/hooks/ownmind-iron-rule-check.sh';
  const hookPath = path.join(ownmindDir, 'hooks', 'ownmind-iron-rule-check.js').replace(/\\/g, '/');
  // The directory string may contain whitespace → quote it so the shell parses one argument.
  return `node "${hookPath}"`;
}

/**
 * @returns {{ status: 'ok' | 'error', message?: string, results?: Array<{matcher: string, action: 'added'|'repaired'|'unchanged', from?: string}> }}
 */
function ensureHooks(settingsPath, ownmindDir, useBash) {
  const preCmd = buildPreCmd(ownmindDir, useBash);

  let raw = '';
  let existed = false;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
    existed = true;
  } catch (e) {
    if (e.code !== 'ENOENT') return { status: 'error', message: `read failed: ${e.message}` };
  }

  // Strip a UTF-8 BOM before parsing. JSON.parse rejects it, and on Windows anything that
  // writes the file with PowerShell's default `Out-File -Encoding utf8` puts one there — the
  // reason this repo carries a Write-Utf8NoBom helper at all. Refusing to repair a hook
  // because of three leading bytes would be its own silent failure.
  // Compared by code point rather than written as a literal: a BOM in the source of the file
  // that strips BOMs is not something a reviewer can see.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  let settings;
  if (existed && text.trim()) {
    try { settings = JSON.parse(text); }
    catch (e) { return { status: 'error', message: `JSON parse failed: ${e.message}` }; }
  } else {
    settings = {};
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];

  const results = [];
  let changed = false;

  for (const matcher of MATCHERS) {
    const entry = settings.hooks.PreToolUse.find((group) => {
      if (!group || group.matcher !== matcher || !Array.isArray(group.hooks)) return false;
      return group.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(HOOK_IDENTIFIER_SUBSTR));
    });

    if (!entry) {
      settings.hooks.PreToolUse.push({
        matcher,
        hooks: [{ type: 'command', command: preCmd }],
      });
      results.push({ matcher, action: 'added' });
      changed = true;
      continue;
    }

    const stale = entry.hooks.filter((h) =>
      h && typeof h.command === 'string' &&
      h.command.includes(HOOK_IDENTIFIER_SUBSTR) &&
      h.command !== preCmd
    );
    if (stale.length === 0) {
      results.push({ matcher, action: 'unchanged' });
      continue;
    }
    const from = stale[0].command;
    for (const h of stale) h.command = preCmd;
    results.push({ matcher, action: 'repaired', from });
    changed = true;
  }

  if (!changed) return { status: 'ok', results };

  let backupPath = null;
  if (existed) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${settingsPath}.bak.${ts}`;
    try { fs.copyFileSync(settingsPath, backupPath); }
    catch (e) { return { status: 'error', message: `backup failed: ${e.message}` }; }
  }

  const tmpPath = `${settingsPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* tmp may not exist; the restore below is what matters */ }
    if (backupPath) {
      try { fs.copyFileSync(backupPath, settingsPath); } catch { /* original is still the backup on disk */ }
    }
    return { status: 'error', message: `write failed: ${e.message}` };
  }

  return { status: 'ok', results, message: backupPath ? `backup: ${backupPath}` : '' };
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node ensure-pretooluse-hooks.cjs <settings.json path> --ownmind-dir <path> [--bash]');
    process.exit(1);
  }
  const settingsPath = args[0];
  let ownmindDir = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.ownmind');
  const idx = args.indexOf('--ownmind-dir');
  if (idx >= 0 && args[idx + 1]) ownmindDir = args[idx + 1];
  const useBash = args.includes('--bash');

  const result = ensureHooks(settingsPath, ownmindDir, useBash);
  if (result.status === 'error') {
    console.error(`[ensure-pretooluse-hooks] ERROR: ${result.message}`);
    process.exit(1);
  }
  for (const r of result.results) {
    if (r.action === 'unchanged') continue;
    const detail = r.action === 'repaired' ? ` (was: ${r.from})` : '';
    console.log(`[ensure-pretooluse-hooks] ${r.action}: ${r.matcher}${detail}`);
  }
  if (result.results.every((r) => r.action === 'unchanged')) {
    console.log('[ensure-pretooluse-hooks] unchanged');
  }
  process.exit(0);
}

module.exports = { ensureHooks, buildPreCmd, MATCHERS, HOOK_IDENTIFIER_SUBSTR };
