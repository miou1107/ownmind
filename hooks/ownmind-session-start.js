#!/usr/bin/env node
/**
 * OwnMind SessionStart Hook (L4)
 *
 * Load initial memory and display the iron rule digest.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { readCredentials, getClientVersion, resolveProjectName } from '../shared/helpers.js';
import { roleForProfile, fetchBugReportNotifications } from './lib/bug-report-notifications.js';
import { clearSessionOffState, readSessionOffState } from '../shared/session-off-state.js';
import { queueUpdateBanner } from '../shared/update-banner.js';
import { runConditionalSync } from './lib/conditional-sync.js';
// From the CLI module, which is where this function already lives. Importing it is safe: that
// file runs main() only when it is process.argv[1]. Importing rather than restating it is the
// point — a second copy of the fetch-and-cache rule is how the two platforms drifted apart in
// the first place.
import { syncEnforcementBundle } from './lib/conditional-sync-cli.js';
import { renderSessionContext } from './lib/render-session-context.js';
import { syncMemoryFiles, resolveMemoryDir } from './lib/sync-memory-files.js';
import { tryAcquireUpdateLock, releaseUpdateLock, isContention } from '../shared/update-lock.js';
import { localDateOnly, localIsoTimestamp } from '../shared/local-date.js';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.ownmind', 'logs');
// v1.26.98 — every event this hook writes carries the project, so a session the server has
// to rebuild from activity still knows which one it was. The users whose sessions are always
// rebuilt are precisely the ones the team page showed a blank project for.
const PROJECT_NAME = resolveProjectName();

function logEvent(event, extra = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const now = new Date();
    // v1.26.124: local, not UTC. The MCP writes into this same directory using the local
    // date, so a UTC filename here put the two halves of one day's events in two files for
    // the eight hours a UTC+8 machine is a day ahead. The timestamp moves with it, so a
    // line's own date and the name of the file holding it cannot disagree.
    const ts = localIsoTimestamp(now);
    const dateStr = localDateOnly(now);
    // v1.26.95: `details: extra`, not `...extra`. The batch endpoint reads e.details and
    // nothing else, so spreading the fields flat meant every one of them was discarded on
    // arrival — the same defect fixed in the two .sh hooks. This copy is the one Windows
    // runs (session-hook-command.cjs returns it for win32), so leaving it would have given
    // the same event two shapes depending on the user's OS: any later `details->>'status'`
    // query would read blank for every Windows user and say nothing about why.
    const details = PROJECT_NAME && extra.project === undefined
      ? { ...extra, project: PROJECT_NAME }
      : extra;
    const entry = JSON.stringify({ ts, event, tool: 'claude-code', source: 'hook', details });
    fs.appendFileSync(path.join(LOG_DIR, `${dateStr}.jsonl`), entry + '\n');
  } catch {}
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * v1.26.83 — report an event to the server as well as the local JSONL.
 *
 * The bash hook has always POSTed each event to /api/activity/batch; this file's port
 * dropped that line, so a Windows machine whose hook worked was indistinguishable,
 * server-side, from one whose hook was dead. Found while verifying the v1.26.82 rollout:
 * Adam restarted, his MCP showed up, and the hook-sourced init this whole repair is judged
 * by could never have appeared. Worse, the memory_load self-check reads exactly that
 * event, so every healthy Windows machine would be reported broken forever.
 *
 * Fire-and-forget with a short timeout: session start must never wait on telemetry, and
 * the pending request keeps the process alive just long enough to finish on its own.
 */
function reportEvent(apiUrl, apiKey, event, extra = {}) {
  logEvent(event, extra);
  try {
    const url = `${String(apiUrl).replace(/\/$/, '')}/api/activity/batch`;
    const body = JSON.stringify({
      events: [{
        ts: new Date().toISOString(),
        event,
        tool: 'claude-code',
        source: 'hook',
        // v1.26.95 — see logEvent above. v1.26.98 — carries the project for the same reason.
        details: PROJECT_NAME && extra.project === undefined
          ? { ...extra, project: PROJECT_NAME }
          : extra,
      }],
    });
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 3000,
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch { /* telemetry must never break session start */ }
}

/**
 * v1.26.83 — run one of the hooks/lib CLI scripts the way the shell hook does.
 *
 * Detached and unwatched: none of these may delay session start, and a failure in any of
 * them must not stop the memories from loading.
 *
 * v1.26.133 — all three streams are ignored, so nothing run through here may have output the
 * user is meant to read. The `stdinFile` option this used to carry existed for exactly such a
 * script (`flush-pending-banners.js`, which writes to stderr), and feeding it here is what
 * silently discarded every queued banner. It is gone rather than fixed: a helper that cannot
 * show output should not offer a way to pipe data into something that produces it.
 */
function runLibScript(script, { env } = {}) {
  try {
    const file = path.join(LIB_DIR, 'lib', script);
    if (!fs.existsSync(file)) return;
    const child = spawn(process.execPath, [file], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, ...(env || {}) },
      detached: true,
      windowsHide: true,
    });
    child.unref();
  } catch { /* never block session start */ }
}

/**
 * v1.26.83 — the flushes and drains the shell hook has always done and this one never did.
 *
 * Each is a spool of things that failed to reach the server earlier. On Windows nothing has
 * ever drained them, so they have simply been accumulating on disk.
 */
function drainSpools(apiUrl, apiKey) {
  const logDir = path.join(HOME, '.ownmind', 'logs');
  // v1.26.171: the banner spool is no longer flushed or cleared at session start. Notices
  // are delivered at the turn they happen via systemMessage on the Stop hook's stdout, and
  // every queued notice is written to the spool as a durable audit record (rotated at 1MB
  // by its writer). Flushing here re-announced already-delivered notices into a channel the
  // user never saw, then destroyed the record.

  const complianceSpool = path.join(logDir, 'reply-lint-pending.jsonl');
  if (fs.existsSync(complianceSpool) && fs.statSync(complianceSpool).size > 0) {
    runLibScript('flush-compliance-spool.js');
  }

  // The self-check upload spool: reports parked when an upload failed. Without this the
  // server never learns a machine finished upgrading.
  try {
    const selfCheck = path.join(HOME, '.ownmind', 'scripts', 'install-helpers', 'self-check.cjs');
    if (fs.existsSync(selfCheck) && apiKey && apiUrl) {
      const child = spawn(process.execPath, [
        '-e',
        `const sc=require(${JSON.stringify(selfCheck)});`
        + `if(sc.retrySpool)sc.retrySpool(process.argv[1],process.argv[2]).catch(()=>{});`,
        apiUrl, apiKey,
      ], { stdio: 'ignore', detached: true, windowsHide: true });
      child.unref();
    }
  } catch { /* best effort */ }
}

/**
 * v1.26.83 — the daily update check, which on this hook did not exist.
 *
 * Shares `.update-lock` and `.last-update-check` with the shell hook and the MCP, so the
 * three of them cannot run a `git pull` over each other.
 */
function maybeCheckForUpdates(apiUrl, apiKey) {
  try {
    const dir = path.join(HOME, '.ownmind');
    if (!fs.existsSync(path.join(dir, '.git'))) return;
    const lock = path.join(dir, '.update-lock');
    const marker = path.join(dir, '.last-update-check');

    // v1.26.124: local, not UTC — and the reason this one matters more than the log
    // filename. The shell sibling has always computed this marker with `date +%Y-%m-%d`,
    // and the MCP now agrees. While this line read UTC, the two hooks disagreed about
    // whether today's update had run for the whole 00:00–08:00 window on a UTC+8 machine:
    // each saw the other's marker as belonging to a different day, redid the update, and
    // rewrote the marker so the next session disagreed the other way.
    const today = localDateOnly();
    let last = '';
    try { last = fs.readFileSync(marker, 'utf8').trim(); } catch {}
    if (last === today) return;

    // v1.26.98 — actually take the lock. This used to read the file, return if it was fresh,
    // delete it if it was stale, and then create nothing at all: every concurrent hook found
    // no lock and ran the update script together. The shared helper is the same one the MCP
    // uses, so the three programs cannot disagree about what holding the lock means.
    //
    // The two failure modes are kept apart, as they are in the MCP and the shell hook:
    // another process doing the work is a skip; a lock that could not be created at all is a
    // read-only filesystem or a full disk, and collapsing that into `lock_held` would be the
    // same class of lie this release exists to remove.
    const lockResult = tryAcquireUpdateLock(lock);
    if (!lockResult.acquired) {
      if (isContention(lockResult.reason)) {
        reportEvent(apiUrl, apiKey, 'update_skipped', { reason: lockResult.reason });
      } else {
        reportEvent(apiUrl, apiKey, 'update_failed', { step: 'lock', error: lockResult.reason });
        // v1.26.129: the user hears about a failure wherever it happens. This hook is the
        // updater on Windows, so reporting only in the bash sibling would leave Windows silent.
        queueUpdateBanner({ outcome: 'failed', step: 'lock' });
      }
      return;
    }
    // The lock is deliberately not released here. The work happens in a detached child that
    // outlives this process, so there is nobody left to release it; the five-minute staleness
    // sweep reclaims it. Holding it that long costs nothing — the daily marker below already
    // stops a second run today.

    reportEvent(apiUrl, apiKey, 'update_check', {});
    const updateScript = path.join(dir, 'scripts',
      process.platform === 'win32' ? 'update.ps1' : 'update.sh');
    if (!fs.existsSync(updateScript)) {
      // Nothing was started, so nothing is going to release it later — hand it back now
      // rather than blocking the MCP for the next five minutes over a no-op.
      releaseUpdateLock(lock);
      // Stamp the marker first. A broken install is worth reporting, but the marker is
      // written only after a successful spawn below, so without this the pair
      // update_check + update_failed would fire on *every* session rather than once a day —
      // exactly the repetition that made `update_failed` stop meaning anything.
      try { fs.writeFileSync(marker, today); } catch { /* best effort */ }
      reportEvent(apiUrl, apiKey, 'update_failed', { step: 'update_script_missing' });
      queueUpdateBanner({ outcome: 'failed', step: 'update_script_missing' });
      return;
    }

    // The MCP does the git pull itself; this only re-syncs skills, hooks and the scheduler,
    // which is the part that repairs a machine rather than upgrading it.
    const child = process.platform === 'win32'
      ? spawn('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', updateScript],
        { stdio: 'ignore', detached: true, windowsHide: true, cwd: dir })
      : spawn('bash', [updateScript], { stdio: 'ignore', detached: true, cwd: dir });
    child.unref();
    try { fs.writeFileSync(marker, today); } catch {}
  } catch { /* never block session start */ }
}

/**
 * v1.26.172 (P1 action gate, Task 7) — provision the gate state for this session.
 *
 * Key, this session's nonce (regenerated if planted), the gate-current-session pointer the
 * approval CLI reads, and the 30-day sweep of dead per-session state. It runs before the
 * credential guard on purpose: the gate works off the local enforcement cache, so a
 * machine with no API key still gets provisioned. The import is dynamic and the whole call
 * is wrapped — provisioning must never delay or break session start; a machine this
 * skipped on is covered loudly by the gate CLI at first use.
 */
async function provisionGate() {
  try {
    let payload = {};
    // Only read stdin when something is piping into it; on a terminal this would wait for
    // input that never comes (same guard as ownmind-prompt-inject.js).
    if (!process.stdin.isTTY) {
      try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { payload = {}; }
    }
    let sessionId = payload?.session_id;
    if (typeof sessionId !== 'string' || !sessionId) return; // nothing to provision for
    // Unsafe ids collapse to 'unknown', matching action-gate-cli.js, so the nonce written
    // here is the nonce the gate will look for.
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) sessionId = 'unknown';
    const { provisionGateSession } = await import('./lib/gate-provision.js');
    const stateDir = process.env.OWNMIND_GATE_STATE_DIR
      || path.join(HOME, '.ownmind', 'state');
    provisionGateSession(stateDir, sessionId);
  } catch { /* never delay or break session start; the gate CLI reprovisions loudly */ }
}

/**
 * Gate message i18n, task 2 of 7 — detect this machine's OS locale for getLocale() to read
 * back later.
 *
 * getLocale() (hooks/lib/locale.js) must stay sync and subprocess-free so it can run on
 * every hook message, so this is the one place allowed to shell out for it, once per
 * session. Same fire-and-forget shape as provisionGate() right above: the import is dynamic
 * and the whole call is wrapped, so a broken or slow detector can never delay or break
 * session start — getLocale() falls back to 'en' regardless of whether this ever ran.
 */
async function provisionOsLocale() {
  try {
    const { provisionLocale } = await import('./lib/locale-provision.js');
    provisionLocale({ homeDir: HOME });
  } catch { /* never delay or break session start; getLocale() falls back to 'en' */ }
}

async function main() {
  // v1.26.172 — gate provisioning first: it is local-only and must happen even on the
  // paths below that exit before the memory load (missing credentials, unreachable API).
  await provisionGate();

  // Gate message i18n, task 2 — same local-only reasoning as gate provisioning above; a
  // machine with no API key still gets its OS locale detected for hook message rendering.
  await provisionOsLocale();

  // v1.20.3: when a new session starts, clear the legacy "session temporarily disabled" state file.
  // Implements the spec's "new session auto-resumes" — opening a new conversation re-enables the OwnMind hooks.
  try {
    const prev = readSessionOffState();
    if (prev) {
      clearSessionOffState();
      logEvent('session_off_cleared_on_new_session', { prev_session_id: prev.session_id });
    }
  } catch { /* fail-open */ }

  const { apiKey, apiUrl } = readCredentials();
  if (!apiKey || !apiUrl) process.exit(0);

  logEvent('init', { status: 'starting' });

  // v1.26.83 — everything the shell hook does around the load, and this one did not.
  drainSpools(apiUrl, apiKey);
  maybeCheckForUpdates(apiUrl, apiKey);

  // The enforcement bundle — the selection keys, guard rules and injectable text every later
  // hook reads locally to check a turn against the standards.
  //
  // This call lives in conditional-sync-cli.js as well, whose own comment reasons that the
  // .sh hook is what "both platforms actually run" and that a sync written into the .js
  // "would never execute on the machine it was written for". Both halves of that are true of
  // macOS and Linux and neither is true here: Windows registers this file, and this file
  // imports runConditionalSync directly rather than going through that CLI. So on Windows the
  // bundle was never fetched, ~/.ownmind/cache/enforcement.json never existed, and every
  // standards check reported "this machine has never synced" — correctly, and forever.
  //
  // Measured 2026-08-15 on Windows: the server returns a populated bundle to a direct request
  // and the file was still absent after a clean session start into a fresh home.
  //
  // Ahead of the init sync and not gated on it, matching the CLI: the two have separate
  // freshness windows and separate failure modes, and letting either decide the other would
  // mean an unrelated outage quietly switching enforcement off.
  try {
    await syncEnforcementBundle(apiUrl, apiKey);
  } catch { /* never block the load; syncEnforcementBundle already logs its own outcome */ }

  // v1.26.83 — conditional sync rather than an unconditional full download. Skips the
  // payload when the server's sync_token matches the cache (~95% of sessions), and stamps
  // the cache with the account so another account's memories can never be served from it.
  let initData;
  try {
    const result = await runConditionalSync({ apiUrl, apiKey });
    initData = result?.data || null;
  } catch { initData = null; }

  if (!initData) {
    reportEvent(apiUrl, apiKey, 'init_fail', { status: 'api_timeout' });
    process.exit(0);
  }

  reportEvent(apiUrl, apiKey, 'init', { status: 'ok' });

  // v1.26.83 — broadcasts. The shell hook has always fetched these; this one never did, so
  // every announcement sent from the admin console was invisible to the Windows half of the team.
  let broadcasts = [];
  try {
    const clientVersion = getClientVersion() || '';
    let url = `${apiUrl}/api/broadcast/active?tool=claude-code`;
    if (clientVersion) url += `&client_version=${encodeURIComponent(clientVersion)}`;
    const headers = { Authorization: `Bearer ${apiKey}` };
    if (clientVersion) headers['X-Ownmind-Version'] = clientVersion;
    const raw = await httpGet(url, headers);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) broadcasts = parsed;
  } catch { /* no broadcasts is a normal state; never block the load */ }

  // v1.26.83 — render through the shared renderer instead of a second, drifting copy of
  // the layout. Windows and macOS now read identically.
  //
  // The bug-report notifications go through it too, rather than being appended afterwards as
  // they were until now. Appending was how the section ended up in one platform's entry point
  // and nowhere else: see hooks/lib/bug-report-notifications.js. Rendering it here also puts it
  // in the same place on both platforms instead of after the closing tip on one of them.
  const notif = await fetchBugReportNotifications({
    apiUrl, apiKey, role: roleForProfile(initData.profile), httpGet,
  });
  if (!notif) logEvent('bug_report_notifications_fetch_failed', {});

  const lines = [renderSessionContext(initData, broadcasts, { notifications: notif })];


  lines.push('The ownmind_* MCP tools manage memory. For full iron rule content: ownmind_get("iron_rule").');

  // v1.26.83 — write the memories into this project's directory, as the shell hook does.
  // Without it the AI reads whatever snapshot was last written, which on Windows was never.
  try {
    const memoryDir = resolveMemoryDir({
      claudeProjectDir: process.env.CLAUDE_PROJECT_DIR,
      home: HOME,
    });
    if (memoryDir) {
      try {
        const raw = await httpGet(
          `${apiUrl}/api/memory/sync?types=iron_rule,project,feedback`,
          { Authorization: `Bearer ${apiKey}` }
        );
        syncMemoryFiles({ memoryDir, data: JSON.parse(raw) });
      } catch {
        // Mark the index as stale rather than leaving yesterday's copy looking current.
        syncMemoryFiles({ memoryDir, sync_failed: true });
        reportEvent(apiUrl, apiKey, 'memory_sync_fail', {});
      }
    }
  } catch { /* never block session start */ }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
