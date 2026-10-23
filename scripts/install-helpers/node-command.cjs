'use strict';
// node-command.cjs — the two shapes a generated `node <script>` command can take, in one place.
//
// A machine whose only Node is the private runtime under ~/.ownmind/runtime has no `node` on
// the PATH that Claude Code hands to a hook or an MCP server, so the installer writes the
// runtime's absolute path in front of the script instead:
//
//     node "<script>"                                   a machine with a system Node (unchanged)
//     "<home>/.ownmind/runtime/current/bin/node" "<script>"     only the private runtime
//     "C:/Users/<u>/.ownmind/runtime/current/node.exe" "<script>"   the same on Windows
//
// Only an absolute Node under `.ownmind/runtime/` (or the exact nodeBin this run was asked to
// write) is OwnMind's. A hand-written `"C:\Program Files\nodejs\node.exe" "<our hook>"` is the
// user's: claiming it would let an upgrade rewrite a working entry into one that cannot start.
//
// The rule for "is this existing entry still current", for an entry that runs the right script:
//
//   - nodeBin given     -> only when it is exactly the command we would write.
//   - nodeBin absent    -> a bare `node` entry is judged by exact equality (today's rule); an
//                          OwnMind-runtime entry is left alone while that Node still exists,
//                          and rewritten once it does not (the runtime was removed).
//
// effectiveNodeBin() covers the remaining case: an updater (which passes no nodeBin) that has
// to rewrite for another reason — a missing matcher, a moved script — keeps a working private
// runtime instead of writing bare `node` onto a machine that has no other Node.

const fs = require('fs');

/** True for a POSIX absolute path or a Windows drive or UNC path. */
function isAbsolutePath(p) {
  const s = String(p || '');
  return s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\');
}

/**
 * The spelling a nodeBin is written in: forward slashes for a Windows path (as every hook path
 * already is), unchanged otherwise. A double quote cannot be quoted inside the command, so it
 * is refused rather than written into a command that would split in two.
 */
function normalizeNodeBin(nodeBin) {
  if (!nodeBin) return nodeBin;
  const s = String(nodeBin);
  if (s.includes('"')) throw new Error(`nodeBin must not contain a double quote: ${s}`);
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') ? s.replace(/\\/g, '/') : s;
}

/** The runtime word in front of the script: bare `node`, or the quoted absolute path. */
function nodeInvocation(nodeBin) {
  return nodeBin ? `"${normalizeNodeBin(nodeBin)}"` : 'node';
}

/** True when `p` names a Node executable by its basename: node, or node.exe on Windows. */
function isNodeBasename(p) {
  const base = String(p || '').split(/[/\\]/).pop();
  return base === 'node' || /^node\.exe$/i.test(base);
}

/** True when `p` lies under some `.ownmind/runtime/` directory, in either slash style. */
function isOwnmindRuntime(p) {
  return /\/\.ownmind\/runtime\//i.test(String(p || '').replace(/\\/g, '/'));
}

/**
 * Split a command into the Node that runs it and the script it runs.
 *
 * @returns {{ runtime: string, absolute: boolean, ownmind: boolean, target: string } | null}
 *   runtime is 'node' for the bare form, or the absolute path for the quoted form; ownmind says
 *   whether that absolute path is the private runtime. null when the command is not
 *   `<node> <one script>` at all.
 */
function parseNodeCommand(command) {
  const c = String(command || '').trim();
  const m = c.match(/^(?:(node)|"([^"]+)"|'([^']+)')\s+(?:"([^"]+)"|'([^']+)'|(.+))$/);
  if (!m) return null;
  const target = m[4] || m[5] || m[6];
  if (m[1]) return { runtime: 'node', absolute: false, ownmind: false, target };
  const runtime = m[2] || m[3];
  if (!isAbsolutePath(runtime) || !isNodeBasename(runtime)) return null;
  return { runtime, absolute: true, ownmind: isOwnmindRuntime(runtime), target };
}

/**
 * Is this command one OwnMind may maintain? Bare `node`, the private runtime, or exactly the
 * nodeBin this run was asked to write. Any other absolute Node is the user's.
 */
function isOwnNodeCommand(command, { nodeBin } = {}) {
  const parsed = parseNodeCommand(command);
  if (!parsed) return null;
  if (!parsed.absolute || parsed.ownmind) return parsed;
  if (nodeBin && parsed.runtime.replace(/\\/g, '/') === normalizeNodeBin(nodeBin).replace(/\\/g, '/')) return parsed;
  return null;
}

/**
 * Is `existing` as good as `desired` for this machine? See the header for the rule.
 *
 * @param {string} existing  the command found in settings.json
 * @param {string} desired   the command this run would write
 * @param {{ nodeBin?: string, exists?: (p: string) => boolean }} [opts]
 */
function isCurrentNodeCommand(existing, desired, { nodeBin, exists = fs.existsSync } = {}) {
  if (existing === desired) return true;
  if (nodeBin) return false;
  const have = parseNodeCommand(existing);
  const want = parseNodeCommand(desired);
  if (!have || !want || !have.absolute || !have.ownmind) return false;
  if (have.target !== want.target) return false;
  try { return Boolean(exists(have.runtime)); } catch { return false; }
}

/**
 * The nodeBin to write with: the one asked for, else the private runtime an existing OwnMind
 * entry already runs, while it still exists. undefined means bare `node`.
 *
 * @param {string[]} commands  the existing commands that are ours
 */
function effectiveNodeBin(commands, { nodeBin, exists = fs.existsSync } = {}) {
  if (nodeBin) return normalizeNodeBin(nodeBin);
  for (const c of commands || []) {
    const parsed = parseNodeCommand(c);
    if (!parsed || !parsed.absolute || !parsed.ownmind) continue;
    try { if (exists(parsed.runtime)) return normalizeNodeBin(parsed.runtime); } catch { /* next */ }
  }
  return undefined;
}

module.exports = {
  nodeInvocation, normalizeNodeBin, isNodeBasename, isAbsolutePath, isOwnmindRuntime,
  parseNodeCommand, isOwnNodeCommand, isCurrentNodeCommand, effectiveNodeBin,
};
