'use strict';
// session-hook-command.cjs — how the SessionStart hook is invoked, decided in one place.
//
// v1.26.80. Required by install.sh, install.ps1, update.sh and update.ps1, all of which
// used to carry their own copy of the answer. Two of those copies disagreed, and the one
// that ran daily won.
//
// Why this file exists
// --------------------
// Production, 2026-08-06, `activity_logs` where event='init' and source='hook', 90 days:
// three Macs produced 12,221 hook loads; six Windows machines produced zero. The hook is
// what auto-loads a person's memories and iron rules, so on Windows that has never worked,
// and nothing ever said so.
//
// install.ps1 already chose correctly — Node when no bash was found. update.ps1 then
// recognised that entry (it matches on the substring "ownmind-session-start", which the
// Node command contains), found it lacked the four matchers install.ps1 never adds,
// deleted it, and wrote four entries hardcoded to bash. Every Windows machine runs an
// update daily, so the correct command survived until the first one.
//
// Windows always gets Node, and no longer asks whether a bash exists
// ------------------------------------------------------------------
// `Get-Command bash` on Windows 10/11 finds System32\bash.exe — the WSL launcher — so the
// command would run inside WSL, where `~` is a different home directory and the hook file
// is not there. It fails silently, which is exactly what the data shows. This repo already
// knew: scripts/windows/lib/find-git-bash.ps1 exists to "避開 WSL relay", and was wired
// into the upgrade verify step but never into the hook.
//
// Node needs no such detection. OwnMind already requires Node 20+, the installer resolves
// and caches it, and an absolute path leaves nothing for a shell to reinterpret.

const MATCHERS = ['startup', 'resume', 'clear', 'compact'];
const HOOK_TIMEOUT_SECONDS = 10;

// The exact string running on every Mac and Linux box today. Left alone deliberately:
// 12,000 successful loads go through it, and this change has no way to test that platform
// any better than production already does.
const UNIX_COMMAND = 'bash ~/.claude/hooks/ownmind-session-start.sh';

/**
 * The command string to place in settings.json for this platform.
 *
 * @param {object}  opts
 * @param {string}  opts.platform  process.platform value ('win32' | 'darwin' | 'linux')
 * @param {string} [opts.hookDir]  absolute path of ~/.claude/hooks — required on Windows
 * @returns {string}
 */
function sessionStartCommand({ platform, hookDir } = {}) {
  if (platform !== 'win32') return UNIX_COMMAND;

  // Forward slashes: Node accepts them on Windows, and they survive a round trip through
  // JSON without the double-escaping that backslashes invite.
  const dir = String(hookDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  // Quoted because a Windows home directory routinely contains a space
  // ("C:\Users\Vin Kao\"), and unquoted it would arrive as two arguments.
  return `node "${dir}/ownmind-session-start.js"`;
}

/**
 * The full set of SessionStart entries. All four matchers, because a hook registered for
 * only 'startup' does not fire on resume, clear or compact — the AI then continues without
 * the user's iron rules loaded.
 */
function sessionStartEntries(opts) {
  const command = sessionStartCommand(opts);
  return MATCHERS.map((matcher) => ({
    matcher,
    hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }],
  }));
}

/** True for any entry that is ours, on either platform, in any historical shape. */
function isOwnmindSessionEntry(entry) {
  return Boolean(entry?.hooks?.some((h) => (h.command || '').includes('ownmind-session-start')));
}

/**
 * Should the existing entries be torn down and rebuilt?
 *
 * Two independent reasons, and the second one is the whole point of v1.26.80. Every
 * Windows machine today holds four entries with all four matchers present, each running
 * bash. Judging only by "are the matchers complete" calls that healthy and repairs nobody
 * — the fix would ship and change nothing on a single affected machine.
 *
 * @param {Array}  existingEntries  the SessionStart entries that are ours
 * @param {object} opts             { platform, hookDir }
 */
function needsRewrite(existingEntries, opts) {
  if (!existingEntries || existingEntries.length === 0) return false;

  // A command we did not generate belongs to the user. Overwriting it would mean an
  // installer that silently undoes a deliberate edit on every update, forever, and the
  // user would have no way to win. Leave it and let them own it; ~/.ownmind/.no-session-hook
  // remains the way to opt out entirely.
  const allCommandsAreOurs = existingEntries.every(
    (e) => e.hooks?.every((h) => isGeneratedCommand(h.command)),
  );
  if (!allCommandsAreOurs) return false;

  const desired = sessionStartCommand(opts);
  const hasAllMatchers = MATCHERS.every((m) => existingEntries.some((e) => e.matcher === m));
  const allCommandsCurrent = existingEntries.every(
    (e) => e.hooks?.every((h) => h.command === desired),
  );
  return !hasAllMatchers || !allCommandsCurrent;
}

/** Did we write this command, in this or any earlier version? */
function isGeneratedCommand(command) {
  const c = String(command || '').trim();
  if (c === UNIX_COMMAND) return true;
  // Every Windows form we have ever emitted: `node "<abs path>/ownmind-session-start.js"`.
  return /^node "[^"]*\/ownmind-session-start\.js"$/.test(c);
}

module.exports = {
  MATCHERS,
  UNIX_COMMAND,
  HOOK_TIMEOUT_SECONDS,
  sessionStartCommand,
  sessionStartEntries,
  isOwnmindSessionEntry,
  isGeneratedCommand,
  needsRewrite,
};
