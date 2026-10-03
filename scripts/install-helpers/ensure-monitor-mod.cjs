#!/usr/bin/env node
'use strict';
// ensure-monitor-mod.cjs — make Claude Code load the OwnMind mods from this OwnMind checkout.
// One implementation, called from install.sh, update.sh, install.ps1 and update.ps1.
//
// v1.30.45 wired one mod (ownmind-monitor). Since the wrap-up check (mods/wrapup-check) the
// same helper manages every folder in MODS; the file keeps its name so older update scripts
// that call it by name keep working.
//
// Each mod is a Claude Code plugin made of function hooks. Claude Code loads such a folder
// when ~/.claude/settings.json has, in its "env" block:
//
//   CLAUDE_CODE_PLUGIN_DIRS            one or more folders, joined by the platform's
//                                      path-list separator (':' on macOS/Linux, ';' on Windows)
//   CLAUDE_CODE_ENABLE_FUNCTION_HOOKS  "1"
//
// The folders we add are inside the OwnMind checkout, so every later `git pull` delivers the
// newest mods with no further step. Whatever else the user lists in CLAUDE_CODE_PLUGIN_DIRS is
// kept, in order. Entries that name one of our mods somewhere else — a hand-installed copy
// under ~/.claude/mods/<name>, in tilde or expanded form, or this same folder spelled
// differently — are replaced by the one canonical path, so a mod is never loaded twice.
//
// Opt out of one mod: create its marker file in ~/.ownmind (see MODS). The helper then removes
// that mod's entry and leaves everything else alone. A mod folder missing from the checkout
// (an older checkout, a rollback) is treated the same way.
//
// Usage:  node ensure-monitor-mod.cjs [--settings <path>] [--ownmind-dir <path>]
//                                     [--home <path>] [--platform <darwin|linux|win32>]
//         (--home and --platform are for the tests only: they exercise another platform's
//         paths, so --platform also skips the check that the mod folders exist on disk.)
// Output: one machine-readable line, one status per mod —
//         OK:mods:ownmind-monitor=unchanged,wrapup-check=installed
//         statuses: unchanged | installed | updated | opted_out | missing
//         ERROR:mods:<why>
// Exit:   0 on any OK, 1 on error. Never throws.

const fs = require('fs');
const os = require('os');
const path = require('path');

// name: the folder under mods/ and under ~/.claude/mods/ (the hand-installed location);
// optOut: the marker file under ~/.ownmind that turns that mod off.
const MODS = [
  { name: 'ownmind-monitor', optOut: '.no-monitor-mod' },
  { name: 'wrapup-check', optOut: '.no-wrapup-mod' },
];
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

function modDir(ownmindDir, platform, name = MODS[0].name) {
  return pathApi(platform).join(toNative(ownmindDir, platform), 'mods', name);
}

/**
 * Pure transform over the settings object. `optOut` names the mods to drop (opted out, or
 * missing from the checkout); every other managed mod is placed. `only` limits which mods are
 * managed at all — an entry of a mod not listed there is left exactly as the user wrote it.
 * @returns {{ statuses: Record<string, string>, changed: boolean, settings: object }}
 */
function ensureMods(settings, { ownmindDir, home = os.homedir(), platform = process.platform, optOut = [], only = null }) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const before = JSON.stringify(s);
  const sep = separator(platform);
  const ctx = { home: toNative(home, platform), platform };
  const dropped = new Set(optOut);

  // For each mod: its canonical folder, and every spelling that means "this mod".
  const managed = only ? MODS.filter((m) => only.includes(m.name)) : MODS;
  const plan = managed.map(({ name }) => {
    const target = modDir(ownmindDir, platform, name);
    const targetKey = comparable(target, ctx);
    const ours = new Set([
      targetKey,
      comparable(pathApi(platform).join(ctx.home, '.claude', 'mods', name), ctx),
    ]);
    return { name, target, targetKey, ours, placed: false };
  });

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
  for (const raw of existing) {
    const entry = raw.trim();
    if (!entry) continue;
    const key = comparable(entry, ctx);
    const mine = plan.find((m) => m.ours.has(key));
    if (mine) {
      // The first entry that names this mod becomes the canonical path, in the same position.
      if (!dropped.has(mine.name) && !mine.placed) { kept.push(mine.target); seen.add(mine.targetKey); mine.placed = true; }
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  for (const m of plan) {
    if (!dropped.has(m.name) && !m.placed) { kept.push(m.target); m.placed = true; }
  }

  const anyPlaced = plan.some((m) => m.placed);
  if (anyPlaced) {
    env[DIRS_KEY] = kept.join(sep);
    env[FLAG_KEY] = '1';
    if (!hadEnv) s.env = env;
  } else if (hadEnv && DIRS_KEY in env) {
    // Every mod is off: leave the user's other folders, or drop the key when none are left.
    if (kept.length) env[DIRS_KEY] = kept.join(sep);
    else delete env[DIRS_KEY];
  }

  const changed = JSON.stringify(s) !== before;
  // Per-mod status, from how the mod was named before this run:
  //   not named at all, or only by another spelling (a hand-installed copy)  -> installed
  //   named once, by its canonical path, with nothing else to repair         -> unchanged
  //   anything else that made the file change (another spelling too, a tilde
  //   or trailing slash to normalise, the flag that was off)                  -> updated
  const beforeDirs = existing.map((e) => e.trim()).filter(Boolean);
  const flagWasOn = hadEnv && settings.env && JSON.parse(before).env?.[FLAG_KEY] === '1';
  const statuses = {};
  for (const m of plan) {
    if (dropped.has(m.name)) { statuses[m.name] = 'opted_out'; continue; }
    const mentions = beforeDirs.filter((e) => m.ours.has(comparable(e, ctx)));
    const canonical = mentions.filter((e) => e === m.target);
    if (mentions.length > 0 && canonical.length === 0 && !mentions.some((e) => comparable(e, ctx) === m.targetKey)) statuses[m.name] = 'installed';
    else if (mentions.length === 0) statuses[m.name] = 'installed';
    else if (mentions.length === 1 && canonical.length === 1 && (flagWasOn || !changed)) statuses[m.name] = 'unchanged';
    else statuses[m.name] = 'updated';
  }
  return { statuses, changed, settings: s };
}

// Back-compat for callers of the single-mod transform (v1.30.45): manages the monitor mod only
// and leaves every other mod's entry exactly as it is.
function ensureMonitorMod(settings, opts) {
  const { optOut = false, ...rest } = opts;
  const monitor = MODS[0].name;
  const r = ensureMods(settings, { ...rest, only: [monitor], optOut: optOut ? [monitor] : [] });
  return { status: r.statuses[monitor], changed: r.changed, settings: r.settings };
}

function main() {
  const args = parseArgs(process.argv);
  const platform = args.platform || process.platform;
  const home = args.home || os.homedir();
  const settingsPath = args.settings || path.join(os.homedir(), '.claude', 'settings.json');
  const ownmindDir = toNative(args.ownmindDir || path.join(os.homedir(), '.ownmind'), platform);

  // Pointing Claude Code at a folder that is not there would only produce a warning on every
  // start, so a missing mod folder (an older checkout, a rollback) removes our entry the same
  // way the opt-out does. Not checked when --platform is passed: that flag exists only for
  // the tests, which hand in another platform's paths that are not on this disk. The
  // installers never pass --platform.
  const optOut = [];
  const missing = new Set();
  for (const m of MODS) {
    if (fs.existsSync(path.join(ownmindDir, m.optOut))) { optOut.push(m.name); continue; }
    if (!args.platform && !fs.existsSync(path.join(ownmindDir, 'mods', m.name, '.claude-plugin', 'plugin.json'))) {
      optOut.push(m.name);
      missing.add(m.name);
    }
  }

  let settings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      // Strip a BOM: Windows PowerShell 5.1 writes them and JSON.parse rejects them.
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    }
  } catch (e) {
    // Never overwrite a file we could not read — that would destroy the user's other settings.
    process.stdout.write(`ERROR:mods:settings unreadable (${e.message})\n`);
    process.exit(1);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    process.stdout.write('ERROR:mods:settings is not a JSON object\n');
    process.exit(1);
  }

  let result;
  try {
    result = ensureMods(settings, { ownmindDir, home, platform, optOut });
  } catch (e) {
    process.stdout.write(`ERROR:mods:${e.message}\n`);
    process.exit(1);
  }

  if (result.changed) {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const tmp = `${settingsPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(result.settings, null, 2));
      fs.renameSync(tmp, settingsPath);
    } catch (e) {
      process.stdout.write(`ERROR:mods:cannot write settings (${e.message})\n`);
      process.exit(1);
    }
  }

  const line = MODS.map((m) => `${m.name}=${missing.has(m.name) ? 'missing' : result.statuses[m.name]}`).join(',');
  process.stdout.write(`OK:mods:${line}\n`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { ensureMods, ensureMonitorMod, parseArgs, comparable, modDir, toNative, MODS };
