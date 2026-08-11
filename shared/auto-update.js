/**
 * shared/auto-update.js — the daily upgrade, moved out of the MCP so something other than
 * an AI tool can run it.
 *
 * v1.26.142.
 *
 * Until now the full upgrade — `git fetch`, `git pull`, `npm install`, then the sync
 * script — lived only in `mcp/index.js`, and fired when an AI tool started an MCP session.
 * The two SessionStart hooks run the sync script alone, which repairs an installation but
 * never advances it.
 *
 * So a machine upgraded if, and only if, somebody opened an AI tool that speaks MCP to
 * OwnMind. A member who works entirely in an editor OwnMind does not register with had a
 * scanner checking in on schedule every day for eight weeks, on the version she installed
 * in June, and no path by which any fix since could reach her. Nothing was broken on that
 * machine; there was simply nobody to ask it to update.
 *
 * The scheduled scanner runs on every platform, on a timer, with no AI tool and no model
 * involved. It is the one thing on those machines that already runs, so it is where this
 * belongs.
 *
 * Everything here is injected: the process runner, the clock, the logger, the banner
 * queue. The MCP and the scanner keep their own logging conventions, and the interesting
 * half of an upgrade — which step failed and what was done about it — is then testable
 * without a git repository or a network.
 */

import fs from 'fs';
import path from 'path';
import { localDateOnly } from './local-date.js';
import { tryAcquireUpdateLock, releaseUpdateLock } from './update-lock.js';

/** Outcomes. Returned rather than only logged, so a caller can act on them. */
export const SKIPPED = 'skipped';
export const CLEAN = 'clean';
export const APPLIED = 'applied';
export const FAILED = 'failed';

const FETCH_TIMEOUT_MS = 30_000;
const LOG_TIMEOUT_MS = 10_000;
const PULL_TIMEOUT_MS = 30_000;
const NPM_TIMEOUT_MS = 120_000;
const SYNC_TIMEOUT_MS = 60_000;

/**
 * Run the daily upgrade if it is due.
 *
 * @param {object} deps
 * @param {string} deps.ownmindDir
 * @param {string} deps.markerFile   - the shared "already checked today" stamp
 * @param {string} deps.lockFile     - the shared lock; the MCP, both hooks and the scanner
 *                                     all take this one, so they cannot pull over each other
 * @param {string} deps.source       - goes into every event: 'mcp' | 'scanner'
 * @param {Function} deps.execFile   - promisified execFile(cmd, args, opts)
 * @param {Function} [deps.logEvent] - (type, details) => void
 * @param {Function} [deps.queueBanner] - ({ outcome, step, version }) => void
 * @param {Function} [deps.onApplied] - called after a successful upgrade, with the version
 *                                      now on disk. The MCP re-sends a heartbeat here.
 * @param {string} [deps.platform]
 * @param {Function} [deps.today]    - () => 'YYYY-MM-DD', local
 * @returns {Promise<{outcome: string, reason?: string, step?: string, version?: string}>}
 */
export async function runAutoUpdate({
  ownmindDir,
  markerFile,
  lockFile,
  source,
  execFile,
  logEvent = () => {},
  queueBanner = () => {},
  onApplied = null,
  platform = process.platform,
  today = () => localDateOnly(),
  fileSystem = fs
}) {
  const isWindows = platform === 'win32';
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';
  const stamp = today();

  let lastCheck = '';
  try { lastCheck = fileSystem.readFileSync(markerFile, 'utf8').trim(); } catch { /* first run */ }
  if (lastCheck === stamp) {
    logEvent('update_skipped', { source, reason: 'marker_today' });
    return { outcome: SKIPPED, reason: 'marker_today' };
  }
  if (!fileSystem.existsSync(path.join(ownmindDir, '.git'))) {
    logEvent('update_skipped', { source, reason: 'no_git_dir', dir: ownmindDir });
    return { outcome: SKIPPED, reason: 'no_git_dir' };
  }

  // A held lock is another program doing this minute's work and is not a problem. A lock
  // that could not be created at all is a read-only filesystem or a full disk; collapsing
  // the two into one word is the class of lie this whole area has been unpicking.
  const acquired = tryAcquireUpdateLock(lockFile);
  if (!acquired.acquired) {
    if (acquired.reason === 'lock_held') {
      logEvent('update_skipped', { source, reason: 'lock_held' });
      return { outcome: SKIPPED, reason: 'lock_held' };
    }
    logEvent('update_failed', { source, step: 'lock', error: acquired.reason });
    queueBanner({ outcome: 'failed', step: 'lock' });
    return { outcome: FAILED, step: 'lock' };
  }
  let lockHeld = true;
  const release = () => {
    if (!lockHeld) return;
    releaseUpdateLock(lockFile);
    lockHeld = false;
  };
  const markToday = () => {
    try { fileSystem.writeFileSync(markerFile, stamp); } catch { /* best effort */ }
  };
  const fail = (step, err) => {
    release();
    logEvent('update_failed', {
      source, step,
      error: err?.code || err?.message || String(err).slice(0, 120)
    });
    queueBanner({ outcome: 'failed', step });
    return { outcome: FAILED, step };
  };

  logEvent('update_check', { source });

  try {
    try {
      await execFile('git', ['fetch', '-q'], { cwd: ownmindDir, timeout: FETCH_TIMEOUT_MS });
    } catch (e) { return fail('fetch', e); }

    let pending = '';
    try {
      const { stdout } = await execFile('git', ['log', 'HEAD..origin/main', '--oneline'],
        { cwd: ownmindDir, timeout: LOG_TIMEOUT_MS });
      pending = String(stdout || '').trim();
    } catch (e) { return fail('log', e); }

    if (!pending) {
      release();
      markToday();
      logEvent('update_clean', { source });
      return { outcome: CLEAN };
    }

    // --autostash on the primary path (git 2.6+). The fallback deliberately does not pass
    // it: before v1.26.65 both paths did, so on older git both failed and there was no
    // fallback at all. --ff-only refuses a dirty tree rather than touching it — a manual
    // stash without a pop is how uncommitted work disappeared in v1.17.22.
    try {
      await execFile('git', ['pull', '-q', '--rebase', '--autostash'],
        { cwd: ownmindDir, timeout: PULL_TIMEOUT_MS });
    } catch {
      try {
        await execFile('git', ['pull', '-q', '--ff-only'],
          { cwd: ownmindDir, timeout: PULL_TIMEOUT_MS });
      } catch (e) { return fail('pull', e); }
    }

    // Windows needs the shell for npm.cmd: since the CVE-2024-27980 patch, execFile
    // refuses .cmd/.bat directly, which surfaced as `update_failed step=npm error=EINVAL`.
    try {
      await execFile(npmCmd, ['install', '-q'], {
        cwd: path.join(ownmindDir, 'mcp'),
        timeout: NPM_TIMEOUT_MS,
        windowsHide: true,
        shell: isWindows
      });
    } catch (e) { return fail('npm', e); }

    const syncScript = path.join(ownmindDir, 'scripts', isWindows ? 'update.ps1' : 'update.sh');
    try {
      if (isWindows) {
        await execFile('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', syncScript],
          { cwd: ownmindDir, timeout: SYNC_TIMEOUT_MS, windowsHide: true });
      } else {
        await execFile('bash', [syncScript], { cwd: ownmindDir, timeout: SYNC_TIMEOUT_MS });
      }
    } catch (e) { return fail('update_sh', e); }

    release();
    markToday();
    logEvent('update_applied', { source });

    // Read the version from disk now. Anything cached at module load is the version being
    // left behind, and reporting that is how machines appeared stuck on old releases long
    // after they had upgraded.
    let version = null;
    try {
      version = JSON.parse(
        fileSystem.readFileSync(path.join(ownmindDir, 'package.json'), 'utf8')).version || null;
    } catch { /* the upgrade still happened */ }

    queueBanner({ outcome: 'applied', version });
    if (onApplied) {
      try { await onApplied(version); }
      catch (e) {
        logEvent('update_heartbeat_failed', {
          source, error: e?.code || e?.message || String(e).slice(0, 120)
        });
      }
    }
    return { outcome: APPLIED, version };
  } catch (e) {
    return fail('unknown', e);
  } finally {
    release();
  }
}
