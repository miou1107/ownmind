#!/usr/bin/env node
'use strict';
// ensure-monitor-mod.cjs — make Claude Code load the OwnMind monitor mod from this OwnMind
// checkout. One implementation, called from install.sh, update.sh, install.ps1 and update.ps1.
//
// v1.30.45.
//
// The mod (mods/ownmind-monitor) is a Claude Code plugin made of function hooks. Claude Code
// loads such a folder when ~/.claude/settings.json has, in its "env" block:
//
//   CLAUDE_CODE_PLUGIN_DIRS            one or more folders, joined by the platform's
//                                      path-list separator (':' on macOS/Linux, ';' on Windows)
//   CLAUDE_CODE_ENABLE_FUNCTION_HOOKS  "1"
//
// The folder we add is inside the OwnMind checkout, so every later `git pull` delivers the
// newest mod with no further step. Whatever else the user lists in CLAUDE_CODE_PLUGIN_DIRS is
// kept, in order. Entries that name this mod somewhere else — the hand-installed copy under
// ~/.claude/mods/ownmind-monitor, in tilde or expanded form, or this same folder spelled
// differently — are replaced by the one canonical path, so the mod is never loaded twice.
//
// Opt out: create ~/.ownmind/.no-monitor-mod. The helper then removes its own entry and leaves
// everything else alone.
//
// Usage:  node ensure-monitor-mod.cjs [--settings <path>] [--ownmind-dir <path>]
//                                     [--home <path>] [--platform <darwin|linux|win32>]
//         (--home and --platform are for the tests only: they exercise another platform's
//         paths, so --platform also skips the check that the mod folder exists on disk.)
// Output: one machine-readable line —
//         OK:monitor_mod:unchanged | OK:monitor_mod:installed | OK:monitor_mod:updated
//         OK:monitor_mod:opted_out | OK:monitor_mod:missing (the checkout has no mod folder;
//         our entry, if any, is removed)
//         ERROR:monitor_mod:<why>
// Exit:   0 on any OK, 1 on error. Never throws.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MOD_NAME = 'ownmind-monitor';
const DIRS_KEY = 'CLAUDE_CODE_PLUGIN_DIRS';
const FLAG_KEY = 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--settings') args.settings = argv[++i];
    else if (argv[i] === '--ownmind-dir') args.ownmindDir = argv[++i];
    else if (argv[i] === '--home') args.home = argv[++i];
    else if (argv[i] === '--platform') args.platform = argv[++i];
  }
  return args;
}

const pathApi = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const separator = (platform) => (platform === 'win32' ? ';' : ':');

// Git Bash hands node a home like /c/Users/amy. Claude Code on Windows is a native program
// and needs C:\Users\amy.
function toNative(p, platform) {
  if (platform !== 'win32' || typeof p !== 'string') return p;
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
  return p.replace(/\//g, '\\');
}

// A comparable form of a folder: tilde expanded, one kind of slash, no trailing slash, and
// case-folded on Windows (its file system is case-insensitive).
function comparable(entry, { home, platform }) {
  let p = String(entry).trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = home + p.slice(1);
  p = toNative(p, platform).replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  return platform === 'win32' ? p.toLowerCase() : p;
}

function modDir(ownmindDir, platform) {
  return pathApi(platform).join(toNative(ownmindDir, platform), 'mods', MOD_NAME);
}

/**
 * Pure transform. Returns the new settings object and whether anything changed.
 * @returns {{ status: string, changed: boolean, settings: object }}
 */
function ensureMonitorMod(settings, { ownmindDir, home = os.homedir(), platform = process.platform, optOut = false }) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const before = JSON.stringify(s);
  const sep = separator(platform);
  const target = modDir(ownmindDir, platform);
  const ctx = { home: toNative(home, platform), platform };
  const targetKey = comparable(target, ctx);
  // Every place this mod has been loaded from: this checkout, and the hand-installed copy.
  const ours = new Set([
    targetKey,
    comparable(pathApi(platform).join(ctx.home, '.claude', 'mods', MOD_NAME), ctx),
  ]);

  // Anything other than an object / a string here is not ours to repair: refuse instead of
  // silently replacing what the user wrote.
  if (s.env !== undefined && (s.env === null || typeof s.env !== 'object' || Array.isArray(s.env))) {
    throw new Error('settings "env" is not an object');
  }
  const hadEnv = s.env !== undefined;
  const env = hadEnv ? s.env : {};
  if (env[DIRS_KEY] !== undefined && typeof env[DIRS_KEY] !== 'string') {
    throw new Error(`${DIRS_KEY} is not a string`);
  }
  const existing = typeof env[DIRS_KEY] === 'string' ? env[DIRS_KEY].split(sep) : [];

  const kept = [];
  const seen = new Set();
  let placed = false;
  for (const raw of existing) {
    const entry = raw.trim();
    if (!entry) continue;
    const key = comparable(entry, ctx);
    if (ours.has(key)) {
      // The first entry that names this mod becomes the canonical path, in the same position.
      if (!optOut && !placed) { kept.push(target); seen.add(targetKey); placed = true; }
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  if (!optOut && !placed) kept.push(target);

  if (optOut) {
    if (!hadEnv || !(DIRS_KEY in env)) return { status: 'opted_out', changed: false, settings: s };
    if (kept.length) env[DIRS_KEY] = kept.join(sep);
    else delete env[DIRS_KEY];
    return { status: 'opted_out', changed: JSON.stringify(s) !== before, settings: s };
  }

  const wasInstalled = existing.some((e) => e.trim() && comparable(e, ctx) === targetKey);
  env[DIRS_KEY] = kept.join(sep);
  env[FLAG_KEY] = '1';
  if (!hadEnv) s.env = env;
  const changed = JSON.stringify(s) !== before;
  const status = !changed ? 'unchanged' : wasInstalled ? 'updated' : 'installed';
  return { status, changed, settings: s };
}

function main() {
  const args = parseArgs(process.argv);
  const platform = args.platform || process.platform;
  const home = args.home || os.homedir();
  const settingsPath = args.settings || path.join(os.homedir(), '.claude', 'settings.json');
  const ownmindDir = toNative(args.ownmindDir || path.join(os.homedir(), '.ownmind'), platform);
  const optedOut = fs.existsSync(path.join(ownmindDir, '.no-monitor-mod'));
  // Pointing Claude Code at a folder that is not there would only produce a warning on every
  // start, so a missing mod folder (an older checkout, a rollback) removes our entry the same
  // way the opt-out does. Not checked when --platform is passed: that flag exists only for
  // the tests, which hand in another platform's paths that are not on this disk. It used to
  // be skipped only when the platform differed from the one running, which held on a Mac and
  // failed on Windows, where `--platform win32` is the real platform and the fake
  // C:\Users\amy checkout was reported missing. The installers never pass --platform.
  const isMissing = !optedOut && !args.platform
    && !fs.existsSync(path.join(ownmindDir, 'mods', MOD_NAME, '.claude-plugin', 'plugin.json'));
  const optOut = optedOut || isMissing;

  let settings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      // Strip a BOM: Windows PowerShell 5.1 writes them and JSON.parse rejects them.
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    }
  } catch (e) {
    // Never overwrite a file we could not read — that would destroy the user's other settings.
    process.stdout.write(`ERROR:monitor_mod:settings unreadable (${e.message})\n`);
    process.exit(1);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    process.stdout.write('ERROR:monitor_mod:settings is not a JSON object\n');
    process.exit(1);
  }

  let result;
  try {
    result = ensureMonitorMod(settings, { ownmindDir, home, platform, optOut });
  } catch (e) {
    process.stdout.write(`ERROR:monitor_mod:${e.message}\n`);
    process.exit(1);
  }

  if (result.changed) {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const tmp = `${settingsPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(result.settings, null, 2));
      fs.renameSync(tmp, settingsPath);
    } catch (e) {
      process.stdout.write(`ERROR:monitor_mod:cannot write settings (${e.message})\n`);
      process.exit(1);
    }
  }

  process.stdout.write(`OK:monitor_mod:${isMissing ? 'missing' : result.status}\n`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { ensureMonitorMod, parseArgs, comparable, modDir, toNative };
