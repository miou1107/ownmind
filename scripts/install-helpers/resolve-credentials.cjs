'use strict';
// resolve-credentials.cjs — where the OwnMind API key and URL live, answered in one place.
//
// v1.26.82. Required by the usage scanner, both SessionStart hooks and the installer's
// self-check: the components that stop dead when the lookup comes back empty.
//
// Why this file exists
// --------------------
// Adam's machine, 2026-08-06. His MCP had been running and uploading for weeks. In the
// same period his usage scanner died (7/15), his upgrade beacons stopped (7/8), his memory
// hook had never fired at all, and the installer's self-check reported three failures
// saying `OWNMIND_API_KEY is empty`.
//
// One cause. **Everything except the MCP looked in `~/.claude/settings.json`, and his key
// is not there.** The MCP never reads a file — Claude Code hands it the key in its process
// environment — so it kept working while everything else went quiet, which is the worst
// possible arrangement: the one component that could have raised the alarm was the one
// component that was fine.
//
// On his machine the URL is in `~/.claude.json` (where Claude Code keeps MCP config now)
// and the key arrives as an `OWNMIND_API_KEY` environment variable.
//
// The distinction that is easy to miss
// ------------------------------------
// An environment variable is not equivalent to a file. The usage scanner runs from Task
// Scheduler / launchd, which does not inherit a shell's environment. Finding the key in
// `process.env` proves the MCP can work; it says nothing about the scanner. `background_safe`
// carries that difference, so a caller can report "your key exists, and the scanner will
// never see it" instead of "healthy".

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_VAR = 'OWNMIND_API_KEY';
const URL_VAR = 'OWNMIND_API_URL';

// Files first, environment last. A stale variable left in somebody's shell must not
// silently override the configured value — but it is still better than nothing, which is
// the situation this whole file exists to fix.
const FILE_SOURCES = [
  path.join('.claude', 'settings.json'),
  path.join('.claude', 'settings.local.json'),
  '.claude.json',
];

/**
 * @param {object}  [opts]
 * @param {string}  [opts.home]  home directory (tests)
 * @param {object}  [opts.env]   environment (tests)
 * @returns {{
 *   apiKey: string, apiUrl: string,
 *   source: { key: string|null, url: string|null },
 *   background_safe: boolean,
 *   checked: Array<{ where: string, exists: boolean, hasKey: boolean, hasUrl: boolean }>
 * }}
 *
 * `source` and `checked` are safe to log and to upload: they name locations, never values.
 */
function resolveCredentials({ home = os.homedir(), env = process.env } = {}) {
  const checked = [];
  let apiKey = '';
  let apiUrl = '';
  const source = { key: null, url: null };

  const take = (where, k, u, exists) => {
    checked.push({ where, exists, hasKey: Boolean(k), hasUrl: Boolean(u) });
    if (!apiKey && k) { apiKey = k; source.key = where; }
    if (!apiUrl && u) { apiUrl = u; source.url = where; }
  };

  for (const rel of FILE_SOURCES) {
    const full = path.join(home, rel);
    let exists = false;
    let envBlock = {};
    try {
      exists = fs.existsSync(full);
      if (exists) {
        // One unreadable or malformed file must not hide a key that is somewhere else.
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        envBlock = parsed?.mcpServers?.ownmind?.env || {};
      }
    } catch { envBlock = {}; }
    take(rel.split(path.sep).join('/'), envBlock[KEY_VAR], envBlock[URL_VAR], exists);
  }

  take('env', env?.[KEY_VAR], env?.[URL_VAR], true);

  // True only when the key came out of a file. A scheduled task can read a file; it cannot
  // read the environment of the shell the user happened to configure.
  const background_safe = Boolean(apiKey) && source.key !== 'env';

  return { apiKey: apiKey || '', apiUrl: apiUrl || '', source, background_safe, checked };
}

module.exports = { resolveCredentials, KEY_VAR, URL_VAR, FILE_SOURCES };
