'use strict';
// node-command.cjs — the two shapes a generated `node <script>` command can take, in one place.
//
// A machine whose only Node is the private runtime under ~/.ownmind/runtime has no `node` on
// the PATH that Claude Code hands to a hook or an MCP server, so the installer writes the
// runtime's absolute path in front of the script instead:
//
//     node "<script>"                       a machine with a system Node (unchanged)
//     "<abs>/node" "<script>"               a machine whose only Node is the private one
//     "<abs>\node.exe" "<script>"           the same on Windows
//
// Every generator builds its command through nodeInvocation(), and every "is this entry still
// current" decision goes through isCurrentNodeCommand(), so an upgrade never rewrites a working
// entry into the other shape. The rule, for an entry that runs the right script:
//
//   - nodeBin given     -> current only when it is exactly the command we would write.
//   - nodeBin absent    -> a bare `node` entry is judged by exact equality (today's rule); an
//                          absolute-node entry is left alone while that node still exists, and
//                          rewritten to the bare form once it does not (the private runtime
//                          was removed, so the absolute path can no longer start anything).

const fs = require('fs');

/** The runtime word in front of the script: bare `node`, or the quoted absolute path. */
function nodeInvocation(nodeBin) {
  return nodeBin ? `"${nodeBin}"` : 'node';
}

/** True when `p` names a Node executable by its basename: node, or node.exe on Windows. */
function isNodeBasename(p) {
  const base = String(p || '').split(/[/\\]/).pop();
  return base === 'node' || /^node\.exe$/i.test(base);
}

/** True for a POSIX absolute path or a Windows drive or UNC path. */
function isAbsolutePath(p) {
  const s = String(p || '');
  return s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\');
}

/**
 * Split a command into the Node that runs it and the script it runs.
 *
 * @returns {{ runtime: string, absolute: boolean, target: string } | null}
 *   runtime is 'node' for the bare form, or the absolute path for the quoted form; null when
 *   the command is not `<node> <one script>` at all.
 */
function parseNodeCommand(command) {
  const c = String(command || '').trim();
  const m = c.match(/^(?:(node)|"([^"]+)"|'([^']+)')\s+(?:"([^"]+)"|'([^']+)'|(.+))$/);
  if (!m) return null;
  const target = m[4] || m[5] || m[6];
  if (m[1]) return { runtime: 'node', absolute: false, target };
  const runtime = m[2] || m[3];
  if (!isAbsolutePath(runtime) || !isNodeBasename(runtime)) return null;
  return { runtime, absolute: true, target };
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
  if (!have || !want || !have.absolute) return false;
  if (have.target !== want.target) return false;
  try { return Boolean(exists(have.runtime)); } catch { return false; }
}

module.exports = {
  nodeInvocation, isNodeBasename, isAbsolutePath, parseNodeCommand, isCurrentNodeCommand,
};
