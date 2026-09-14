'use strict';
// migrate-api-url.cjs — follow the server when it moves host.
//
// The address of the server lives in each machine's own config file, and nothing on the
// server can reach into a laptop to edit it. So when a server moves, the only way its
// clients follow is for the server to say so in an answer they already ask for
// (`canonical_url` on the init response) and for the unattended update to act on it.
//
// Until every machine has followed, the old address has to keep answering through a proxy,
// and that proxy is a single line of configuration holding up everybody. This is what lets
// it be retired.
//
// No address is written into this file. It reads where the machine currently points, asks
// that server where it should be pointing, and rewrites only when the two differ. A
// self-hosted server that sets nothing keeps every client exactly where it is.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_VAR = 'OWNMIND_API_KEY';
const URL_VAR = 'OWNMIND_API_URL';

/** The files that can hold an MCP server entry, same list as resolve-credentials.cjs. */
const FILE_SOURCES = [
  path.join('.claude', 'settings.json'),
  path.join('.claude', 'settings.local.json'),
  '.claude.json',
];

function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

const normalise = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();

/** Two addresses are the same place when only a trailing slash or letter case differs. */
function sameAddress(a, b) {
  return normalise(a) !== '' && normalise(a) === normalise(b);
}

/**
 * Every `mcpServers.*.env` block in a parsed config, including the per-project copies that
 * ~/.claude.json carries — a machine that has opened four projects holds four of them, and
 * rewriting only the top-level one leaves three projects pointing at the old address.
 */
function collectEnvBlocks(config, out = []) {
  if (!config || typeof config !== 'object') return out;
  const servers = config.mcpServers;
  if (servers && typeof servers === 'object') {
    for (const entry of Object.values(servers)) {
      if (entry && typeof entry.env === 'object' && entry.env) out.push(entry.env);
    }
  }
  const projects = config.projects;
  if (projects && typeof projects === 'object') {
    for (const project of Object.values(projects)) collectEnvBlocks(project, out);
  }
  return out;
}

/** What this machine currently points at, and the key it uses, from the first file that has them. */
function readCurrent(home) {
  for (const rel of FILE_SOURCES) {
    const file = path.join(home, rel);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
      for (const env of collectEnvBlocks(parsed)) {
        if (env[URL_VAR]) return { url: env[URL_VAR], key: env[KEY_VAR] || process.env[KEY_VAR] || '' };
      }
    } catch { /* an unreadable config is handled in rewriteTo */ }
  }
  const envUrl = process.env[URL_VAR];
  return envUrl ? { url: envUrl, key: process.env[KEY_VAR] || '' } : null;
}

/**
 * Ask the server where it says it should be reached.
 *
 * @returns {Promise<string>} the canonical address, or '' when the server names none,
 *   cannot be reached, or answers with something unusable. Every one of those means
 *   "change nothing", which is the safe outcome inside an unattended update.
 */
async function askServerForCanonicalUrl(current, fetchImpl = globalThis.fetch) {
  if (!current || !current.url || !current.key) return '';
  const base = String(current.url).replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/api/memory/init?compact=true&client_version=url-check`, {
      headers: { Authorization: `Bearer ${current.key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const canonical = data && typeof data.canonical_url === 'string' ? data.canonical_url.trim() : '';
    // Only an absolute https address is worth acting on: this value decides where every
    // future request and every stored memory goes.
    if (!/^https:\/\/[^\s/]+/i.test(canonical)) return '';
    return canonical;
  } catch {
    return '';
  }
}

/**
 * Point every config on this machine at `newUrl`, replacing `oldUrl` only.
 *
 * @returns {{ changed: number, files: Array<{path: string, changed: number, error?: string}> }}
 */
function rewriteTo(oldUrl, newUrl, opts = {}) {
  const home = opts.home || os.homedir();
  const report = { changed: 0, files: [] };
  if (!normalise(oldUrl) || !normalise(newUrl) || sameAddress(oldUrl, newUrl)) return report;

  for (const rel of FILE_SOURCES) {
    const file = path.join(home, rel);
    if (!fs.existsSync(file)) continue;

    let parsed;
    try {
      parsed = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      // A config we cannot parse is a config we must not write. This runs inside an
      // unattended update, where throwing would abort the update over a file it did not
      // come for.
      report.files.push({ path: file, changed: 0, error: err.message });
      continue;
    }

    let changed = 0;
    for (const env of collectEnvBlocks(parsed)) {
      if (sameAddress(env[URL_VAR], oldUrl)) {
        env[URL_VAR] = newUrl;
        changed += 1;
      }
    }

    if (changed > 0 && !opts.dryRun) {
      try {
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

/** The whole move: read where we point, ask that server, rewrite if it names somewhere else. */
async function followServerMove(opts = {}) {
  const home = opts.home || os.homedir();
  const current = opts.current || readCurrent(home);
  if (!current) return { changed: 0, files: [], from: '', to: '' };

  const canonical = opts.canonicalUrl !== undefined
    ? opts.canonicalUrl
    : await askServerForCanonicalUrl(current, opts.fetchImpl);

  if (!canonical || sameAddress(canonical, current.url)) {
    return { changed: 0, files: [], from: current.url, to: '' };
  }

  const result = rewriteTo(current.url, canonical, { home, dryRun: opts.dryRun });
  return { ...result, from: current.url, to: canonical };
}

module.exports = {
  followServerMove,
  rewriteTo,
  readCurrent,
  askServerForCanonicalUrl,
  collectEnvBlocks,
  sameAddress,
  FILE_SOURCES,
};

if (require.main === module) {
  followServerMove({ dryRun: process.argv.includes('--dry-run') })
    .then((result) => {
      for (const f of result.files) {
        if (f.error) console.error(`[ownmind] could not read ${f.path}: ${f.error}`);
      }
      if (result.changed > 0) {
        console.log(`[ownmind] OwnMind 的伺服器換了位置，你的設定已經改成新的 ${result.to}，你不用做任何事。`);
      }
    })
    .catch(() => { /* an update must not fail because of this step */ });
}
