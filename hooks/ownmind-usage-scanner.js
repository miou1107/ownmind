#!/usr/bin/env node
/**
 * hooks/ownmind-usage-scanner.js
 *
 * Main entry: invokes each tool adapter in turn through the shared `runScan()` flow, sending
 * events + heartbeat.
 * Plan P4: currently only the claude-code adapter is wired; P5 adds codex and opencode.
 *
 * After installation this is invoked every 30 minutes by launchd / systemd / Task Scheduler (P6).
 */

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { runAutoUpdate } from '../shared/auto-update.js';
import { queueUpdateBanner } from '../shared/update-banner.js';
import { readCredentials, getClientVersion } from '../shared/helpers.js';
import {
  runScan, readOffsets, writeOffsetsAtomic, reportCollectorState,
  accountFingerprint, cursorForAccount, DEFAULT_CACHE_PATH
} from '../shared/scanners/base.js';
import { ADAPTER_ERROR, ADAPTER_TIMEOUT, SKIPPED_BY_CONFIG } from '../shared/scanners/reasons.js';
import { createClaudeCodeAdapter } from '../shared/scanners/claude-code.js';
import { createCodexAdapter } from '../shared/scanners/codex.js';
import { createOpenCodeAdapter } from '../shared/scanners/opencode.js';
import { createCursorAdapter } from '../shared/scanners/cursor.js';
import { createAntigravityAdapter } from '../shared/scanners/antigravity.js';

const execFileAsync = promisify(_execFile);

/**
 * v1.26.142 — a logger whose own failure cannot end the run.
 *
 * `log()` awaits `fs.mkdir` and `fs.appendFile`. On a read-only home or a full disk those
 * reject, and a rejection with no handler attached terminates the process on Node 15 and
 * later. Every other call to `log()` in this file is awaited inside a `try`; these two are
 * inside a synchronous callback that cannot await, so the handler is attached here instead.
 *
 * A collector that dies because it could not write a line about a collector that died is
 * the same failure this release is about, one level up.
 */
const quietLogger = { warn: (m) => { log(m).catch(() => {}); } };

const HOME = os.homedir();
const LOG_PATH = path.join(HOME, '.ownmind', 'logs', 'scanner.log');
const LOCK_PATH = path.join(HOME, '.ownmind', 'cache', 'scanner.lock');

async function log(line) {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

const STALE_LOCK_MS = 6 * 60 * 60 * 1000;  // 6 hours

/**
 * v1.26.142 — how long one adapter may take before the run stops waiting for it.
 *
 * A throw is caught, logged and reported. A scan that never finishes is not: the loop
 * stays on that tool, the adapters after it never run, and the whole run dies whenever
 * the scheduler gives up. The visible result is one account whose first tool checks in
 * every two hours while the four behind it are frozen on a date months old — which is
 * what the records of one member look like.
 *
 * Ten minutes. The measured worst case is a few seconds for a long history, so this is a
 * ceiling for a machine far outside anything seen, not a target. The scheduler's own
 * interval is two hours, so no run can overlap the next.
 */
const ADAPTER_DEADLINE_MS = 10 * 60 * 1000;

/**
 * v1.26.142 — the daily upgrade, run from the scheduler.
 *
 * Shares `.update-lock` and `.last-mcp-update-check` with the MCP, so on a machine that
 * also runs an AI tool the two cannot both pull, and whichever gets there first settles
 * the day for both. The marker's name is left as it is: renaming it would make every
 * installed machine believe today's check had not happened and run one extra upgrade, for
 * nothing but a tidier filename.
 *
 * Every failure is swallowed. The scanner's job is usage collection; an upgrade that
 * cannot run must not cost the account its data.
 */
async function maybeUpgrade() {
  const inFlight = [];
  try {
    // Read here rather than taken from main(): this runs outside it now, and a credential
    // that travels through a return value ends up in somebody's log eventually.
    const { apiKey, apiUrl } = readCredentials();
    const dir = path.join(HOME, '.ownmind');
    const result = await runAutoUpdate({
      ownmindDir: dir,
      markerFile: path.join(dir, '.last-mcp-update-check'),
      lockFile: path.join(dir, '.update-lock'),
      source: 'scanner',
      execFile: execFileAsync,
      logEvent: (event, details) => {
        // Collected rather than fired and forgotten. The direct-run handler exits the
        // process as soon as main() resolves — it has to, or a wedged adapter's handle
        // would keep it alive forever — and an exit cuts every request still in flight.
        // These are the events that say whether the upgrade happened, on the machines
        // where nobody would otherwise know, so losing them to the exit would remove the
        // observability this change exists to add.
        inFlight.push(log(`[scanner] ${event} ${JSON.stringify(details)}`).catch(() => {}));
        inFlight.push(postActivityEvent({ apiUrl, apiKey, event, details }));
      },
      queueBanner: (b) => { try { queueUpdateBanner(b); } catch { /* best effort */ } }
      // No post-upgrade heartbeat here, unlike the MCP. That one exists because an MCP
      // process lives for a whole conversation and would report the version it started
      // with for hours. This process exits in seconds and the next run, two hours later,
      // reads the new version off disk — the server corrects itself without another code
      // path to keep right.
    });
    if (result?.outcome && result.outcome !== 'skipped') {
      await log(`[scanner] upgrade ${result.outcome}`
        + `${result.step ? ` step=${result.step}` : ''}`
        + `${result.version ? ` version=${result.version}` : ''}`);
    }
  } catch (err) {
    await log(`[scanner] upgrade check failed: ${err?.message || err}`);
  } finally {
    // postActivityEvent swallows its own errors and log() is wrapped above, so this
    // settles rather than throws. In the finally so an upgrade that failed still gets its
    // failure reported before the process goes.
    await Promise.allSettled(inFlight);
  }
}

/**
 * Fire-and-forget activity event, so an upgrade run by the scheduler is as visible on the
 * server as one run by the MCP. Failures are silent by design: this is a report about a
 * report.
 */
async function postActivityEvent({ apiUrl, apiKey, event, details }) {
  if (!apiUrl || !apiKey) return;
  try {
    await fetch(`${String(apiUrl).replace(/\/+$/, '')}/api/activity/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        events: [{
          ts: new Date().toISOString(),
          event,
          tool: 'scanner',
          source: 'scanner',
          details: details || {}
        }]
      }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch { /* best effort */ }
}

/**
 * Reject if `work` has not settled within the deadline.
 *
 * The underlying work is not cancellable — nothing here can reach inside a wedged file
 * read — so this abandons the wait rather than the operation. That is the whole point:
 * the remaining adapters get to run, and the tool that hung gets to say so. The process
 * exits when its event loop drains, as before.
 *
 * @param {string} tool
 * @param {Promise<any>} work
 * @param {number} [deadlineMs]
 */
function withAdapterDeadline(tool, work, deadlineMs = ADAPTER_DEADLINE_MS) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        `${tool} did not finish within ${Math.round(deadlineMs / 1000)}s`);
      // A flag, not a message match: the reason code is chosen from this, and matching on
      // wording would silently pick the wrong code the day somebody rewrites the sentence.
      err.__adapterTimeout = true;
      reject(err);
    }, deadlineMs);
    // No unref here, and the reason is the whole point of the deadline.
    //
    // It was unref'd so a finished run would not sit waiting out the remaining minutes —
    // but `clearTimeout` in the `finally` below already does that, and an unref'd timer
    // cannot hold the event loop open. An adapter wedged on an awaited promise rather than
    // on a live handle holds nothing either, so the loop would drain and the process would
    // leave *before* the deadline ever fired: the tool that hung would report nothing,
    // which is the exact silence this was written to break.
    //
    // Node 20's test runner says so out loud — "Promise resolution is still pending but
    // the event loop has already resolved" — while Node 24 keeps the runner's own handle
    // alive and hides it. Locally green, and wrong.
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Self-locking: prevents the scheduled scanner from colliding with a manual run.
 *
 * Create the lock file with O_EXCL. When it already exists:
 *   1. Read the PID inside; if that process is gone (`kill -0` returns ESRCH) → treat as stale, take over.
 *   2. Or if the lock file's mtime is older than 6 hours → treat as stale, take over.
 *   3. Otherwise assume another instance is alive and return false.
 *
 * This avoids an orphaned lock from SIGKILL / OOM / laptop sleep blocking all future scans forever.
 */
async function acquireLock() {
  await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });

  while (true) {
    try {
      const handle = await fs.open(LOCK_PATH, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    // Lock already exists — check whether it's stale.
    let stale = false;
    try {
      const raw = await fs.readFile(LOCK_PATH, 'utf8');
      const otherPid = parseInt(raw.trim(), 10);
      if (Number.isFinite(otherPid) && otherPid > 0 && otherPid !== process.pid) {
        try {
          process.kill(otherPid, 0);  // returns if it exists; throws ESRCH if it does not
        } catch (e) {
          if (e.code === 'ESRCH') stale = true;
        }
      }
      if (!stale) {
        const st = await fs.stat(LOCK_PATH);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) stale = true;
      }
    } catch {
      // Can't read it → treat as stale and rebuild.
      stale = true;
    }

    if (!stale) return false;

    // Delete the stale lock then retry once (still wx to avoid a race).
    try { await fs.unlink(LOCK_PATH); } catch { /* another process just took over — also fine */ }
  }
}

async function releaseLock() {
  try { await fs.unlink(LOCK_PATH); } catch { /* best-effort */ }
}

async function main() {
  const locked = await acquireLock();
  if (!locked) {
    await log('[scanner] another instance is running (lock exists), skipping');
    return;
  }

  try {
    const { apiKey, apiUrl, source, background_safe: backgroundSafe } = readCredentials();
    if (!apiKey || !apiUrl) {
      // v1.26.65 — this used to `return`, so the process exited 0 and every layer
      // above reported success: run-hidden.vbs, Task Scheduler's LastTaskResult,
      // and the diagnostic that tells people to read it.
      //
      // The scanner cannot inherit an environment the way the MCP does; it has to
      // find the credentials itself. So this branch is exactly where the two
      // components diverge, and it is the one place a broken scanner still gets to
      // say so. Throwing makes the direct-run handler log and exit 1.
      //
      // v1.26.82 — the message used to name ~/.claude/settings.json alone, which sent
      // whoever read it to look in the one place the key increasingly is not.
      throw new Error('credentials not found in ~/.claude/settings.json, '
        + '~/.claude.json (mcpServers.ownmind.env) or the OWNMIND_API_KEY / '
        + 'OWNMIND_API_URL environment variables; the usage scanner cannot report anything');
    }
    // v1.26.82 — the key exists but only in an environment variable. The MCP is handed
    // that environment by Claude Code; this process is started by Task Scheduler / launchd
    // and is not. It happens to have inherited one here, and will not next time.
    if (backgroundSafe === false) {
      await log(`[scanner] WARNING: credentials came from ${source?.key}, which a scheduled `
        + 'run does not inherit. Re-run the installer so they are written to a file.');
    }

    const scannerVersion = getClientVersion() || 'unknown';
    const machine = os.hostname();

    // v1.26.69 — the cursor file used to record no account, so a machine that changed
    // credentials handed the new account the previous one's "already reported" state.
    // Checked once per run rather than per adapter: a change invalidates every tool at
    // the same moment, and reporting it on whichever adapter happened to go first would
    // be worse than not reporting it at all.
    const fingerprint = accountFingerprint({ apiUrl, apiKey });
    const { state: scoped, changed: accountChanged } =
      cursorForAccount(await readOffsets(DEFAULT_CACHE_PATH), fingerprint);
    await writeOffsetsAtomic(DEFAULT_CACHE_PATH, scoped);
    if (accountChanged) {
      await log('[scanner] account changed on this machine; day cursors reset, '
        + 'read positions kept so the new account starts from now, not from history');
    }

    // OWNMIND_SKIP_TOOLS=tool1,tool2 skips the named adapters (for backfill / debug).
    const skip = new Set(
      (process.env.OWNMIND_SKIP_TOOLS || '')
        .split(',').map((s) => s.trim()).filter(Boolean)
    );
    if (skip.size > 0) {
      await log(`[scanner] OWNMIND_SKIP_TOOLS active: skipping ${[...skip].join(',')}`);
    }
    const adapterSpecs = [
      // Tier 1 — raw token events
      { tool: 'claude-code', factory: createClaudeCodeAdapter },
      { tool: 'codex',       factory: createCodexAdapter },
      { tool: 'opencode',    factory: createOpenCodeAdapter },
      // Tier 2 — session_count only
      { tool: 'cursor',      factory: createCursorAdapter },
      { tool: 'antigravity', factory: createAntigravityAdapter }
    ];
    const adapters = adapterSpecs
      .filter((spec) => !skip.has(spec.tool))
      .map((spec) => spec.factory({ scannerVersion, machine }));

    // v1.26.142 — a tool named in OWNMIND_SKIP_TOOLS leaves the adapter list above and,
    // until now, left the account's records entirely: no row, no date, nothing to
    // distinguish it from a tool the member has never installed. The variable is meant for
    // backfills and debugging, which makes it exactly the kind of thing that gets set on a
    // machine once and stays set.
    for (const spec of adapterSpecs.filter((s) => skip.has(s.tool))) {
      await reportCollectorState(
        { apiUrl, apiKey, logger: quietLogger },
        { tool: spec.tool, reason: SKIPPED_BY_CONFIG, scannerVersion, machine }
      );
    }

    // v1.26.72 — collected and returned, so the self-check can compare "what this
    // machine just did" against "what the server says it now holds". Until now this loop
    // wrote its findings only to a log file on the machine with the problem.
    const scanned = [];

    for (const adapter of adapters) {
      try {
        const result = await withAdapterDeadline(
          adapter.tool, runScan({ adapter, apiUrl, apiKey, accountChanged }));
        scanned.push({
          tool: adapter.tool,
          sent: result.sent ?? 0,
          accepted: result.accepted ?? 0,
          sessions: result.sessions ?? 0,
          reason: result.reason ?? null
        });
        // v1.26.65: `files=` says how many source files were visible. Without it
        // `sent=0` cannot be read: nothing new and cannot see anything look the
        // same, and on 2026-08-05 that cost an hour of chasing the wrong cause.
        const seen = result.files == null ? '' : ` files=${result.files}`;
        // Skipped files used to end the whole tool's scan. They no longer do, which
        // means they would now pass unnoticed unless the count says otherwise.
        const missed = result.skipped?.length
          ? ` skipped=${result.skipped.length}(${[...new Set(result.skipped)].join(',')})`
          : '';
        // v1.26.66: `sent` counts token events, and a Tier 2 adapter has none by
        // construction, so cursor and antigravity printed all zeros whether they had
        // just recorded a day or recorded nothing at all. This is the line a human
        // reads to decide whether collection is working, and for two of the five tools
        // it could not answer the question. That is how a dead antigravity adapter went
        // eleven weeks unnoticed.
        const days = ` sessions=${result.sessions ?? 0}`;
        // v1.26.69: the counts say a scan produced nothing; `reason` says why. Reading
        // all-zeros and having to work out which of five causes applied is what made
        // diagnosing one machine take an hour on 2026-08-05.
        const why = result.reason ? ` reason=${result.reason}` : '';
        await log(`[scanner] ${adapter.tool} ` +
          `sent=${result.sent} accepted=${result.accepted} duplicated=${result.duplicated} ` +
          `batches=${result.batches}${days}${seen}${missed}${why}`);
      } catch (err) {
        await log(`[scanner] ${adapter.tool} failed: ${err.message}`);
        // A thrown adapter sent nothing and cannot say why, which is not the same as
        // "nothing to send". Recorded so the self-check reports it rather than skipping
        // the tool entirely.
        const reason = err?.__adapterTimeout ? ADAPTER_TIMEOUT : ADAPTER_ERROR;
        scanned.push({
          tool: adapter.tool, sent: 0, accepted: 0, sessions: 0,
          reason, error: err.message
        });
        // v1.26.142 — and reported off the machine. Until now the line above was the
        // whole of it: correct, complete, and in a file on the one computer nobody is
        // looking at. `runScan` sends a heartbeat on every outcome it reaches, so the
        // only way for a tool to have no row at all is to end up here — which is exactly
        // how a member who works in Codex all day came to have no `codex` row for six
        // weeks, indistinguishable from never having installed it.
        await reportCollectorState(
          { apiUrl, apiKey, logger: quietLogger },
          { tool: adapter.tool, reason, scannerVersion, machine, error: err.message }
        );
      }
    }

    // The upgrade is deliberately NOT here. See the direct-run block at the end of the
    // file: `main` is also imported and called as "run one scan" by the self-check, and an
    // upgrade inside it would run under that check's 60-second budget, from inside the very
    // script an upgrade launches.
    //
    // No credentials in here. The caller that needs them reads them itself; a secret
    // that travels in a return value ends up in somebody's log eventually.
    return { machine, scannerVersion, scanned };
  } finally {
    await releaseLock();
  }
}

export { main, acquireLock, releaseLock, withAdapterDeadline, ADAPTER_DEADLINE_MS };

// Only run main when invoked directly; importing this module does not trigger it (test-friendly).
// fileURLToPath handles Windows backslash and URL-encoding differences — a plain `import.meta.url`
// string comparison fails on Windows.
const isDirectRun = process.argv[1] && (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); }
  catch { return false; }
})();
if (isDirectRun) {
  // v1.26.142 — the upgrade belongs to *this* entry point and to nothing else.
  //
  // `main` is exported, and the self-check imports it as `scan` to mean "run one scan and
  // tell me what you found". Putting the upgrade inside main() therefore put a `git pull`
  // and an `npm install` inside a check that runs under a 60-second budget — and the
  // self-check is itself spawned from `update.sh`, which an upgrade is what launches. On
  // a machine eight weeks behind, i.e. exactly the machines this is for, npm alone
  // outlasts that budget: the check would time out having proven nothing, stamp its weekly
  // marker anyway, and `process.exit(0)` out of the self-check while still holding the
  // update lock — which five minutes later another process reclaims as stale and starts a
  // second pull into the same directory, on top of the first one's orphaned children.
  //
  // Only a run started by the scheduler upgrades. Everything else just scans.
  main()
    .then(async (result) => {
      await maybeUpgrade();
      return result;
    })
    // v1.26.142 — exit rather than waiting for the event loop to drain.
    //
    // The per-adapter deadline stops the run waiting on a wedged scan, and the wedged scan
    // does not stop: nothing here can reach inside a stalled file read. Its handle keeps
    // the event loop alive, so a process that has finished its work, released its lock and
    // has nothing left to do would sit there indefinitely — and the scheduler would start
    // another one every two hours next to it.
    //
    // Everything this process owes anybody has been awaited by the time main() resolves:
    // the events are posted, the cursor file is written, the lock is handed back. Leaving
    // is the correct end of the run, not an abandonment of it.
    .then(() => { process.exit(0); })
    .catch(async (err) => {
      await log(`[scanner] fatal: ${err.message}`);
      try { await releaseLock(); } catch { /* ignore */ }
      process.exit(1);
    });
}
