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

module.exports = { taskBelongsToInstall };
