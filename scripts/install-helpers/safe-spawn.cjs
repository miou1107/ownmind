// scripts/install-helpers/safe-spawn.cjs
//
// safeSpawn — a Windows-friendly wrapper around execFile.
//
// Why this helper exists:
//   Calling Node child_process.execFile with { shell: true } on Windows wraps the command in
//   cmd.exe. cmd.exe sees something like "powershell.exe -Command 'Get-X | Select-Object'"
//   and treats the `|` as its own pipe operator → looks for Select-Object as an external
//   command → fails. This was the root cause of v1.17.63 self-check.cjs's scheduler check
//   reporting a false negative every time.
//
//   Also, spawning a console-subsystem binary on Windows (node.exe, powershell.exe, etc.) by
//   default allocates a console window — when Task Scheduler triggers it, a window pops up.
//   windowsHide:true prevents that.
//
// Defaults (callable options override these, but shell:true on Windows logs a warning):
//   - shell: false       never go through a shell
//   - windowsHide: true  never show a console window
//   - timeout: 5000ms
//
// Returns: { ok, stdout, stderr, code, error, stderr_tail }; never throws.
// Callers branch on ok=false + the structured error, no try/catch needed.

'use strict';

const { execFile } = require('child_process');
const os = require('os');

const HOME = os.homedir();
const DEFAULT_TIMEOUT_MS = 5000;
const STDERR_TAIL_BYTES = 500;

function sanitize(s) {
  if (typeof s !== 'string') return String(s ?? '');
  return s.split(HOME).join('~');
}

function safeSpawn(file, args = [], options = {}) {
  // v1.17.66 review fix — must not just log a warning (Task Scheduler stderr has no audience,
  // so a Bug #2-class hidden regression could slip past review again).
  // If a caller really needs a shell, use child_process.execFile directly — this helper's
  // value is "close off the unsafe default".
  if (options.shell === true && process.platform === 'win32') {
    throw new Error(
      `safeSpawn refuses shell:true on win32 — cmd.exe will eat PowerShell | pipes. ` +
      `Use child_process.execFile directly if you really need shell. file=${file}`
    );
  }

  const opts = {
    shell: false,
    windowsHide: true,
    timeout: DEFAULT_TIMEOUT_MS,
    ...options,
  };

  return new Promise((resolve) => {
    execFile(file, args, opts, (error, stdout, stderr) => {
      const stdoutStr = String(stdout || '');
      const stderrStr = String(stderr || '');
      if (error) {
        resolve({
          ok: false,
          code: error.code,
          error: sanitize(error.message),
          stdout: sanitize(stdoutStr),
          stderr: sanitize(stderrStr),
          stderr_tail: sanitize(stderrStr).slice(-STDERR_TAIL_BYTES),
          killed: error.killed === true,
          signal: error.signal || null,
        });
      } else {
        resolve({
          ok: true,
          code: 0,
          stdout: sanitize(stdoutStr),
          stderr: sanitize(stderrStr),
        });
      }
    });
  });
}

module.exports = { safeSpawn };
