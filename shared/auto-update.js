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
const REBASE_ABORT_TIMEOUT_MS = 15_000;

/**
 * v1.26.142 — put a repository that stopped mid-rebase back the way it was.
 *
 * `git pull --rebase --autostash` stops and waits when it hits a conflict. On a machine
 * somebody is sitting at, that is the right behaviour. On one where this runs from a
 * timer it is a trap: the repository stays mid-rebase, every later pull fails with "you
 * are in the middle of a rebase" — the `--ff-only` fallback included — and the user's own
 * uncommitted changes stay parked in the autostash. The machine then reports a failed
 * update every two hours, forever, and the state that causes it is invisible from here.
 *
 * `git rebase --abort` returns the tree to its pre-pull state and restores the autostash,
 * so the next attempt starts from where the previous one began rather than from halfway
 * through it. Nothing is discarded: an abort is the operation that puts things back.
 *
 * Checked by directory rather than by running the abort blind, so the ordinary case costs
 * nothing and the log line means something when it appears.
 */
async function abortAnyRebase({ execFile, ownmindDir, fileSystem, logEvent, source }) {
  const mid = ['rebase-merge', 'rebase-apply']
    .some((d) => fileSystem.existsSync(path.join(ownmindDir, '.git', d)));
  if (!mid) return false;
  try {
    await execFile('git', ['rebase', '--abort'],
      { cwd: ownmindDir, timeout: REBASE_ABORT_TIMEOUT_MS });
    logEvent('update_rebase_aborted', { source });
    return true;
  } catch (e) {
    // Reported and not fatal. The pull below will fail on its own and say so with a step
    // name; swallowing the abort here would only replace one error with a less specific one.
    logEvent('update_rebase_abort_failed', {
      source, error: e?.code || e?.message || String(e).slice(0, 120)
    });
    return false;
  }
}

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
  // Lives next to the daily marker. Present means "the tree moved and the rest of the
  // installation has not caught up", which no amount of reading git can tell you.
  const stepsMarker = `${markerFile}.steps-pending`;

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

    // v1.26.142 — `pending` being empty is not the same as "there is nothing to do".
    //
    // The steps after the pull can fail on their own, and when they do, HEAD has already
    // advanced. The next run then finds no pending commits, calls itself clean, stamps the
    // day and never retries — leaving the machine on new code with old dependencies, or
    // with skills and hooks that were never re-synced, until somebody happens to push
    // another commit. That is a machine that reports a healthy upgrade every day and is
    // quietly broken, which is the failure mode this whole release is about.
    //
    // So the post-pull steps have their own marker. It is written before they start and
    // removed when they finish, and its presence means "redo them regardless of git".
    const unfinished = fileSystem.existsSync(stepsMarker);
    if (!pending && !unfinished) {
      markToday();
      release();
      logEvent('update_clean', { source });
      return { outcome: CLEAN };
    }

    if (pending) {
      // A rebase that stopped on a conflict leaves the repository mid-rebase, and every
      // later attempt fails with "you are in the middle of a rebase" — for good, on an
      // unattended machine, with the user's own changes held in the autostash. Nobody is
      // sitting there to resolve it, so the only useful thing to do is put the tree back
      // the way it was and let --ff-only decide. Aborting restores the autostash too.
      await abortAnyRebase({ execFile, ownmindDir, fileSystem, logEvent, source });

      // --autostash on the primary path (git 2.6+). The fallback deliberately does not
      // pass it: before v1.26.65 both paths did, so on older git both failed and there was
      // no fallback at all. --ff-only refuses a dirty tree rather than touching it — a
      // manual stash without a pop is how uncommitted work disappeared in v1.17.22.
      try {
        await execFile('git', ['pull', '-q', '--rebase', '--autostash'],
          { cwd: ownmindDir, timeout: PULL_TIMEOUT_MS });
      } catch {
        await abortAnyRebase({ execFile, ownmindDir, fileSystem, logEvent, source });
        try {
          await execFile('git', ['pull', '-q', '--ff-only'],
            { cwd: ownmindDir, timeout: PULL_TIMEOUT_MS });
        } catch (e) { return fail('pull', e); }
      }
    }

    // From here on, a failure has to be remembered: the working tree has moved and the
    // rest of the installation has not caught up with it yet.
    try { fileSystem.writeFileSync(stepsMarker, stamp); } catch { /* best effort */ }

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

    try { fileSystem.unlinkSync(stepsMarker); } catch { /* already gone */ }
    // Stamped before the lock is handed back. Releasing first leaves a gap in which
    // another program takes the lock, reads a marker that still says yesterday, and runs
    // the whole thing again.
    markToday();
    release();
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
