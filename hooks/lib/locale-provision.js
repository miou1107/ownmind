#!/usr/bin/env node
/**
 * SessionStart OS-locale detection (gate message i18n, task 2 of 7).
 *
 * `getLocale()` (hooks/lib/locale.js) must stay sync, total and subprocess-free so it can
 * run on every hook message; this is the one place allowed to shell out for the machine's
 * OS locale, run once per session, with the raw result left for getLocale() to read back
 * from `<homeDir>/.ownmind/state/locale.json`. Normalization is deliberately NOT done here —
 * it lives in locale.js, so a malformed raw value can never poison the always-on read path
 * directly; this module only ever writes the raw string (or null) it detected.
 *
 * Detector per platform:
 *   darwin  — `defaults read -g AppleLocale`       e.g. "zh_TW"
 *   win32   — `powershell.exe (Get-Culture).Name`  e.g. "en-US"
 *   else    — $LANG or $LC_ALL                     e.g. "ja_JP.UTF-8"
 *
 * Every failure mode — missing binary, timeout, unsupported platform, no env var set — must
 * write `detected: null` rather than throw: a locale hook is best-effort, and SessionStart
 * must never fail (or even delay) because a machine has no AppleLocale.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `stdio: ['ignore', 'pipe', 'ignore']` — the same form path-guard.js, ownmind-git-commit-msg.js
 * and ownmind-reply-lint.js already use, and it is load-bearing here rather than tidiness.
 *
 * `execFileSync` with no `stdio` pipes the child's stderr straight through to the parent's
 * (Node's documented default). On macOS/Linux the `.sh` SessionStart twin redirects this whole
 * step, so nothing is visible; but a Windows install runs the `.js` twin, where
 * `provisionLocale()` executes in-process inside `hooks/ownmind-session-start.js` — so anything
 * `powershell.exe` writes to stderr (Constrained Language Mode, AppLocker/WDAC, execution
 * policy) would surface on the hook's own stderr, a channel the user reads. Only stdout is
 * wanted; the failure itself is already reported by the thrown non-zero exit, which the caller
 * turns into `detected: null`.
 */
const DETECTOR_STDIO = ['ignore', 'pipe', 'ignore'];

function detectRawLocale() {
  if (process.platform === 'darwin') {
    return execFileSync('defaults', ['read', '-g', 'AppleLocale'], {
      timeout: 2000, encoding: 'utf8', stdio: DETECTOR_STDIO,
    }).trim();
  }
  if (process.platform === 'win32') {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-Culture).Name'],
      { timeout: 5000, encoding: 'utf8', stdio: DETECTOR_STDIO }
    ).trim();
  }
  return (process.env.LANG || process.env.LC_ALL || '').trim();
}

/**
 * Detects the OS locale and writes it to `<homeDir>/.ownmind/state/locale.json`. Never
 * throws: detection and the write are each wrapped independently, so a detector failure
 * still produces a well-formed `{"detected":null,"detected_at":"<ISO>"}` file, and a write
 * failure (unwritable state dir, etc.) is swallowed outright — SessionStart must never break
 * because this best-effort step could not run.
 *
 * @param {{homeDir?: string}} [opts]
 */
export function provisionLocale({ homeDir = os.homedir() } = {}) {
  let detected = null;
  try {
    detected = detectRawLocale() || null;
  } catch {
    detected = null;
  }

  try {
    const stateDir = path.join(homeDir, '.ownmind', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const localePath = path.join(stateDir, 'locale.json');
    // Write-side symlink defense, matching gate-receipt.js's writeReceipt: unlink a
    // pre-planted symlink first (never its target) so this always writes a real file.
    try {
      if (fs.lstatSync(localePath).isSymbolicLink()) fs.unlinkSync(localePath);
    } catch { /* absent is the normal case */ }
    fs.writeFileSync(localePath, JSON.stringify({ detected, detected_at: new Date().toISOString() }));
  } catch { /* best-effort: a locale hook must never break SessionStart */ }
}

/**
 * Real paths, not the strings: `import.meta.url` is symlink-resolved while `argv[1]` is
 * whatever the caller typed — same comparison gate-provision.js and conditional-sync-cli.js
 * use to detect a direct `node this-file.js` invocation.
 */
function isMain() {
  try {
    return Boolean(process.argv[1])
      && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  // No stdin, no session id, no API key needed — OS detection depends on none of them, so
  // this CLI reads nothing from stdin and never blocks waiting for input.
  try {
    provisionLocale();
  } catch { /* provisionLocale() is already total; this is defense in depth */ }
  process.exit(0);
}
