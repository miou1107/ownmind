#!/usr/bin/env node
'use strict';
// ensure-session-hook.cjs — bring settings.json's SessionStart entries to the correct
// shape for this platform. One implementation, called from every installer and updater.
//
// v1.26.86.
//
// Why this exists
// ---------------
// install.ps1 did this in PowerShell: filter the entries, `ConvertTo-Json -Compress`, pass
// the result to `node -e` as an argument, read a string back. Four rounds of Windows fixes
// were declared complete on the assumption that block ran.
//
// It did not. Measured 2026-08-06: 采瑤 upgraded to v1.26.84 at 16:38 and her entry still
// had a single `null` matcher afterwards — the repair had been in install.ps1 since
// v1.26.82 and left her untouched. She kept working only because the path her AI had
// hand-written happened to be the one that resolves. Nothing reported a failure, because a
// PowerShell argument that does not survive the round trip simply yields a value that is
// not "true".
//
// So the marshalling is gone. The file is read and written by the same Node code the
// updaters already run and the tests already cover; PowerShell only has to spawn it.
//
// Usage:  node ensure-session-hook.cjs [--settings <path>] [--ownmind-dir <path>]
// Output: one machine-readable line —
//         OK:hook:unchanged | OK:hook:installed | OK:hook:repaired | OK:hook:user_customised
//         ERROR:hook:<why>
// Exit:   0 on any OK, 1 on error. Never throws.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sessionStartEntries, isOwnmindSessionEntry, needsRewrite,
} = require('./session-hook-command.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--settings') args.settings = argv[++i];
    else if (argv[i] === '--ownmind-dir') args.ownmindDir = argv[++i];
    // Lets the tests exercise the Windows branch from a Mac. The real callers never pass it.
    else if (argv[i] === '--platform') args.platform = argv[++i];
  }
  return args;
}

/**
 * @returns {{ status: string, changed: boolean, settings: object }}
 */
function ensureSessionHook(settings, { platform = process.platform, ownmindDir } = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  if (!s.hooks || typeof s.hooks !== 'object') s.hooks = {};
  if (!Array.isArray(s.hooks.SessionStart)) s.hooks.SessionStart = [];

  const opts = { platform, ownmindDir };
  const mine = s.hooks.SessionStart.filter(isOwnmindSessionEntry);

  if (mine.length === 0) {
    s.hooks.SessionStart.push(...sessionStartEntries(opts));
    return { status: 'installed', changed: true, settings: s };
  }

  if (!needsRewrite(mine, opts)) {
    // Either already correct, or deliberately edited by the user — needsRewrite refuses to
    // touch a command we did not generate, and that refusal is the point.
    const ours = mine.every((e) => e.hooks?.every((h) => h.command === sessionStartEntries(opts)[0].hooks[0].command));
    return { status: ours ? 'unchanged' : 'user_customised', changed: false, settings: s };
  }

  s.hooks.SessionStart = s.hooks.SessionStart.filter((e) => !isOwnmindSessionEntry(e));
  s.hooks.SessionStart.push(...sessionStartEntries(opts));
  return { status: 'repaired', changed: true, settings: s };
}

function main() {
  const args = parseArgs(process.argv);
  const home = os.homedir();
  const settingsPath = args.settings || path.join(home, '.claude', 'settings.json');
  const ownmindDir = args.ownmindDir || path.join(home, '.ownmind');

  // Documented opt-out: `touch ~/.ownmind/.no-session-hook` means never install or repair
  // the SessionStart hook on this machine. Honored here so every caller honors it.
  if (fs.existsSync(path.join(ownmindDir, '.no-session-hook'))) {
    process.stdout.write('OK:hook:opted_out\n');
    process.exit(0);
  }

  let settings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      // Strip a BOM: Windows PowerShell 5.1 writes them and JSON.parse rejects them.
      // Written as an escape — a literal U+FEFF in source is invisible and one
      // "normalize invisible characters" editor pass away from silently vanishing.
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    }
  } catch (e) {
    // Never overwrite a file we could not read — that would destroy the user's other hooks.
    process.stdout.write(`ERROR:hook:settings unreadable (${e.message})\n`);
    process.exit(1);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    // Valid JSON but not a settings object (an array, a number, ...). An array passes a
    // typeof check and then silently drops named properties on stringify — the run would
    // claim success while writing nothing. Refuse, like any other unreadable file.
    process.stdout.write('ERROR:hook:settings is not a JSON object\n');
    process.exit(1);
  }

  let result;
  try {
    result = ensureSessionHook(settings, { ownmindDir, platform: args.platform || process.platform });
  } catch (e) {
    process.stdout.write(`ERROR:hook:${e.message}\n`);
    process.exit(1);
  }

  if (result.changed) {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const tmp = `${settingsPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(result.settings, null, 2));
      fs.renameSync(tmp, settingsPath);
    } catch (e) {
      process.stdout.write(`ERROR:hook:cannot write settings (${e.message})\n`);
      process.exit(1);
    }
  }

  process.stdout.write(`OK:hook:${result.status}\n`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { ensureSessionHook, parseArgs };
