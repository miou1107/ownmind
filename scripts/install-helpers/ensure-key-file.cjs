#!/usr/bin/env node
'use strict';
// ensure-key-file.cjs — make sure the API key lives somewhere a scheduled task can read it.
//
// v1.26.87. Sibling of ensure-session-hook.cjs, same discipline, different defect.
//
// Why this exists
// ---------------
// resolve-credentials.cjs already knows the answer and already reports it: when the key
// was found only in `process.env`, `background_safe` is false. The MCP is handed its
// environment by the AI tool, so it keeps working. The usage scanner is started by Task
// Scheduler / launchd and the SessionStart hooks are started by the AI tool's hook runner;
// neither inherits the shell the user configured, and neither can read anything but files.
//
// Until now the only consequence of `background_safe: false` was one line in the scanner's
// own log file (hooks/ownmind-usage-scanner.js), which is read by nobody, on a machine
// whose scanner has already stopped reporting. The install/upgrade self-check collected
// the flag and never looked at it. So the scanner and the memory hook were dead and every
// report said "healthy".
//
// Vin's decision, 2026-08-06: repair it automatically, never silently, and let someone opt
// out. This file is the repair — it copies the environment-only key into
// ~/.claude/settings.json under mcpServers.ownmind.env, which is the first place
// resolve-credentials.cjs looks and a place a scheduled task can actually read.
//
// Usage:  node ensure-key-file.cjs [--settings <path>] [--ownmind-dir <path>] [--home <path>]
// Output: one line — "<OK|ERROR>:keyfile:<outcome> <human summary>"
//         OK:keyfile:already_safe | OK:keyfile:repaired | OK:keyfile:opted_out
//         OK:keyfile:no_credentials | ERROR:keyfile:error <why>
// Exit:   0 on any OK, 1 on error. Never throws.
//
// Opt out: `touch ~/.ownmind/.no-key-file` — same shape as ~/.ownmind/.no-session-hook.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveCredentials, KEY_VAR, URL_VAR } = require('./resolve-credentials.cjs');

const OPT_OUT_FILE = '.no-key-file';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--settings') args.settings = argv[++i];
    else if (argv[i] === '--ownmind-dir') args.ownmindDir = argv[++i];
    // Lets the tests point the whole lookup at a sandbox. The real callers never pass it.
    else if (argv[i] === '--home') args.home = argv[++i];
  }
  return args;
}

/** Never print the key. `sanitize` turns an absolute path back into `~/...`. */
function sanitize(s, home) {
  const str = String(s ?? '');
  return home ? str.split(home).join('~') : str;
}

/**
 * Repair the one thing that makes background runs work: the key being in a file.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.home]         home directory (tests)
 * @param {object}  [opts.env]          environment (tests)
 * @param {string}  [opts.settings]     settings.json to write into
 * @param {string}  [opts.ownmindDir]   where the opt-out marker lives
 * @returns {{ outcome: string, summary: string, wroteKey: boolean, wroteUrl: boolean,
 *             settingsPath: string|null, source: string|null }}
 *
 * `outcome` is one of: already_safe | repaired | opted_out | no_credentials | error.
 * `summary` is one line of English, safe to print and safe to upload: it names locations,
 * never values.
 */
function ensureKeyFile(opts = {}) {
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const settingsPath = opts.settings || path.join(home, '.claude', 'settings.json');
  const ownmindDir = opts.ownmindDir || path.join(home, '.ownmind');
  const shown = sanitize(settingsPath, home);

  const done = (outcome, summary, extra = {}) => ({
    outcome, summary, wroteKey: false, wroteUrl: false,
    settingsPath: shown, source: null, ...extra,
  });

  // The documented opt-out, honored before anything is read or written. A user who does not
  // want their key written into a file must not have it written by the next daily update.
  try {
    if (fs.existsSync(path.join(ownmindDir, OPT_OUT_FILE))) {
      return done('opted_out',
        `opted out via ~/.ownmind/${OPT_OUT_FILE}; the key is left where it is, so scheduled `
        + 'runs will not see it');
    }
  } catch (e) {
    return done('error', `cannot read the opt-out marker (${sanitize(e.message, home)})`);
  }

  let resolved;
  try {
    resolved = resolveCredentials({ home, env });
  } catch (e) {
    return done('error', `cannot resolve credentials (${sanitize(e.message, home)})`);
  }

  if (!resolved.apiKey) {
    // Nothing to copy. Not an error: this machine has no credentials at all, which
    // api_key_format already reports, and inventing a second complaint about the same
    // fact helps nobody.
    return done('no_credentials', 'no API key was found anywhere, so there is nothing to write');
  }

  if (resolved.background_safe) {
    return done('already_safe',
      `the API key is in ${resolved.source.key}, which a scheduled run can read`,
      { source: resolved.source.key });
  }

  // From here on: the key exists and came from the environment only.
  let settings = {};
  let exists = false;
  try {
    exists = fs.existsSync(settingsPath);
    if (exists) {
      // Strip a BOM: Windows PowerShell 5.1 writes them and JSON.parse rejects them.
      // Written as an escape — a literal U+FEFF in source is invisible and one
      // "normalize invisible characters" editor pass away from silently vanishing.
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    }
  } catch (e) {
    // Never overwrite a file we could not read — that would destroy every other setting
    // the user has, to fix a problem that is merely making things quiet.
    return done('error', `${shown} is unreadable (${sanitize(e.message, home)}), so it was left untouched`);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    // Valid JSON but not a settings object (an array, a number, ...). An array passes a
    // typeof check and then silently drops named properties on stringify — the run would
    // claim success while writing nothing. Refuse, like any other unreadable file.
    return done('error', `${shown} is valid JSON but not an object, so it was left untouched`);
  }

  if (!settings.mcpServers || typeof settings.mcpServers !== 'object' || Array.isArray(settings.mcpServers)) {
    settings.mcpServers = {};
  }
  if (!settings.mcpServers.ownmind || typeof settings.mcpServers.ownmind !== 'object'
      || Array.isArray(settings.mcpServers.ownmind)) {
    settings.mcpServers.ownmind = {};
  }
  const block = settings.mcpServers.ownmind;
  if (!block.env || typeof block.env !== 'object' || Array.isArray(block.env)) block.env = {};

  block.env[KEY_VAR] = resolved.apiKey;
  // The URL only when it is environment-only too. If it already sits in a file, that file
  // is the configured value and this one is a shell variable that may be stale.
  const wroteUrl = Boolean(resolved.apiUrl) && resolved.source.url === 'env';
  if (wroteUrl) block.env[URL_VAR] = resolved.apiUrl;

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    // Temp file then rename: an interrupted run must never leave half a settings file,
    // because half a settings file is worse than the problem being fixed.
    const tmp = `${settingsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    fs.renameSync(tmp, settingsPath);
  } catch (e) {
    return done('error', `cannot write ${shown} (${sanitize(e.message, home)})`);
  }

  return done('repaired',
    `the API key was only in this shell's environment, where a scheduled run cannot see it; `
    + `wrote ${wroteUrl ? 'it and the API URL' : 'it'} to ${shown}`,
    { wroteKey: true, wroteUrl, source: 'env' });
}

function main() {
  const args = parseArgs(process.argv);
  const result = ensureKeyFile({
    home: args.home,
    settings: args.settings,
    ownmindDir: args.ownmindDir,
  });
  const ok = result.outcome !== 'error';
  process.stdout.write(`${ok ? 'OK' : 'ERROR'}:keyfile:${result.outcome} ${result.summary}\n`);
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { ensureKeyFile, parseArgs, OPT_OUT_FILE };
