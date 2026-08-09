// Register the OwnMind MCP server where Claude Code will actually launch it from.
//
// v1.26.112 — every installer so far wrote `~/.claude/settings.json` and nothing else.
// Claude Code does not read MCP servers from that file: it launches them from
// `~/.claude.json`. The consequence was not a warning or a degraded mode — the
// `ownmind_*` tools were simply **never registered for anyone installing with these
// scripts**. Memory still loaded, because the SessionStart hook is configured separately
// in `settings.json` (which Claude Code does read for hooks), so the product looked alive
// while the half that lets the AI read and write memory on purpose was absent.
//
// The repository already knew the two files were different — `resolve-credentials.cjs`
// searches both, and the v1.26.93/94 notes say in passing that `~/.claude.json` is "the
// file nothing writes". What nobody drew was the conclusion: if nothing writes it, the
// server is not registered at all.
//
// Measured 2026-08-09 on TANK: `~/.claude/settings.json` held a complete, correct
// `mcpServers.ownmind` block; `~/.claude.json` had no `mcpServers` key at all; no
// `ownmind_*` tool existed in the session. Running `node ~/.ownmind/mcp/index.js` by hand
// answered `initialize` correctly, so nothing was broken except where it was written down.
//
// Both files are still written. `~/.claude.json` is what Claude Code launches from;
// `~/.claude/settings.json` is where this project's own `resolveCredentials` looks first,
// and several hooks depend on that. Keeping them in step is the point — a machine where
// they disagree is the account-switch bug v1.26.93 exists to surface.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_JSON = '.claude.json';
const CLAUDE_SETTINGS = path.join('.claude', 'settings.json');

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Read a JSON file that may not exist yet.
 *
 * A parse failure is deliberately fatal rather than "start from {}". `~/.claude.json` holds
 * the user's entire project history; silently replacing an unreadable one with a fresh
 * object would destroy it to install a memory tool.
 */
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = stripBom(fs.readFileSync(file, 'utf8'));
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}). Refusing to overwrite it.`);
  }
}

/** Write via a temp file and rename, so an interrupted install cannot truncate the file. */
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.ownmind.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Merge the ownmind entry into one config object, preserving everything else.
 *
 * Fields this installer does not manage are kept, so a user who added `disabled` or a
 * custom `env` var does not lose it on upgrade.
 */
function mergeEntry(config, entry, { apiUrl, apiKey, tool }) {
  const next = { ...config };
  const servers = { ...(next.mcpServers || {}) };
  const prev = servers.ownmind || {};
  servers.ownmind = {
    ...prev,
    ...entry,
    env: {
      ...(prev.env || {}),
      OWNMIND_API_URL: apiUrl,
      OWNMIND_API_KEY: apiKey,
      OWNMIND_TOOL: tool || 'claude-code',
    },
  };
  next.mcpServers = servers;
  return next;
}

/**
 * Write the entry to both files and then **read them back** to confirm it is there.
 *
 * The read-back is the point of this function, not a flourish. IR-001: an install script
 * reporting success is not evidence that anything works, and this defect is exactly what
 * that rule describes — every installer for nine releases reported a clean install of a
 * server that was never registered. Callers should surface `verified` rather than their
 * own "done" message.
 *
 * Returns { written: [...], verified: bool, problems: [...] }.
 */
function registerMcp({ entry, apiUrl, apiKey, tool = 'claude-code', home = os.homedir() } = {}) {
  if (!entry || !entry.command) throw new Error('registerMcp needs an entry with a command');
  if (!apiUrl || !apiKey) throw new Error('registerMcp needs apiUrl and apiKey');

  // v1.26.112 — reject a home directory this process cannot actually address.
  //
  // Caught by this helper reporting "verified" twice while writing nothing where the caller
  // asked. A caller under Git Bash can pass a POSIX path like `/tmp/fh3` or `/c/Users/Vin`;
  // Node on Windows treats that as relative to the current drive, so every write landed
  // somewhere else entirely — and the read-back succeeded, because it read back the same
  // wrong path. Confirming that a write can be read is not the same as confirming it went
  // where it was meant to, which is precisely the mistake this whole release is about:
  // `~/.claude/settings.json` was also written and read back perfectly for nine releases.
  //
  // An absolute path is required, and on Windows it must carry a drive or UNC prefix.
  if (!path.isAbsolute(home)) {
    throw new Error(`registerMcp needs an absolute home directory, got ${JSON.stringify(home)}`);
  }
  if (process.platform === 'win32' && !/^([A-Za-z]:|\\\\)/.test(home)) {
    throw new Error(
      `registerMcp got a POSIX-style home (${JSON.stringify(home)}) on Windows. Node resolves `
      + 'that against the current drive, so the files would be written somewhere the caller '
      + 'is not looking. Convert it first (cygpath -w / to_win_path).',
    );
  }

  const targets = [
    // Order matters only for reporting. The first is the one Claude Code launches from;
    // if only one of the two can be written, that is the one that must succeed.
    { file: path.join(home, CLAUDE_JSON), why: 'Claude Code launches the MCP server from here' },
    { file: path.join(home, CLAUDE_SETTINGS), why: "OwnMind's own credential resolver reads here" },
  ];

  const written = [];
  const problems = [];
  for (const { file, why } of targets) {
    try {
      writeJsonAtomic(file, mergeEntry(readJson(file), entry, { apiUrl, apiKey, tool }));
      written.push(file);
    } catch (e) {
      problems.push(`could not write ${file} (${why}): ${e.message}`);
    }
  }

  // Read back from disk. Comparing the object we just built would only prove this process
  // can merge, which was never in doubt.
  for (const { file } of targets) {
    if (!written.includes(file)) continue;
    let back;
    try {
      back = readJson(file);
    } catch (e) {
      problems.push(`wrote ${file} but cannot read it back: ${e.message}`);
      continue;
    }
    const got = back.mcpServers && back.mcpServers.ownmind;
    if (!got || got.command !== entry.command) {
      problems.push(`wrote ${file} but ownmind is not in it afterwards`);
    }
  }

  const launchFile = targets[0].file;
  const verified = written.includes(launchFile)
    && !problems.some((p) => p.includes(launchFile));

  return { written, verified, problems, launchFile };
}

/**
 * Is the server registered where Claude Code will find it? Used by the self-check, which
 * runs long after install and on machines this installer never touched.
 */
function isRegisteredForClaudeCode({ home = os.homedir() } = {}) {
  let config;
  try {
    config = readJson(path.join(home, CLAUDE_JSON));
  } catch {
    return { registered: false, reason: '~/.claude.json is unreadable' };
  }
  const entry = config.mcpServers && config.mcpServers.ownmind;
  if (!entry) {
    return {
      registered: false,
      reason: 'no mcpServers.ownmind in ~/.claude.json — Claude Code launches MCP servers '
        + 'from that file, so the ownmind_* tools are not available in any session',
    };
  }
  if (!entry.command) return { registered: false, reason: 'mcpServers.ownmind has no command' };
  return { registered: true, command: entry.command };
}

module.exports = {
  registerMcp,
  isRegisteredForClaudeCode,
  mergeEntry,
  readJson,
  writeJsonAtomic,
  CLAUDE_JSON,
  CLAUDE_SETTINGS,
};
