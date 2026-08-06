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
function sessionStartCommand({ platform, hookDir, ownmindDir } = {}) {
  if (platform !== 'win32') return UNIX_COMMAND;

  // v1.26.85 — run the copy under ~/.ownmind/hooks, never the one under ~/.claude/hooks.
  //
  // The hook is an ES module that imports `../shared/helpers.js`. From ~/.claude/hooks/
  // that resolves to ~/.claude/shared/, which does not exist, so Node exits with
  // ERR_MODULE_NOT_FOUND before a single line runs — silently, since nothing is watching a
  // hook's exit code. Found on Adam's machine after everything else had been made correct:
  // four matchers, Node, the file present, and still not one load.
  //
  // 采瑤's machine worked throughout only because her AI had happened to write a path under
  // ~/.ownmind/hooks/, where the imports resolve. That accident was the control group.
  const base = ownmindDir
    ? `${String(ownmindDir).replace(/\\/g, '/').replace(/\/+$/, '')}/hooks`
    // Derive it when only the Claude hooks dir is known: <home>/.claude/hooks →
    // <home>/.ownmind/hooks. Callers should pass ownmindDir; this keeps older ones correct.
    : String(hookDir || '').replace(/\\/g, '/').replace(/\/+$/, '')
      .replace(/\/\.claude\/hooks$/, '/.ownmind/hooks');
  // Quoted because a Windows home directory routinely contains a space
  // ("C:\Users\Jane Doe\"), and unquoted it would arrive as two arguments.
  return `node "${base}/ownmind-session-start.js"`;
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
  //
  // Deliberately, "ours" is decided by the hook FILENAME, wherever the file sits: a
  // same-named script in the wrong directory is what every broken machine looked like
  // (the dead copy under ~/.claude/hooks), so path differences are drift to repair, not
  // customisation to respect. Customisation = a different script or extra arguments.
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

/**
 * Is this command ours to maintain?
 *
 * True when its whole job is running our own SessionStart hook — whatever the quoting,
 * whichever runtime. False as soon as there are extra arguments, a wrapper program, or a
 * different script: that is somebody's deliberate edit and overwriting it daily would be
 * an argument the user cannot win.
 *
 * v1.26.82 matched only the exact strings we emit, which meant quoting decided ownership.
 * On 采瑤's machine her AI had hand-written a working but unquoted Node command; we read
 * that as a customisation and left her on one matcher instead of four, so memories loaded
 * on a new conversation and not on resume, clear or compact. Quoting is spelling, not
 * intent.
 */
function isGeneratedCommand(command) {
  const c = String(command || '').trim();
  if (!c) return false;
  // <runtime> <path-to-our-hook>, and nothing else. The path may be bare, "quoted" or
  // 'quoted'; `~` is left as-is because the shell, not us, expands it.
  //
  // The bare branch is `.+`, not `\S+`: a Windows home directory routinely contains a
  // space ("C:\Users\Jane Doe"), and an unquoted command with a space is still just our
  // hook. The basename check below still rejects deliberate edits — trailing arguments
  // make the last path segment stop being exactly our filename.
  const m = c.match(/^(node|bash)\s+(?:"([^"]+)"|'([^']+)'|(.+))$/);
  if (!m) return false;
  const runtime = m[1];
  const target = m[2] || m[3] || m[4];
  const file = target.split(/[/\\]/).pop();
  return runtime === 'node'
    ? file === 'ownmind-session-start.js'
    : file === 'ownmind-session-start.sh';
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
