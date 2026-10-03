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
// No address is written into this file. It reads every address this machine points at, asks
// each of those servers where it should be reached, and rewrites only where the answer names
// somewhere else. A self-hosted server that sets nothing keeps every client exactly where it is.
//
// Every address, not just Claude Code's (#152). Codex, Windsurf, OpenCode and Cursor each
// keep their own copy. The first version asked only the server Claude Code points at, so on
// a machine where Claude Code had already moved the answer was "right here" and the other
// tools were never looked at.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_VAR = 'OWNMIND_API_KEY';
const URL_VAR = 'OWNMIND_API_URL';

/** Claude Code's files, same list as resolve-credentials.cjs. readCurrent looks only here. */
const FILE_SOURCES = [
  path.join('.claude', 'settings.json'),
  path.join('.claude', 'settings.local.json'),
  '.claude.json',
];

/**
 * Every file on this machine that can hold the address, and the tool it belongs to.
 * JSON files are searched for any object carrying OWNMIND_API_URL, which covers
 * `mcpServers.*.env` (Claude Code, Cursor, Windsurf, Gemini CLI) and OpenCode's
 * `mcp.*.environment` alike. Codex keeps TOML, which is edited as text so that nothing
 * but the address changes.
 */
function sourcesFor(home, { useEnv = false } = {}) {
  const codexHome = useEnv && process.env.CODEX_HOME ? process.env.CODEX_HOME : path.join(home, '.codex');
  return [
    ...FILE_SOURCES.map((rel) => ({ file: path.join(home, rel), tool: 'Claude Code', format: 'json' })),
    { file: path.join(home, '.cursor', 'mcp.json'), tool: 'Cursor', format: 'json' },
    { file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), tool: 'Windsurf', format: 'json' },
    { file: path.join(home, '.config', 'opencode', 'opencode.json'), tool: 'OpenCode', format: 'json' },
    { file: path.join(home, '.opencode.json'), tool: 'OpenCode', format: 'json' },
    { file: path.join(home, '.gemini', 'settings.json'), tool: 'Gemini CLI', format: 'json' },
    { file: path.join(codexHome, 'config.toml'), tool: 'Codex', format: 'toml' },
  ];
}

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

/** Every object anywhere in a parsed JSON config that carries the address. */
function collectUrlHolders(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (!Array.isArray(node) && typeof node[URL_VAR] === 'string') out.push(node);
  for (const child of Object.values(node)) collectUrlHolders(child, out);
  return out;
}

// `OWNMIND_API_URL = "..."`, whether on its own line under [mcp_servers.x.env] or inside an
// inline `env = { ... }` table.
const TOML_URL = /(\bOWNMIND_API_URL\s*=\s*)(["'])([^"'\r\n]*)\2/g;
const TOML_KEY = /\bOWNMIND_API_KEY\s*=\s*(["'])([^"'\r\n]*)\1/;
const TOML_TABLE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const TOML_COMMENT = /^\s*#/;

/**
 * Walk a TOML file line by line, knowing which table each line sits in. A key is paired only
 * with an address in the same table, so a file holding two servers never sends one server's
 * key to the other; a commented-out line is neither read nor rewritten.
 *
 * `[mcp_servers.x]` with an inline `env = {…}` and `[mcp_servers.x.env]` are the same server,
 * so a trailing `.env` is dropped from the table name before pairing.
 */
function tomlLines(text) {
  let table = '';
  return text.split(/(?<=\n)/).map((line) => {
    const header = line.match(TOML_TABLE);
    if (header) table = header[1].replace(/\.env$/, '');
    return { line, table, live: !header && !TOML_COMMENT.test(line) };
  });
}

/** Read one source. @returns {{ text, parsed?, error? } | null} null when the file is absent. */
function load(source) {
  if (!fs.existsSync(source.file)) return null;
  let text;
  try {
    text = fs.readFileSync(source.file, 'utf8');
  } catch (err) {
    return { error: err.message };
  }
  if (source.format === 'toml') return { text };
  try {
    return { text, parsed: JSON.parse(stripBom(text)) };
  } catch (err) {
    return { text, error: err.message };
  }
}

/** The addresses one loaded source names, each with the key stored beside it. */
function addressesIn(source, loaded) {
  if (source.format === 'toml') {
    const keys = new Map();
    const urls = [];
    for (const { line, table, live } of tomlLines(loaded.text)) {
      if (!live) continue;
      const k = line.match(TOML_KEY);
      if (k && !keys.has(table)) keys.set(table, k[2]);
      for (const m of line.matchAll(TOML_URL)) urls.push({ url: m[3], table });
    }
    return urls.map(({ url, table }) => ({ url, key: keys.get(table) || '' }));
  }
  return collectUrlHolders(loaded.parsed).map((h) => ({ url: h[URL_VAR], key: h[KEY_VAR] || '' }));
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
    return isUsableAddress(canonical) ? canonical : '';
  } catch {
    return '';
  }
}

/**
 * Only an absolute https address is worth acting on: this value decides where every future
 * request and every stored memory goes, and it is written verbatim into JSON and TOML strings,
 * so a quote, backslash or control character would break the file it lands in.
 */
function isUsableAddress(u) {
  if (!/^https:\/\/[^\s/]+/i.test(u) || /["'\\\u0000-\u001f\u007f]/.test(u)) return false;
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

/**
 * Write through a temporary file, so a failure part-way never leaves half a config behind.
 *
 * The rename lands on the real file behind a symlink (dotfile managers link these), and the
 * temporary copy takes the original's permissions, because these files hold an API key. If
 * anything fails the temporary copy is removed: it is a full copy of the config, key included.
 */
function writeAtomic(file, text) {
  const target = fs.realpathSync(file);
  const tmp = `${target}.ownmind-tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: fs.statSync(target).mode });
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/**
 * Point every config on this machine at `newUrl`, replacing `oldUrl` only, then read each
 * changed file back: an update that says it moved the address is not evidence that it did.
 *
 * @returns {{ changed: number, files: Array<{path, tool, changed, verified?, error?}> }}
 */
function rewriteTo(oldUrl, newUrl, opts = {}) {
  const home = opts.home || os.homedir();
  const sources = opts.sources || sourcesFor(home);
  const report = { changed: 0, files: [] };
  if (!normalise(oldUrl) || !normalise(newUrl) || sameAddress(oldUrl, newUrl)) return report;

  for (const source of sources) {
    const loaded = load(source);
    if (!loaded) continue;
    if (loaded.error) {
      // A config we cannot parse is a config we must not write. This runs inside an
      // unattended update, where throwing would abort the update over a file it did not
      // come for.
      report.files.push({ path: source.file, tool: source.tool, changed: 0, error: loaded.error });
      continue;
    }

    let changed = 0;
    let output;
    if (source.format === 'toml') {
      output = tomlLines(loaded.text).map(({ line, live }) => (!live ? line
        : line.replace(TOML_URL, (whole, lead, quote, value) => {
          if (!sameAddress(value, oldUrl)) return whole;
          changed += 1;
          return `${lead}${quote}${newUrl}${quote}`;
        }))).join('');
    } else {
      for (const holder of collectUrlHolders(loaded.parsed)) {
        if (sameAddress(holder[URL_VAR], oldUrl)) {
          holder[URL_VAR] = newUrl;
          changed += 1;
        }
      }
      output = JSON.stringify(loaded.parsed, null, 2) + '\n';
    }
    if (changed === 0) continue;

    const entry = { path: source.file, tool: source.tool, changed, movedTo: newUrl };
    if (!opts.dryRun) {
      try {
        writeAtomic(source.file, output);
        const back = load(source);
        const left = back && !back.error
          ? addressesIn(source, back).filter((a) => sameAddress(a.url, oldUrl)).length
          : -1;
        if (left !== 0) {
          entry.error = left < 0
            ? 'the file could not be read back after writing'
            : `read back after writing, it still names the old address ${left} time(s)`;
        } else {
          entry.verified = true;
        }
      } catch (err) {
        report.files.push({ path: source.file, tool: source.tool, changed: 0, error: err.message });
        continue;
      }
    }
    report.files.push(entry);
    if (!entry.error) report.changed += changed;
  }

  return report;
}

/**
 * The whole move: gather every address on the machine, ask each one's server where it should
 * be, and rewrite the ones whose server names somewhere else.
 *
 * A server is asked only with the key stored beside its own address (or OWNMIND_API_KEY from
 * the environment, which is what Codex's setup guide uses). Another tool's key is never sent
 * to it: two tools pointing at two different servers may hold keys for two different accounts.
 * An address with no key to ask with is reported in `skipped` rather than dropped.
 */
async function followServerMove(opts = {}) {
  const home = opts.home || os.homedir();
  const sources = opts.sources || sourcesFor(home, { useEnv: !opts.home });

  const byAddress = new Map();
  const note = (url, key) => {
    if (!normalise(url)) return;
    const id = normalise(url);
    const seen = byAddress.get(id);
    if (!seen) byAddress.set(id, { url, key: key || '' });
    else if (!seen.key && key) seen.key = key;
  };
  const result = { changed: 0, files: [], skipped: [], moves: [], from: '', to: '' };
  const unreadable = new Set();
  if (opts.current) note(opts.current.url, opts.current.key);
  for (const source of sources) {
    const loaded = load(source);
    if (!loaded) continue;
    if (loaded.error) {
      // Reported here, not only when a move would have touched it: on a machine whose other
      // configs already moved, nothing else would ever mention this file.
      result.files.push({ path: source.file, tool: source.tool, changed: 0, error: loaded.error });
      unreadable.add(source.file);
      continue;
    }
    for (const a of addressesIn(source, loaded)) note(a.url, a.key);
  }
  if (byAddress.size === 0 && process.env[URL_VAR]) note(process.env[URL_VAR], process.env[KEY_VAR]);

  for (const { url, key } of byAddress.values()) {
    let canonical;
    if (opts.canonicalUrl !== undefined) {
      canonical = opts.canonicalUrl;
    } else {
      const askWith = key || process.env[KEY_VAR] || '';
      if (!askWith) {
        result.skipped.push({ url, reason: 'no key is stored beside this address, so its server cannot be asked' });
        continue;
      }
      canonical = await askServerForCanonicalUrl({ url, key: askWith }, opts.fetchImpl);
    }
    if (!canonical || sameAddress(canonical, url)) continue;

    const r = rewriteTo(url, canonical, { home, sources, dryRun: opts.dryRun });
    result.changed += r.changed;
    result.files.push(...r.files.filter((f) => !(f.error && unreadable.has(f.path))));
    if (r.changed > 0) {
      result.moves.push({ from: url, to: canonical });
      result.from = url;
      result.to = canonical;
    }
  }
  return result;
}

module.exports = {
  followServerMove,
  rewriteTo,
  readCurrent,
  askServerForCanonicalUrl,
  collectEnvBlocks,
  collectUrlHolders,
  sameAddress,
  sourcesFor,
  FILE_SOURCES,
};

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  followServerMove({ dryRun })
    .then((result) => {
      for (const f of result.files) {
        if (f.error) console.error(`[ownmind] ${f.tool} 的設定 ${f.path} 沒有改成功：${f.error}`);
      }
      for (const s of result.skipped) {
        console.error(`[ownmind] 沒辦法確認 ${s.url} 有沒有搬家：這個網址旁邊沒有存金鑰，不能拿別的工具的金鑰去問它。`);
      }
      for (const move of result.moves) {
        const tools = [...new Set(result.files
          .filter((f) => f.movedTo === move.to && !f.error && (dryRun || f.verified))
          .map((f) => f.tool))].join('、');
        console.log(dryRun
          ? `[ownmind] （只檢查，沒有改）${tools} 的設定還寫著 ${move.from}，伺服器說應該改成 ${move.to}。`
          : `[ownmind] OwnMind 的伺服器換了位置，${tools} 的設定已經改成新的 ${move.to}，改完也讀回來確認過了，你不用做任何事。`);
      }
    })
    .catch((err) => {
      // An update must not fail because of this step, but it must not fail silently either.
      console.error(`[ownmind] 檢查伺服器網址時出錯：${err && err.message}`);
    });
}
