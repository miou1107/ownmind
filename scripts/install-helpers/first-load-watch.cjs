#!/usr/bin/env node
'use strict';
/**
 * first-load-watch.cjs — tells the colleague, with a desktop notification, once OwnMind has
 * actually loaded their memories after an install.
 *
 * The installer cannot know that: the first load happens in the NEXT conversation the person
 * opens, after the install script has already exited. So install.sh / install.ps1 start this
 * file detached just before they print their NEXT: line. It asks the server every 15 seconds
 * (GET /api/install/first-load?since=<install start>) whether this account's SessionStart hook
 * has loaded memory since the install began.
 *
 *   - the server says loaded       -> one notification, "OwnMind is running ...", then it stops
 *   - ten minutes pass without it  -> one notification, "installed but has not loaded yet", then it stops
 *   - a request that throws, or an answer that is not 200, counts as "not yet" and polling goes on
 *
 * Command line (always exits 0; the outcome goes to ~/.ownmind/logs/first-load-watch.log):
 *   node first-load-watch.cjs --since <ISO> [--locale xx] [--timeout-ms N] [--interval-ms N]
 * The API URL and key come from resolve-credentials.cjs, never from the arguments: the arguments
 * are the process's command line, which any account can read with `ps`.
 *
 * One watcher at a time: the pid is kept in ~/.ownmind/state/first-load-watch.pid and a new
 * watcher stops the old one first (a second install should not leave two notifications queued).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_INTERVAL_MS = 15_000;

/**
 * Polls until the server reports a load or the time runs out.
 * @param {object} o
 * @param {string} o.apiUrl     server base URL (a trailing slash is fine)
 * @param {string} o.apiKey
 * @param {string} o.since      ISO timestamp taken when the install run started
 * @param {Function} o.fetch    fetch-compatible
 * @param {(kind: 'loaded'|'not_loaded') => void} o.notify
 * @param {() => number} o.now  milliseconds
 * @param {(ms: number) => Promise<void>} o.sleep
 * @returns {Promise<'loaded'|'not_loaded'>}
 */
async function watchFirstLoad({
  apiUrl, apiKey, since, fetch = globalThis.fetch, notify, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS,
}) {
  const url = `${String(apiUrl).replace(/\/+$/, '')}/api/install/first-load?since=${encodeURIComponent(since)}`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  const say = (kind) => { try { notify(kind); } catch { /* a missing notification service must not end the watch */ } };
  const startedAt = now();

  for (;;) {
    try {
      const res = await fetch(url, { headers });
      if (res && res.status === 200) {
        const body = await res.json();
        if (body && body.loaded === true) {
          say('loaded');
          return 'loaded';
        }
      }
    } catch { /* offline, a reset connection, an unreadable body: ask again next time */ }

    const left = timeoutMs - (now() - startedAt);
    if (left <= 0) {
      say('not_loaded');
      return 'not_loaded';
    }
    await sleep(Math.min(intervalMs, left));
  }
}

/** The command line of a running process, or '' when there is no such process. */
function commandOfProcess(pid) {
  try {
    if (process.platform === 'win32') {
      return String(execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
      ], { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    }
    return String(execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
  } catch {
    return '';
  }
}

/**
 * Stops the watcher recorded in `pidFile` (only when that pid still runs this script: pids get
 * reused) and records `ownPid` there instead.
 */
function replaceRunningWatcher({
  pidFile, ownPid = process.pid, commandOf = commandOfProcess,
  kill = (pid) => process.kill(pid),
}) {
  try {
    const old = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isInteger(old) && old > 0 && old !== ownPid && commandOf(old).includes('first-load-watch')) {
      try { kill(old); } catch { /* it ended on its own in the meantime */ }
    }
  } catch { /* no pid file yet */ }
  try {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, `${ownPid}\n`);
  } catch { /* the pid file is a convenience; the watch still works without it */ }
}

function removePidFileIfOurs(pidFile, ownPid = process.pid) {
  try {
    if (Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) === ownPid) fs.unlinkSync(pidFile);
  } catch { /* already gone */ }
}

function appendLog(logFile, fields) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const line = [`ts=${new Date().toISOString()}`, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join(' ');
    fs.appendFileSync(logFile, `${line}\n`);
  } catch { /* nowhere to write: say nothing, the watcher must never fail the install */ }
}

/** Shows `text` with the platform's notifier. Linux has none: the outcome is only logged. */
function platformNotifier(text, helpersDir = __dirname) {
  if (process.platform === 'darwin') {
    const r = spawnSync('bash', [path.join(helpersDir, 'notify.sh'), text], { encoding: 'utf8', timeout: 20_000 });
    if (r.stdout) process.stdout.write(r.stdout);
  } else if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(helpersDir, 'notify.ps1'), '-Text', text,
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r.stdout) process.stdout.write(r.stdout);
  }
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : '';
}

async function main(argv) {
  const home = os.homedir();
  const ownmindDir = path.join(home, '.ownmind');
  const logFile = path.join(ownmindDir, 'logs', 'first-load-watch.log');
  const pidFile = path.join(ownmindDir, 'state', 'first-load-watch.pid');

  const since = argValue(argv, '--since');
  if (!since || Number.isNaN(Date.parse(since))) {
    appendLog(logFile, { outcome: 'no_since' });
    return;
  }

  const { resolveCredentials } = require('./resolve-credentials.cjs');
  const { apiKey, apiUrl } = resolveCredentials({ home });
  if (!apiKey || !apiUrl) {
    appendLog(logFile, { outcome: 'no_credentials', since });
    return;
  }

  const messages = require('./install-messages.cjs');
  const locale = messages.normalizeLocale(argValue(argv, '--locale')) || messages.detectLocale();

  replaceRunningWatcher({ pidFile });
  const stop = () => { removePidFileIfOurs(pidFile); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const timeoutMs = Number.parseInt(argValue(argv, '--timeout-ms'), 10) || DEFAULT_TIMEOUT_MS;
  const intervalMs = Number.parseInt(argValue(argv, '--interval-ms'), 10) || DEFAULT_INTERVAL_MS;

  const outcome = await watchFirstLoad({
    apiUrl, apiKey, since, timeoutMs, intervalMs,
    notify: (kind) => platformNotifier(messages.sentence(`install.notify.${kind}`, locale)),
  });
  appendLog(logFile, { outcome, since, locale });
  removePidFileIfOurs(pidFile);
}

module.exports = { watchFirstLoad, replaceRunningWatcher, commandOfProcess, DEFAULT_TIMEOUT_MS, DEFAULT_INTERVAL_MS };

if (require.main === module) {
  main(process.argv.slice(2)).catch(() => { /* never fail the install */ }).finally(() => process.exit(0));
}
