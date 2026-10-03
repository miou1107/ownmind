#!/usr/bin/env node
'use strict';
// secure-key-files.cjs: make every config file that holds the OwnMind API key readable by
// its owner only.
//
// Why this exists
// ---------------
// The key sits in plain text in ~/.claude.json, ~/.claude/settings.json and each other AI
// tool's MCP config. Every writer here and in install.sh / update.sh saves through a fresh
// temporary file and renames it over the original, and a fresh file takes the process
// umask, which on Mac and Linux is normally 022: readable by everybody on the machine. On a
// shared Mac or Linux box, any other account could open the file and act as this user.
//
// Fixing each writer is not enough on its own: there are a dozen of them, inline in shell
// scripts too, and AI tools rewrite their own config files as well. So this runs at the end
// of install and of every auto-update, and takes away group and other access from any file
// that holds the key. Already-installed machines are fixed by their next auto-update.
//
// It changes permissions only, never content. It skips Windows (a user's home folder is
// private there by default, and Node's chmod cannot express it), files owned by someone
// else, and files that do not mention the key.
//
// Usage:  node secure-key-files.cjs [--home <path>]
// Output: one "[ OK ] Key files" line listing what changed (nothing on Windows). Names
//         locations only, never values.
// Exit:   0 always. A failure here must never stop an update.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sourcesFor } = require('./migrate-api-url.cjs');
const { KEY_VAR } = require('./resolve-credentials.cjs');

/**
 * Each config that can hold the key, plus the copies made of it next to it: backups that
 * OwnMind's hook installers take before editing settings.json (`settings.json.bak.<time>`),
 * temporary files an interrupted write left behind, and Claude Code's own backups of
 * ~/.claude.json. A copy takes the permissions the original had at that moment, so a
 * backup made before the first sweep stays readable by everybody unless it is swept too.
 */
function candidates(home) {
  const out = [];
  const siblings = (dir, prefix) => {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(prefix)) out.push(path.join(dir, name));
      }
    } catch { /* no such folder */ }
  };
  for (const { file } of sourcesFor(home, { useEnv: true })) {
    out.push(file);
    siblings(path.dirname(file), `${path.basename(file)}.`);
  }
  siblings(path.join(home, '.claude', 'backups'), '.claude.json');
  return out;
}

/**
 * Remove group and other permissions from every key-holding config under `home`.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]      home directory (tests)
 * @param {string} [opts.platform]  process.platform (tests)
 * @param {number} [opts.uid]       current user id (tests)
 * @returns {{ skipped?: string, files: Array<{ path: string, before?: string, after?: string, error?: string }> }}
 */
function secureKeyFiles(opts = {}) {
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  if (platform === 'win32') return { skipped: 'windows', files: [] };
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);

  const files = [];
  const seen = new Set();
  for (const file of candidates(home)) {
    let real;
    try { real = fs.realpathSync(file); } catch (err) {
      if (err.code !== 'ENOENT') files.push({ path: file.split(home).join('~'), error: err.code || err.message });
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const shown = file.split(home).join('~');
    try {
      const st = fs.statSync(real);
      if (!st.isFile()) continue;
      if (uid !== null && st.uid !== uid) continue; // not ours to change
      if ((st.mode & 0o077) === 0) continue; // already private
      if (!fs.readFileSync(real, 'utf8').includes(KEY_VAR)) continue;
      const next = st.mode & 0o7700;
      fs.chmodSync(real, next);
      files.push({ path: shown, before: (st.mode & 0o777).toString(8), after: (next & 0o777).toString(8) });
    } catch (err) {
      files.push({ path: shown, error: err.code || err.message });
    }
  }
  return { files };
}

if (require.main === module) {
  const i = process.argv.indexOf('--home');
  const home = i > 0 ? process.argv[i + 1] : undefined;
  try {
    const result = secureKeyFiles({ home });
    if (!result.skipped) {
      const done = result.files.filter((f) => !f.error);
      const failed = result.files.filter((f) => f.error);
      console.log(`[ OK ] Key files: owner-only`
        + (done.length ? ` (${done.map((f) => `${f.path} ${f.before}->${f.after}`).join(', ')})` : ''));
      for (const f of failed) console.error(`secure-key-files: could not restrict ${f.path}: ${f.error}`);
    }
  } catch (err) {
    console.error(`secure-key-files: ${err.message}`);
  }
}

module.exports = { secureKeyFiles };
