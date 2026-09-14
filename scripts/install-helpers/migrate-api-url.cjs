'use strict';
// migrate-api-url.cjs — move a machine's configured server address to a new host.
//
// 2026-09-14: every user's memories moved from the old box to the company host. The old
// address still answers, because a proxy in front of it forwards to the new one, and that
// proxy is the problem: it is a single line in one nginx file that nobody owns, holding up
// nine people's OwnMind. The address in each machine's own config is the thing that has to
// change, and nothing on the server can reach into a laptop to change it.
//
// So the updater does it. OwnMind already updates itself unattended; this runs in that same
// pass, rewrites the address if it is still the old host, and leaves everything else alone.
// Nobody is asked to edit a JSON file, and nobody has to be told.
//
// Deliberately narrow: it rewrites ONE known host to ONE known host. A person running their
// own OwnMind server keeps their address, because their address is not the one being retired.

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The move this file exists for. Both are full base URLs, no trailing slash. */
const OLD_URL = 'https://legacy-server.example/ownmind';
const NEW_URL = 'https://prod-server.example/ownmind';

/** The files that can hold an MCP server entry, same list as resolve-credentials.cjs. */
const FILE_SOURCES = [
  path.join('.claude', 'settings.json'),
  path.join('.claude', 'settings.local.json'),
  '.claude.json',
];

function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/** true when `url` addresses the host being retired, whatever the trailing slash or case. */
function isOldAddress(url, oldUrl = OLD_URL) {
  if (typeof url !== 'string' || !url) return false;
  const norm = (u) => u.trim().replace(/\/+$/, '').toLowerCase();
  return norm(url) === norm(oldUrl);
}

/**
 * Walk every `mcpServers.*.env.OWNMIND_API_URL` in a parsed config and rewrite the ones
 * still pointing at the old host.
 *
 * @returns {number} how many entries changed
 */
function rewriteInConfig(config, oldUrl, newUrl) {
  if (!config || typeof config !== 'object') return 0;
  let changed = 0;

  const servers = config.mcpServers;
  if (servers && typeof servers === 'object') {
    for (const entry of Object.values(servers)) {
      const env = entry && entry.env;
      if (env && typeof env === 'object' && isOldAddress(env.OWNMIND_API_URL, oldUrl)) {
        env.OWNMIND_API_URL = newUrl;
        changed += 1;
      }
    }
  }

  // ~/.claude.json keeps per-project copies of the same block, and a machine that has
  // opened several projects carries several. Missing those leaves the old address in place
  // for every project except the one that happened to be at the top level.
  const projects = config.projects;
  if (projects && typeof projects === 'object') {
    for (const project of Object.values(projects)) {
      changed += rewriteInConfig(project, oldUrl, newUrl);
    }
  }

  return changed;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.home]    home directory (tests)
 * @param {string} [opts.oldUrl]  address to replace
 * @param {string} [opts.newUrl]  address to write
 * @param {boolean} [opts.dryRun] report what would change, write nothing
 * @returns {{ changed: number, files: Array<{path: string, changed: number, error?: string}> }}
 */
function migrateApiUrl(opts = {}) {
  const home = opts.home || os.homedir();
  const oldUrl = opts.oldUrl || OLD_URL;
  const newUrl = opts.newUrl || NEW_URL;
  const report = { changed: 0, files: [] };

  for (const rel of FILE_SOURCES) {
    const file = path.join(home, rel);
    if (!fs.existsSync(file)) continue;

    let parsed;
    let raw;
    try {
      raw = stripBom(fs.readFileSync(file, 'utf8'));
      parsed = JSON.parse(raw);
    } catch (err) {
      // A config we cannot parse is a config we must not write. Say so and move on:
      // this runs inside an unattended update, where throwing would abort the update
      // over a file that has nothing to do with it.
      report.files.push({ path: file, changed: 0, error: err.message });
      continue;
    }

    const changed = rewriteInConfig(parsed, oldUrl, newUrl);
    if (changed > 0 && !opts.dryRun) {
      try {
        // Indentation matches what the installers write. The file is rewritten whole,
        // which is also how install.ps1 and install.sh have always updated it.
        fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      } catch (err) {
        report.files.push({ path: file, changed: 0, error: err.message });
        continue;
      }
    }
    if (changed > 0) report.files.push({ path: file, changed });
    report.changed += changed;
  }

  return report;
}

module.exports = { migrateApiUrl, rewriteInConfig, isOldAddress, OLD_URL, NEW_URL, FILE_SOURCES };

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const result = migrateApiUrl({ dryRun });
  for (const f of result.files) {
    if (f.error) console.error(`[ownmind] could not read ${f.path}: ${f.error}`);
  }
  if (result.changed > 0) {
    console.log(`[ownmind] OwnMind 的伺服器換了位置，你的設定已經改成新的 ${NEW_URL}，你不用做任何事。`);
  }
}
