import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempDir } from './temp-dir.js';

/**
 * Run a generated shell script through a file rather than `bash -c <string>`.
 *
 * v1.26.109 — `bash -c` loses backslashes on Windows. node quotes the argument by MSVCRT
 * rules; `bash.exe` from Git Bash parses the command line by MSYS rules; the two disagree
 * about a backslash immediately before a quote. Measured with the real line out of
 * `hooks/ownmind-session-start.sh`:
 *
 *     the sed command as bash should see it:
 *       sed 's/\\/\\\\/g; s/"/\\"/g'
 *     bash -c <string> -> ""      stderr: sed: -e expression #1, char 13: unknown option to `s'
 *     bash <file>      -> "pull"  stderr: ""
 *
 * Every test that built a script in JS and handed it to `bash -c` was therefore running a
 * different script on Windows than on macOS — usually a broken one, and the breakage
 * surfaced as an assertion about the wrong value rather than as an error about quoting.
 * `hook-log-event-details` reported `{ step: '' }` for eleven releases' worth of a field
 * the hook writes correctly.
 *
 * A file has no command line to be re-parsed, so the script arrives byte for byte. There is
 * no macOS-only or Windows-only branch here: the file form is correct everywhere, and a
 * platform branch is how the original difference stayed invisible.
 */

/**
 * A path bash will accept, interpolated into a script.
 *
 * `os.tmpdir()` hands back `C:\Users\…\Temp\x` on Windows. Dropped into a double-quoted
 * bash string the backslashes are escape characters, so `\U` and `\T` quietly become `U`
 * and `T` and the path stops existing. Git Bash reads `/c/Users/…/Temp/x` for the same
 * directory. On macOS and Linux the input has neither a drive letter nor a backslash and
 * comes back untouched, so call sites need no branch.
 */
export function toBashPath(p) {
  return String(p)
    .replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`)
    .replace(/\\/g, '/');
}

/**
 * The shape `to_win_path` (scripts/install-helpers/path-helpers.sh) hands back, for tests
 * that stand in for a shell variable holding its output.
 *
 * v1.26.123 — `installer-key-update` substituted a native `path.join` result for
 * `$CLAUDE_SETTINGS_WIN` and ran the resulting JavaScript. install.sh fills that variable
 * from `cygpath -m`, which returns `C:/Users/…` — forward slashes, no escape to get wrong.
 * The test supplied `C:\Users\…` instead, and since the value is interpolated into a
 * single-quoted JS literal, `\U` and `\A` and `\T` were dropped by the parser before the
 * program ran. The failure was real but the installer was not: the test had handed it a
 * path install.sh cannot produce.
 *
 * Kept honest by tests/bash-path-list.test.js, which runs the real shell function and
 * requires the two to agree.
 */
export function toWinPath(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Build a `PATH`-style list out of host paths.
 *
 * v1.26.123 — the entries of `PATH` are separated by a colon, and a Windows path contains
 * one. `C:\Users\…\bin` prepended raw does not become one broken entry, it becomes two:
 * `C`, and `\Users\…\bin`. That second fragment is a *drive-relative* path — it resolves
 * against whichever drive the process happens to be on. Measured with the stub `curl` that
 * `hook-log-event-details` puts on PATH, temp dir on `C:`:
 *
 *     cwd on C:  ->  type -a curl  ->  \Users\…\bin/curl   (the stub — found by accident)
 *     cwd on S:  ->  type -a curl  ->  /mingw64/bin/curl   (the real curl — stub invisible)
 *
 * So the test passed on a developer machine, where the checkout and the temp directory sit
 * on the same drive, and failed on the CI Windows runner, which checks out onto `D:` while
 * `TEMP` stays on `C:`. Nothing about the assertion was wrong; the stub simply never ran.
 *
 * Going through `toBashPath` first turns each entry into `/c/Users/…/bin`, which holds no
 * colon and no drive-relative fragment, so the list means the same thing on every drive.
 */
export function bashPathList(...entries) {
  return entries.flat().map(toBashPath).join(':');
}

/** Write `script` into its own temp directory. The caller owns `cleanup`. */
export function makeBashScript(script, prefix = 'ownmind-bash-') {
  const dir = tempDir(prefix);
  const file = path.join(dir, 'script.sh');
  // LF regardless of host: bash rejects a `\r` at the end of a line, and on Windows a
  // JS template literal that a linter has touched can carry CRLF.
  fs.writeFileSync(file, `${script.replace(/\r\n/g, '\n')}\n`);
  return {
    file,
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** execFileSync, with the script delivered as a file. Cleans up even when the run throws. */
export function execBashScript(script, options = {}) {
  const { file, cleanup } = makeBashScript(script);
  try {
    return execFileSync('bash', [file], options);
  } finally {
    cleanup();
  }
}

/** spawnSync, with the script delivered as a file. Returns the full result object. */
export function spawnBashScript(script, options = {}) {
  const { file, cleanup } = makeBashScript(script);
  try {
    return spawnSync('bash', [file], options);
  } finally {
    cleanup();
  }
}
