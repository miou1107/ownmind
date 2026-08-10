/**
 * v1.26.124 — does the registered scheduler task belong to *this* installation?
 *
 * The self-check used to answer a different question. `Get-ScheduledTask -TaskName
 * 'OwnMind Usage Scanner'` is machine-global, so "a task with that name exists" was being
 * read as "this install registered one".
 *
 * Found by installing into a throwaway HOME on a machine that already ran OwnMind. The
 * sandbox registered nothing whatsoever — install.sh had no Windows branch at the time —
 * and the report still said:
 *
 *     [ OK ]  scheduler            Task Scheduler state=Ready
 *
 * because it had found the task belonging to the real installation:
 *
 *     wscript.exe "C:\Users\Vin\.ownmind\scripts\windows\run-hidden.vbs" ...
 *
 * So every machine that ever had OwnMind would pass this check forever, no matter how
 * broken the current install is — and this is the check whose entire job is to notice
 * usage collection dying.
 *
 * Pure and dependency-free so it can be tested on any platform; the Windows-only part
 * (asking the Task Scheduler) stays in self-check.cjs.
 */

/**
 * @param {string} actions   the task's actions, executable and arguments, joined into one
 *                           string — whatever `Get-ScheduledTask` reported
 * @param {string} ownmindDir this installation's directory, as node resolved it
 * @returns {boolean} true when the task drives this installation, or when ownership cannot
 *                    be determined
 */
function taskBelongsToInstall(actions, ownmindDir) {
  // Unknown is not the same as wrong. Get-ScheduledTask can return a task whose actions the
  // current user is not allowed to read, and turning a permissions quirk into a hard failure
  // is the false alarm this file has already been burned by once: v1.26.106 reported a 1.5s
  // CIM call as "Requires Windows + PowerShell" to a machine that plainly had both.
  if (typeof actions !== 'string' || actions.trim() === '') return true;
  if (typeof ownmindDir !== 'string' || ownmindDir.trim() === '') return true;

  // Windows paths reach this function in both slash conventions and any case: the task was
  // registered with native backslashes, while ownmindDir is whatever os.homedir() produced.
  const normalize = (s) => s.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return normalize(actions).includes(normalize(ownmindDir));
}

/**
 * v1.26.133 — put the home directory back into text that safe-spawn.cjs redacted.
 *
 * safeSpawn replaces every occurrence of `os.homedir()` with `~` in the stdout it returns.
 * That exists so an uploaded self-check report does not carry the user's profile path, and it
 * is right for a report. It is wrong for a comparison, and the scheduler check was doing both
 * with the same string: it asked PowerShell for the task's actions through safeSpawn and
 * handed the result to `taskBelongsToInstall` alongside an unredacted `OWNMIND_DIR`.
 *
 * So the check compared
 *
 *     wscript.exe "~\.ownmind\scripts\windows\run-hidden.vbs" ...
 *
 * against `C:\Users\Vin\.ownmind` and concluded the task belonged to somebody else. Measured
 * on Windows 2026-08-10 on a machine whose task was Ready, LastTaskResult 0x0, and pointing at
 * exactly the right files: `[FAIL] scheduler  Task Scheduler entry points at another
 * installation`. The advice attached to it — re-register the task — fixes nothing, because
 * nothing is broken, and the re-registered task fails the same comparison the next day.
 *
 * Every install whose directory sits under the user's home is affected, which is all of them
 * by default. The PowerShell half of this rule (schedule-health.ps1) reads the actions
 * straight from Get-ScheduledTask and never saw a `~`, so the repair and the check disagreed
 * again — the same class of split v1.26.130 closed.
 *
 * Kept separate from taskBelongsToInstall rather than folded into it: the ownership rule has
 * two implementations that are asserted against each other, and only the JS caller goes
 * through a redacting helper. Un-redacting is the caller's problem, so it lives in a function
 * the caller reaches for by name.
 *
 * @param {string} text  output that may have been home-redacted
 * @param {string} home  the home directory `~` stands for, normally os.homedir()
 * @returns {string} text with a leading `~` path segment expanded back to home
 */
function expandHomeMarker(text, home) {
  if (typeof text !== 'string' || text === '') return text;
  if (typeof home !== 'string' || home.trim() === '') return text;
  if (!text.includes('~')) return text;
  // Only `~` immediately followed by a separator: that is the shape safeSpawn produces when it
  // substitutes a directory path. A bare `~` elsewhere in a command line is left alone.
  return text.replace(/~(?=[\\/])/g, () => home);
}

module.exports = { taskBelongsToInstall, expandHomeMarker };
