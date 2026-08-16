// scripts/install-helpers/win-system-binary.cjs
//
// Finding Windows' own binaries without asking PATH.
//
// WHY THIS EXISTS — measured on one machine, 2026-08-16:
//
//   mcp_launches  fail  could not spawn: spawn cmd.exe ENOENT
//   scheduler     fail  Get-ScheduledTask failed: code=ENOENT spawn powershell.exe ENOENT
//
// and in the same report, silently: `chcp.com` produced no code page, `powershell.exe`
// produced no version, and `where.exe bash` came back with an empty result list. Four
// separate System32 binaries, all reported absent, on a Windows 10 machine that plainly has
// all four. Thirteen other checks passed. The self-check there runs Git Bash → PowerShell →
// node, and something in that chain hands node a PATH with no System32 in it.
//
// The lesson is not about that one machine. `cmd.exe` and `powershell.exe` live at addresses
// Windows guarantees — ComSpec for the command interpreter, %SystemRoot%\System32 for the
// rest — and PATH guarantees nothing. Any process anywhere up the chain can rewrite it, and
// the installer is spawned from whatever shell the user happens to be in.
//
// Falling back rather than committing: when the absolute path is not there either, the bare
// name is returned so PATH still gets its turn. A machine with a relocated System32 must not
// be broken by a helper meant to make lookups more reliable.

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Where each binary lives under %SystemRoot%\System32.
 *
 * Keyed by exactly what callers pass. `taskkill` appears twice because mcp-preflight.cjs
 * spawns it without the extension and safeSpawn's callers use it with — and a lookup table
 * that silently misses is worse than no lookup table, since it looks like it worked.
 */
const UNDER_SYSTEM32 = {
  'cmd.exe': ['cmd.exe'],
  'cmd': ['cmd.exe'],
  'powershell.exe': ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
  'powershell': ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
  'where.exe': ['where.exe'],
  'where': ['where.exe'],
  'chcp.com': ['chcp.com'],
  'taskkill.exe': ['taskkill.exe'],
  'taskkill': ['taskkill.exe'],
};

function systemRoot(env) {
  return env.SystemRoot || env.windir || 'C:\\Windows';
}

/**
 * The absolute path Windows guarantees for one of its own binaries, or the name unchanged.
 *
 * @param {string} file what the caller wants to run
 * @param {object} [deps] injected for tests — this has to be assertable from a Mac, since
 *   that is where it will be edited and where the failure it fixes cannot be reproduced
 * @returns {string} an absolute path when one exists, otherwise `file` untouched
 */
function resolveSystemBinary(file, deps = {}) {
  const {
    env = process.env,
    platform = process.platform,
    exists = fs.existsSync,
  } = deps;

  if (platform !== 'win32' || typeof file !== 'string' || !file) return file;
  // Already a path. The caller has said where it wants this from, and second-guessing that
  // is how a helper starts running a different program than it was asked for.
  if (file.includes('\\') || file.includes('/')) return file;

  const key = file.toLowerCase();

  // ComSpec is the documented location of the command interpreter, and a machine that moved
  // it says so there — so it outranks the System32 guess for cmd.exe specifically.
  if ((key === 'cmd.exe' || key === 'cmd') && env.ComSpec && exists(env.ComSpec)) {
    return env.ComSpec;
  }

  const relative = UNDER_SYSTEM32[key];
  if (!relative) return file;

  const absolute = path.win32.join(systemRoot(env), 'System32', ...relative);
  return exists(absolute) ? absolute : file;
}

/**
 * Which of Windows' own binaries this machine can find, and how.
 *
 * Goes into the self-check's env block. The machine above uploaded fifteen check results and
 * an environment summary, and none of it recorded whether System32 was reachable — the
 * answer took a database query against production. Next time it is in the report.
 *
 * Values: 'path' (found the ordinary way), 'system32' (only found at its guaranteed
 * address — PATH is broken and this is the finding), 'missing' (neither).
 *
 * @returns {object|null} null off Windows, where the question does not arise
 */
function describeSystemBinaries(deps = {}) {
  const {
    env = process.env,
    platform = process.platform,
    exists = fs.existsSync,
  } = deps;
  if (platform !== 'win32') return null;

  // Windows spells it `Path`; something that rewrote it may have spelled it `PATH`. Both,
  // because the point of this field is to describe a machine whose PATH is already odd.
  const dirs = String(env.Path || env.PATH || '').split(';').filter(Boolean);

  const report = {};
  for (const name of ['cmd.exe', 'powershell.exe', 'where.exe', 'chcp.com', 'taskkill.exe']) {
    const onPath = dirs.some((dir) => {
      try { return exists(path.win32.join(dir, name)); } catch { return false; }
    });
    if (onPath) { report[name] = 'path'; continue; }
    const resolved = resolveSystemBinary(name, { env, platform, exists });
    report[name] = resolved === name ? 'missing' : 'system32';
  }
  return report;
}

module.exports = { resolveSystemBinary, describeSystemBinaries };
