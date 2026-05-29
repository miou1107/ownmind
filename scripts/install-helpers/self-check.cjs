#!/usr/bin/env node
/**
 * OwnMind install/upgrade self-check.
 *
 * Runs 7 local checks, writes a log, uploads to the server. Invoked at the end of the install /
 * upgrade scripts.
 *
 * Why this exists: silent-fail cases like Bob's (install.ps1 printed ✅, but Task Scheduler
 * never actually registered, so the scanner never ran) are invisible on the server side, and
 * users almost never report them proactively. Self-check captures each component's real state,
 * keeps the log locally, and uploads to the server so admins have a way to track these.
 *
 * Usage: node self-check.cjs [--trigger=post_install|post_upgrade|manual]
 *
 * Opt out of upload: touch ~/.ownmind/.no-self-check-upload
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
// v1.17.66 — on Windows, every spawn goes through safeSpawn (forces shell:false + windowsHide:true).
const { safeSpawn } = require('./safe-spawn.cjs');

const HOME = os.homedir();
const OWNMIND_DIR = path.join(HOME, '.ownmind');
const LOG_DIR = path.join(OWNMIND_DIR, 'logs');
const NO_UPLOAD_FLAG = path.join(OWNMIND_DIR, '.no-self-check-upload');
// v1.17.66 — when upload fails (401 / network / 5xx), park the report in this jsonl. The next
// self-check run starts by retrying it. Bob's 401 case was caused by the absence of this layer
// — the server never received anything.
const SPOOL_FILENAME = '.upload-spool.jsonl';
const PLATFORM = process.platform;
const TIMEOUT_MS = 5000;

// ============================================================
// Helpers
// ============================================================

function pass(name, detail) { return { name, status: 'pass', detail }; }
function warn(name, detail, fix) { return { name, status: 'warn', detail, fix }; }
function fail(name, detail, fix) { return { name, status: 'fail', detail, fix }; }

function sanitizePath(s) {
  if (typeof s !== 'string') return String(s ?? '');
  return s.split(HOME).join('~');
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readCredentials() {
  const settingsPath = path.join(HOME, '.claude', 'settings.json');
  const s = readJsonSafe(settingsPath);
  const env = s?.mcpServers?.ownmind?.env || {};
  return { apiKey: env.OWNMIND_API_KEY || '', apiUrl: env.OWNMIND_API_URL || '' };
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ============================================================
// The 7 checks
// ============================================================

async function checkMcpFiles() {
  const p = path.join(OWNMIND_DIR, 'mcp', 'index.js');
  if (!fs.existsSync(p)) {
    return fail('mcp_files', `${sanitizePath(p)} not found`, 'Re-run bootstrap.sh / bootstrap.ps1');
  }
  return pass('mcp_files', sanitizePath(p));
}

async function checkPackageVersion() {
  const p = path.join(OWNMIND_DIR, 'package.json');
  const pkg = readJsonSafe(p);
  if (!pkg) {
    return fail('package_version', `${sanitizePath(p)} unreadable or invalid JSON`, 'Re-run bootstrap');
  }
  if (!pkg.version || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
    return fail('package_version', `version="${pkg.version}" is not semver`, 'Re-run bootstrap');
  }
  return pass('package_version', `v${pkg.version}`);
}

async function checkMcpNodeModules() {
  const p = path.join(OWNMIND_DIR, 'mcp', 'node_modules');
  if (!fs.existsSync(p)) {
    return fail('mcp_node_modules', `${sanitizePath(p)} not found`,
      'Run: cd ~/.ownmind/mcp && npm install');
  }
  let count = 0;
  try { count = (await fsp.readdir(p)).length; } catch {}
  if (count === 0) {
    return fail('mcp_node_modules', 'directory is empty', 'Run: cd ~/.ownmind/mcp && npm install');
  }
  return pass('mcp_node_modules', `${count} modules`);
}

async function checkServerHealth(apiUrl) {
  if (!apiUrl) return fail('server_health', 'apiUrl not configured', 'Re-run bootstrap');
  const url = `${apiUrl.replace(/\/$/, '')}/health`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) return fail('server_health', `HTTP ${r.status}`, 'Check whether server is online');
    return pass('server_health', `${url} -> 200`);
  } catch (e) {
    return fail('server_health', `fetch failed: ${sanitizePath(e?.message || String(e))}`,
      'Check network or apiUrl configuration');
  }
}

// v1.17.68 IR-007 same-class-bug prevention: before v1.17.9, install.ps1 did not filter
// flag-like args, so older interactive-upgrade.ps1 passed `--update` as a positional arg —
// which got written into settings.json as the API key. Bob ate 401s from 2026-03-26 to
// 2026-05-08 (0 token_events / 0 install_check_logs / scanner always 401) and nobody
// noticed, because self-check only hit the server and looked at 200/401 rather than at
// the key string itself. This check does NOT hit the server — it just inspects the
// OWNMIND_API_KEY string in settings.json to flush out latent victims.
function checkApiKeyFormat(apiKey) {
  if (typeof apiKey !== 'string' || apiKey === '') {
    return fail('api_key_format', 'OWNMIND_API_KEY is empty',
      'Re-run bootstrap with a valid API key');
  }
  // Known bad values (legacy issues)
  const KNOWN_BAD = new Set(['--update', '--upgrade', '--install', '--help',
    '/help', '/?', 'true', 'false', 'undefined', 'null', '${OWNMIND_API_KEY}']);
  if (KNOWN_BAD.has(apiKey)) {
    return fail('api_key_format',
      `OWNMIND_API_KEY is known bad value "${apiKey}" (legacy: install.ps1 < v1.17.9 did not filter flag-like args)`,
      'Reset settings.json with a fresh API key from the OwnMind admin UI');
  }
  // flag-like: leading `-` is usually a misrouted PowerShell flag
  if (apiKey.startsWith('-')) {
    return fail('api_key_format',
      'OWNMIND_API_KEY starts with "-", likely a misrouted PowerShell flag',
      'Reissue API key from OwnMind admin UI');
  }
  // Length sanity: valid keys are >= 16 chars (UUID v4 is 36, prefixed >= 20)
  if (apiKey.length < 16) {
    return fail('api_key_format',
      `OWNMIND_API_KEY length ${apiKey.length} is too short (minimum 16)`,
      'Reissue API key from OwnMind admin UI');
  }
  // No whitespace (CRLF / space / tab from copy-paste)
  if (/\s/.test(apiKey)) {
    return fail('api_key_format',
      'OWNMIND_API_KEY contains whitespace (newline / space / tab)',
      'Remove whitespace in settings.json or reissue the key');
  }
  // No non-printable ASCII (BOM / control chars)
  if (/[\x00-\x1F\x7F-\x9F﻿]/.test(apiKey)) {
    return fail('api_key_format',
      'OWNMIND_API_KEY contains non-printable characters (BOM / control)',
      'Reissue API key (avoid copying from BOM-prefixed files)');
  }
  return pass('api_key_format', `valid (len=${apiKey.length})`);
}

async function checkApiCredentials(apiUrl, apiKey) {
  if (!apiUrl || !apiKey) {
    return fail('api_credentials', 'apiUrl or apiKey is empty',
      'Re-run bootstrap with a valid API key');
  }
  // v1.17.64: mcp/index.js and all other clients hit GET /api/memory/init + Authorization Bearer.
  // v1.17.63 wrote it as POST /api/init + X-OwnMind-API-Key header — the server has no such route
  // (404) and the auth middleware only accepts Bearer (401), so api_credentials always failed.
  const url = `${apiUrl.replace(/\/$/, '')}/api/memory/init`;
  try {
    const r = await fetchWithTimeout(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (r.status === 401 || r.status === 403) {
      return fail('api_credentials', `auth ${r.status}`, 'Re-run bootstrap to reset API key');
    }
    if (!r.ok) return warn('api_credentials', `HTTP ${r.status}`, 'Check server log');
    return pass('api_credentials', 'authenticated');
  } catch (e) {
    return fail('api_credentials', sanitizePath(e?.message || String(e)),
      'Check server connectivity');
  }
}

async function checkGitHooks() {
  const dir = path.join(OWNMIND_DIR, 'git-hooks');
  const expected = ['pre-commit', 'post-commit', 'commit-msg'];
  const missing = [];
  const notExec = [];
  for (const name of expected) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) { missing.push(name); continue; }
    try {
      const st = fs.statSync(p);
      // Windows has no exec bit; on Mac/Linux we check 0o111.
      if (PLATFORM !== 'win32' && (st.mode & 0o111) === 0) notExec.push(name);
    } catch { missing.push(name); }
  }
  if (missing.length > 0) {
    return fail('git_hooks', `missing: ${missing.join(', ')}`, 'Re-run install.sh / install.ps1');
  }
  if (notExec.length > 0) {
    return warn('git_hooks', `not executable: ${notExec.join(', ')}`,
      `chmod +x ${notExec.map(n => path.join(dir, n)).join(' ')}`);
  }
  return pass('git_hooks', `${expected.length} hooks installed`);
}

async function checkScheduler() {
  if (PLATFORM === 'darwin') {
    try {
      const { stdout } = await execFileAsync('launchctl', ['list'], { timeout: TIMEOUT_MS });
      if (stdout.includes('com.ownmind.usage-scanner')) {
        return pass('scheduler', 'launchd agent loaded');
      }
      return fail('scheduler', 'launchd agent not found',
        'Re-run install.sh or: launchctl load ~/Library/LaunchAgents/com.ownmind.usage-scanner.plist');
    } catch (e) {
      return fail('scheduler', `launchctl failed: ${sanitizePath(e?.message)}`, 'Check launchctl');
    }
  }
  if (PLATFORM === 'linux') {
    try {
      const { stdout } = await execFileAsync('systemctl',
        ['--user', 'is-active', 'ownmind-usage-scanner.timer'],
        { timeout: TIMEOUT_MS });
      const out = stdout.trim();
      if (out === 'active') return pass('scheduler', 'systemd timer active');
      return fail('scheduler', `timer state=${out}`,
        'Re-run install.sh or: systemctl --user enable --now ownmind-usage-scanner.timer');
    } catch (e) {
      return fail('scheduler', `systemctl failed: ${sanitizePath(e?.message)}`,
        'Check systemd user instance');
    }
  }
  if (PLATFORM === 'win32') {
    // v1.17.66: passing a shell flag used to wrap the command in cmd.exe, which would eat
    // the `|` and produce a false "Select-Object is not recognized" failure (hit on both
    // Alice's and Bob's machines). Now we go through safeSpawn — no shell, with windowsHide.
    const r = await safeSpawn('powershell.exe',
      ['-NoProfile', '-Command', "Get-ScheduledTask -TaskName 'OwnMind Usage Scanner' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty State"],
      { timeout: TIMEOUT_MS });
    if (!r.ok) {
      return fail('scheduler', `Get-ScheduledTask failed: ${r.error}`,
        'Requires Windows + PowerShell');
    }
    const state = r.stdout.trim();
    if (state === 'Ready' || state === 'Running') {
      return pass('scheduler', `Task Scheduler state=${state}`);
    }
    if (!state) {
      return fail('scheduler', 'Task Scheduler entry not found for "OwnMind Usage Scanner"',
        'Run: powershell -ExecutionPolicy Bypass -File "$HOME\\.ownmind\\scripts\\windows\\register-scanner-task.ps1"');
    }
    return warn('scheduler', `Task Scheduler state=${state}`,
      'Check Task Scheduler UI or re-run register-scanner-task.ps1');
  }
  return warn('scheduler', `unsupported platform: ${PLATFORM}`, null);
}

// ============================================================
// Main flow
// ============================================================

// Every check is wrapped in try/catch — one check throwing uncaught must not abort the whole
// self-check (that would be the exact "silent fail" this feature exists to solve). On error,
// we just return fail; detail + fix point the user to the log.
async function safeCheck(name, fn) {
  try {
    return await fn();
  } catch (e) {
    return fail(name,
      `check threw: ${sanitizePath(e?.message || String(e))}`,
      'See ~/.ownmind/logs/self-check-*.log for details');
  }
}

// ============================================================
// v1.17.66 — environment info collection (IR-038 observability pipeline).
//
// Send the execution environment of each self-check run to the server so the admin dashboard
// can see it directly:
//   - Which machines resolve bash to the WSL relay vs to Git Bash?
//   - Which machines default Out-File to UTF-16?
//   - What's the scheduler's real state / last_run / next_run?
// The whole payload is < 4KB, well under the 64KB cap on install_check_logs.full_log.
// ============================================================

function detectShellChain() {
  // Simplified: infer from env-var markers. Full parent/grandparent process detection on
  // Windows would need WMIC or native APIs — deferred to v1.17.67 evaluation.
  const chain = [];
  if (process.env.MSYSTEM) chain.push(`msys/git-bash:${process.env.MSYSTEM}`);
  // v1.17.66 review fix — WSL_DISTRO_NAME can include a user-chosen name (e.g. "Bob-Ubuntu");
  // switched to a boolean marker to avoid PII leakage.
  if (process.env.WSL_DISTRO_NAME) chain.push('wsl');
  // PSModulePath only exists inside a PowerShell session; cmd.exe doesn't have it.
  if (PLATFORM === 'win32' && process.env.PSModulePath) chain.push('powershell');
  chain.push(`node:${process.version}`);
  return chain;
}

async function detectBashResolution() {
  if (PLATFORM !== 'win32') return null;
  const r = await safeSpawn('where.exe', ['bash']);
  if (!r.ok) return { where_results: [], selected: 'NOT_FOUND', git_bash_path: null };
  const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let selected = 'NOT_FOUND';
  let gitBashPath = null;
  for (const line of lines) {
    if (/Windows[\\/]System32[\\/]bash\.exe$/i.test(line)) {
      if (selected === 'NOT_FOUND') selected = 'WSL_RELAY';
    } else if (/Git[\\/](?:bin|usr[\\/]bin)[\\/]bash\.exe$/i.test(line)) {
      // First Git Bash we hit wins (matches the Find-GitBash helper logic).
      if (selected !== 'GIT_BASH') {
        selected = 'GIT_BASH';
        gitBashPath = line;
      }
    } else if (selected === 'NOT_FOUND') {
      // Unrecognized bash path — note it but don't select it.
      selected = 'OTHER';
    }
  }
  return { where_results: lines, selected, git_bash_path: gitBashPath };
}

// v1.17.67 IR-038: capture the register-task log written by install.ps1 so when task
// registration fails, the PowerShell error is uploaded too. Background: v1.17.66 misnamed
// two battery params, the whole register call threw, and the task never registered. The old
// detectSchedulerDetail only returned NOT_FOUND — we couldn't see the root cause. Now we
// also attach "the most recent install run of register-scanner-task.ps1's output".
function readLatestRegisterLog() {
  try {
    const logDir = path.join(HOME, '.ownmind', 'logs');
    if (!fs.existsSync(logDir)) return null;
    const files = fs.readdirSync(logDir)
      .filter((f) => /^register-task-.+\.log$/.test(f))
      .map((f) => ({
        name: f,
        mtime: fs.statSync(path.join(logDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    const latest = files[0];
    const fullPath = path.join(logDir, latest.name);
    // Cap at 8KB (logs are normally small; anything larger suggests something is wrong).
    const buf = fs.readFileSync(fullPath, { encoding: 'utf8' });
    const tail = buf.length > 8192 ? '...(truncated)...\n' + buf.slice(-8192) : buf;
    // Run sanitizePath: PowerShell error messages often include absolute paths
    // (C:\Users\<realname>\...) — the local username is PII; replace it with ~ before
    // upload, consistent with the other fields.
    return {
      file: latest.name,
      mtime: new Date(latest.mtime).toISOString(),
      content: sanitizePath(tail),
    };
  } catch {
    return null;
  }
}

async function detectSchedulerDetail() {
  if (PLATFORM !== 'win32') return null;
  const cmd =
    "$t = Get-ScheduledTask -TaskName 'OwnMind Usage Scanner' -ErrorAction SilentlyContinue; " +
    "if (-not $t) { 'NOT_FOUND' | Out-String; exit 0 } " +
    "$i = $t | Get-ScheduledTaskInfo; " +
    "[pscustomobject]@{ State=[string]$t.State; LastRunTime=[string]$i.LastRunTime; " +
    "LastTaskResult=$i.LastTaskResult; NextRunTime=[string]$i.NextRunTime } | " +
    "ConvertTo-Json -Compress";
  const r = await safeSpawn('powershell.exe', ['-NoProfile', '-Command', cmd]);
  const registerLog = readLatestRegisterLog();
  if (!r.ok) return registerLog ? { register_log: registerLog } : null;
  const out = r.stdout.trim();
  if (out === 'NOT_FOUND') {
    return {
      task_name: 'OwnMind Usage Scanner',
      state: 'NOT_FOUND',
      register_log: registerLog,
    };
  }
  try {
    const obj = JSON.parse(out);
    return {
      task_name: 'OwnMind Usage Scanner',
      state: obj.State || null,
      last_run_time: obj.LastRunTime || null,
      // LastTaskResult is a hex code where 0 = success; render as a hex string for humans.
      last_task_result: typeof obj.LastTaskResult === 'number'
        ? `0x${obj.LastTaskResult.toString(16)}`
        : null,
      next_run_time: obj.NextRunTime || null,
      register_log: registerLog,
    };
  } catch {
    return registerLog ? { register_log: registerLog } : null;
  }
}

async function detectWindowsEncoding() {
  if (PLATFORM !== 'win32') return { lang: process.env.LANG || process.env.LC_ALL || null };
  let codepage = null;
  const c = await safeSpawn('chcp.com', []);
  if (c.ok) {
    const m = c.stdout.match(/(\d+)/);
    if (m) codepage = m[1];
  }
  // PS 5.x default Out-File = Unicode (UTF-16 LE BOM) — the root cause of Bug #6.
  // PS 6+ default Out-File = UTF-8.
  let outfile = null;
  let psVersion = null;
  const v = await safeSpawn('powershell.exe', ['-NoProfile', '-Command',
    '$PSVersionTable.PSVersion.ToString()']);
  if (v.ok) {
    psVersion = v.stdout.trim();
    outfile = psVersion.startsWith('5.') ? 'Unicode (UTF-16 LE BOM)' : 'UTF-8';
  }
  return {
    lang: process.env.LANG || process.env.LC_ALL || null,
    console_codepage: codepage,
    default_outfile_encoding: outfile,
    powershell_version: psVersion,
  };
}

async function collectEnv() {
  const isMsysHome = PLATFORM === 'win32' && /^\/[a-zA-Z]\//.test(HOME);
  const homeStyle = PLATFORM === 'win32' ? (isMsysHome ? 'msys' : 'win32') : 'posix';
  const env = {
    os_release: os.release(),
    arch: os.arch(),
    node: {
      version: process.version,
      exec_path: sanitizePath(process.execPath),
    },
    home_format: {
      // Record the format category only, never the actual path (PII-friendly).
      style: homeStyle,
      is_msys: isMsysHome,
    },
    msystem: process.env.MSYSTEM || null,
    shell_chain: detectShellChain(),
    encoding: await detectWindowsEncoding(),
  };
  // Two extra blocks only present on Windows (the launchd / systemd equivalents on other
  // platforms are already captured by checkScheduler).
  env.bash_resolution = await detectBashResolution();
  env.scheduler_detail = await detectSchedulerDetail();
  return env;
}

async function runAllChecks() {
  const { apiKey, apiUrl } = readCredentials();
  const checks = [];
  checks.push(await safeCheck('mcp_files', checkMcpFiles));
  checks.push(await safeCheck('package_version', checkPackageVersion));
  checks.push(await safeCheck('mcp_node_modules', checkMcpNodeModules));
  checks.push(await safeCheck('server_health', () => checkServerHealth(apiUrl)));
  // v1.17.68: validate the key format first (no server hit) to catch Bob-class latent
  // issues where settings.json contains the literal "--update". Putting this before
  // api_credentials makes the fail message more specific (format vs. server reject).
  checks.push(await safeCheck('api_key_format', () => checkApiKeyFormat(apiKey)));
  checks.push(await safeCheck('api_credentials', () => checkApiCredentials(apiUrl, apiKey)));
  checks.push(await safeCheck('git_hooks', checkGitHooks));
  checks.push(await safeCheck('scheduler', checkScheduler));
  return { checks, apiKey, apiUrl };
}

function summarize(checks) {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;
  return summary;
}

function buildReport({ checks, trigger, clientVersion, machine, env }) {
  const r = {
    ts: new Date().toISOString(),
    trigger,
    client_version: clientVersion,
    platform: PLATFORM,
    node_version: process.version,
    machine,
    checks,
    summary: summarize(checks),
  };
  // v1.17.66 — env is optional (unit tests don't always collect it); attach it when present.
  if (env) r.env = env;
  return r;
}

function writeLog(report) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = report.ts.replace(/[-:]/g, '').replace(/\..+$/, '');
    const p = path.join(LOG_DIR, `self-check-${ts}.log`);
    fs.writeFileSync(p, JSON.stringify(report, null, 2));
    return p;
  } catch (e) {
    return null;
  }
}

// v1.17.82 — professional English output, ASCII-only (no encoding hazards on Windows)
function printConsole(report) {
  const tag = { pass: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };
  const sep = '-'.repeat(50);
  process.stderr.write('\n');
  process.stderr.write('OwnMind self-check\n');
  process.stderr.write(sep + '\n');
  for (const c of report.checks) {
    process.stderr.write(`${tag[c.status]}  ${c.name.padEnd(20)} ${c.detail}\n`);
    if (c.fix && c.status !== 'pass') {
      process.stderr.write(`        Fix: ${c.fix}\n`);
    }
  }
  const s = report.summary;
  process.stderr.write('\n');
  process.stderr.write(`Summary:  ${s.pass || 0} passed, ${s.warn || 0} warnings, ${s.fail || 0} failed\n`);
}

// v1.17.66 — spool helpers (IR-038 observability pipeline).
//
// On upload failure we never just drop the report — we append it to
// ~/.ownmind/logs/.upload-spool.jsonl. The next self-check run calls retrySpool first to drain
// the backlog, then uploads the current report.
// Result: 401 / transient network outage / server 5xx no longer silently lose data.

function getSpoolPath(opts = {}) {
  return path.join(opts.spoolDir || LOG_DIR, SPOOL_FILENAME);
}

function appendSpool(report, opts = {}) {
  try {
    const dir = opts.spoolDir || LOG_DIR;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(getSpoolPath(opts), JSON.stringify(report) + '\n');
    return true;
  } catch {
    return false;
  }
}

async function postReport(report, apiUrl, apiKey) {
  return fetchWithTimeout(
    `${apiUrl.replace(/\/$/, '')}/api/debug/install-check`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // v1.17.64: aligned with the auth middleware (src/middleware/auth.js) — always Bearer.
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(report),
    },
    TIMEOUT_MS,
  );
}

async function retrySpool(apiUrl, apiKey, opts = {}) {
  const spoolPath = getSpoolPath(opts);
  if (!fs.existsSync(spoolPath)) return { retried: 0, failed: 0 };
  if (!apiUrl || !apiKey) return { retried: 0, failed: 0, skipped: 'no_credentials' };

  // v1.17.66 review fix — when self-checks run in parallel, use a rename pattern to avoid races:
  //   1. Atomically rename the current spool to .processing.<ts>.<pid>.
  //   2. Incoming appendSpool calls land on a freshly created spool file (no contention).
  //   3. Failures get appended back to the main spool (appendFileSync is O_APPEND atomic).
  // Multiple concurrent retrySpool runs: only the first rename succeeds; later ones skip.
  const processingPath = `${spoolPath}.processing.${Date.now()}.${process.pid}`;
  try {
    fs.renameSync(spoolPath, processingPath);
  } catch {
    // Another retrySpool may have already renamed it, or the file was GC'd.
    return { retried: 0, failed: 0, skipped: 'concurrent_retry' };
  }

  let lines;
  try {
    lines = fs.readFileSync(processingPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    try { fs.unlinkSync(processingPath); } catch {}
    return { retried: 0, failed: 0, skipped: 'read_failed' };
  }
  if (lines.length === 0) {
    try { fs.unlinkSync(processingPath); } catch {}
    return { retried: 0, failed: 0 };
  }

  // v1.17.83 (vin-windows-test round 6) — after MAX retries, drop the entry rather than
  // resending the same broken payload forever. Real case: a null-byte payload got 5xx'd by
  // the server's JSONB parser; the old retrySpool kept resending and the server log
  // accumulated continuous 500s. New version tags each entry with `_attempts`; after 5 it's
  // dropped and a warning goes to stderr.
  const MAX_SPOOL_ATTEMPTS = opts.maxAttempts || 5;
  let retried = 0;
  let dropped = 0;
  const remaining = [];
  for (const line of lines) {
    let report;
    try { report = JSON.parse(line); } catch { continue; /* broken line — drop it */ }
    try {
      const r = await postReport(report, apiUrl, apiKey);
      if (r.ok) {
        retried++;
        continue; // upload succeeded, do not write back to the spool
      }
    } catch {
      // Falls through to the attempt counter below.
    }
    // Failure (5xx / network / catch) — increment the attempt counter.
    const attempts = (Number(report._attempts) || 0) + 1;
    if (attempts >= MAX_SPOOL_ATTEMPTS) {
      dropped++;
      process.stderr.write(`[spool] drop after ${attempts} attempts: ${report.trigger || 'unknown'}\n`);
      continue;
    }
    report._attempts = attempts;
    remaining.push(JSON.stringify(report));
  }

  // Append failures back to the main spool (don't overwrite — new entries may have arrived).
  try {
    if (remaining.length > 0) {
      fs.appendFileSync(spoolPath, remaining.join('\n') + '\n');
    }
    fs.unlinkSync(processingPath);
  } catch {}

  return { retried, failed: remaining.length, dropped };
}

// ============================================================
// v1.17.79 — error spool drain (IR-038 observability extension).
//
// errors/ spool dir: every client-side failure is reported via "write a file" (cmd.exe / .sh /
// .ps1 / .cjs / hook can all participate); self-check uploads every JSON file in the directory.
// Coexists with the install-check spool:
//   - install-check spool (.upload-spool.jsonl) = self-check's own retry-on-upload-fail.
//   - errors spool (errors/<ts>-<kind>.json) = global client-side fatal-path observability.
// On successful upload, delete the file; on failure, keep it for the next attempt (same
// pattern as install-check). Broken JSON (partial writes) is deleted outright so it doesn't
// stay stuck in the spool forever.
// ============================================================
// v1.17.79 — convert cmd.exe-written .txt (key=value, one per line) into report shape.
// Why this fallback exists: start.cmd writing JSON requires escape handling — too painful.
// We let cmd write a simple key=value text file and let drainErrorSpool normalize it.
function parseKeyValueText(raw, filename) {
  const obj = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_]+)=(.*)$/);
    if (m) obj[m[1]] = m[2];
  }
  // Take `kind` from the content; if absent, infer from the filename (strip the timestamp prefix).
  let kind = obj.kind;
  if (!kind && filename) {
    const m = filename.match(/^[\d-]+-(.+?)\.txt$/);
    if (m) kind = m[1];
  }
  return {
    ts: obj.time || new Date().toISOString(),
    kind: kind || 'unknown',
    detail: obj.detail || '',
    context: obj.searched || obj.context || '',
    client_version: obj.client_version || 'unknown',
    platform: obj.platform || 'unknown',
    machine: obj.machine || null,
  };
}

async function drainErrorSpool(apiUrl, apiKey, opts = {}) {
  const errorsDir = opts.errorsDir || path.join(OWNMIND_DIR, 'logs', 'errors');
  if (!fs.existsSync(errorsDir)) return { uploaded: 0, failed: 0 };
  if (!apiUrl || !apiKey) return { uploaded: 0, failed: 0, skipped: 'no_credentials' };

  let entries;
  try {
    entries = fs.readdirSync(errorsDir).filter((f) => /\.(json|txt)$/.test(f));
  } catch {
    return { uploaded: 0, failed: 0, skipped: 'readdir_failed' };
  }
  let uploaded = 0;
  let failed = 0;
  for (const name of entries) {
    const filePath = path.join(errorsDir, name);
    let report;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (name.endsWith('.json')) {
        report = JSON.parse(raw);
      } else {
        // .txt: cmd.exe-written key=value format (used by start.cmd because writing JSON in cmd hurts).
        report = parseKeyValueText(raw, name);
      }
    } catch {
      // Broken file (partial write / not JSON / not key=value) — delete it so the spool isn't stuck forever.
      try { fs.unlinkSync(filePath); } catch {}
      continue;
    }
    const trigger = `error_${report.kind || 'unknown'}`;
    const wrapped = {
      ts: report.ts || new Date().toISOString(),
      trigger,
      client_version: report.client_version || 'unknown',
      platform: report.platform || 'unknown',
      machine: report.machine || null,
      checks: [{
        name: report.kind || 'unknown',
        status: 'fail',
        detail: report.detail || '',
        context: report.context || '',
      }],
      summary: { pass: 0, warn: 0, fail: 1 },
    };
    try {
      const r = await postReport(wrapped, apiUrl, apiKey);
      if (r.ok) {
        try { fs.unlinkSync(filePath); } catch {}
        uploaded += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { uploaded, failed };
}

async function uploadReport(report, apiUrl, apiKey, opts = {}) {
  if (fs.existsSync(NO_UPLOAD_FLAG)) {
    return { skipped: true, reason: 'opt_out_flag' };
  }
  // First try to retransmit any previously spooled reports (this is where Bob's reports
  // catch up after he replaces the bad key and re-runs).
  const retryResult = await retrySpool(apiUrl, apiKey, opts);

  if (!apiUrl || !apiKey) {
    const spooled = appendSpool(report, opts);
    return { skipped: true, reason: 'no_credentials', spooled, retried: retryResult.retried };
  }
  try {
    const r = await postReport(report, apiUrl, apiKey);
    if (r.ok) return { ok: true, status: r.status, retried: retryResult.retried };
    // 401 / 403 / 5xx → spool it, don't drop.
    const spooled = appendSpool(report, opts);
    return { ok: false, status: r.status, spooled, retried: retryResult.retried };
  } catch (e) {
    const spooled = appendSpool(report, opts);
    return { ok: false, error: sanitizePath(e?.message || String(e)), spooled, retried: retryResult.retried };
  }
}

function parseArgs(argv) {
  const args = { trigger: 'manual' };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--trigger=(.+)$/);
    if (m) args.trigger = m[1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const pkg = readJsonSafe(path.join(OWNMIND_DIR, 'package.json'));
  const clientVersion = pkg?.version || 'unknown';
  const machine = os.hostname();

  const { checks, apiKey, apiUrl } = await runAllChecks();
  // v1.17.66 — IR-038 observability pipeline: collect the current execution environment.
  const env = await collectEnv();
  const report = buildReport({ checks, trigger: args.trigger, clientVersion, machine, env });

  const logPath = writeLog(report);
  printConsole(report);
  if (logPath) {
    process.stderr.write(`Log:      ${sanitizePath(logPath)}\n`);
  }

  const upload = await uploadReport(report, apiUrl, apiKey);
  if (upload.skipped) {
    process.stderr.write(`Upload:   skipped (${upload.reason})${upload.spooled ? ', queued for retry' : ''}\n`);
  } else if (upload.ok) {
    process.stderr.write(`Upload:   succeeded\n`);
  } else {
    const reason = upload.error || `HTTP ${upload.status}`;
    process.stderr.write(`Upload:   failed (${reason})${upload.spooled ? ', queued for retry' : ''}\n`);
  }
  if (upload.retried > 0) {
    process.stderr.write(`Retried:  ${upload.retried} queued report(s)\n`);
  }

  // v1.17.79 — drain errors/ spool (broad client-side failure pipeline)
  try {
    const errDrain = await drainErrorSpool(apiUrl, apiKey);
    if (errDrain.uploaded > 0 || errDrain.failed > 0) {
      process.stderr.write(`Errors:   ${errDrain.uploaded} uploaded, ${errDrain.failed} failed\n`);
    }
  } catch (e) {
    process.stderr.write(`Errors:   drain failed (${sanitizePath(e?.message || String(e))})\n`);
  }
  process.stderr.write('-'.repeat(50) + '\n\n');

  // Even when some checks fail, return exit 0 — never block the install / upgrade flow.
  process.exit(0);
}

// Exported for tests.
module.exports = {
  checkMcpFiles, checkPackageVersion, checkMcpNodeModules,
  checkServerHealth, checkApiKeyFormat, checkApiCredentials, checkGitHooks, checkScheduler,
  buildReport, summarize, sanitizePath, parseArgs,
  // v1.17.66 — spool mechanism (IR-038 observability pipeline).
  uploadReport, appendSpool, retrySpool,
  // v1.17.79 — error spool drain (broad client-side failure pipeline).
  drainErrorSpool,
  // v1.17.66 — environment info collection (IR-038).
  collectEnv, detectShellChain, detectBashResolution,
  detectSchedulerDetail, detectWindowsEncoding,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[self-check] fatal: ${sanitizePath(e?.message || String(e))}\n`);
    process.exit(0); // do not block
  });
}
