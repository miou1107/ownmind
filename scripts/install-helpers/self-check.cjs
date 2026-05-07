#!/usr/bin/env node
/**
 * OwnMind 安裝/升級 self-check
 *
 * 跑 7 項本機檢查、寫 log、上傳到 server。安裝/升級腳本結尾呼叫。
 *
 * 為什麼要做：Adam 這種 silent fail 案例（install.ps1 印 ✅ 但 Task Scheduler 沒真的註冊、
 * scanner 從來沒跑）伺服器端看不到、使用者也不會主動回報。Self-check 把每個元件的真實
 * 狀態抓下來，本機留 log + 上傳 server，admin 就有辦法追蹤。
 *
 * 用法：node self-check.cjs [--trigger=post_install|post_upgrade|manual]
 *
 * Opt-out 上傳：touch ~/.ownmind/.no-self-check-upload
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const HOME = os.homedir();
const OWNMIND_DIR = path.join(HOME, '.ownmind');
const LOG_DIR = path.join(OWNMIND_DIR, 'logs');
const NO_UPLOAD_FLAG = path.join(OWNMIND_DIR, '.no-self-check-upload');
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
// 7 個 check
// ============================================================

async function checkMcpFiles() {
  const p = path.join(OWNMIND_DIR, 'mcp', 'index.js');
  if (!fs.existsSync(p)) {
    return fail('mcp_files', `${sanitizePath(p)} 不存在`, '重跑 bootstrap.sh / bootstrap.ps1');
  }
  return pass('mcp_files', `${sanitizePath(p)} 存在`);
}

async function checkPackageVersion() {
  const p = path.join(OWNMIND_DIR, 'package.json');
  const pkg = readJsonSafe(p);
  if (!pkg) {
    return fail('package_version', `${sanitizePath(p)} 讀不到或非 JSON`, '重跑 bootstrap');
  }
  if (!pkg.version || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
    return fail('package_version', `version="${pkg.version}" 不像 semver`, '重跑 bootstrap');
  }
  return pass('package_version', `v${pkg.version}`);
}

async function checkMcpNodeModules() {
  const p = path.join(OWNMIND_DIR, 'mcp', 'node_modules');
  if (!fs.existsSync(p)) {
    return fail('mcp_node_modules', `${sanitizePath(p)} 不存在`,
      '在 ~/.ownmind/mcp 跑 npm install');
  }
  let count = 0;
  try { count = (await fsp.readdir(p)).length; } catch {}
  if (count === 0) {
    return fail('mcp_node_modules', '空目錄', '在 ~/.ownmind/mcp 跑 npm install');
  }
  return pass('mcp_node_modules', `${count} 個 module`);
}

async function checkServerHealth(apiUrl) {
  if (!apiUrl) return fail('server_health', '沒有 apiUrl', '重跑 bootstrap');
  const url = `${apiUrl.replace(/\/$/, '')}/health`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) return fail('server_health', `HTTP ${r.status}`, '檢查 server 是否在 line 上');
    return pass('server_health', `${url} → 200`);
  } catch (e) {
    return fail('server_health', `fetch 失敗：${sanitizePath(e?.message || String(e))}`,
      '檢查網路或 apiUrl 設定');
  }
}

async function checkApiCredentials(apiUrl, apiKey) {
  if (!apiUrl || !apiKey) {
    return fail('api_credentials', 'apiUrl 或 apiKey 空白',
      '重跑 bootstrap，重新填 API key');
  }
  const url = `${apiUrl.replace(/\/$/, '')}/api/init`;
  try {
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OwnMind-API-Key': apiKey },
      body: '{}',
    });
    if (r.status === 401 || r.status === 403) {
      return fail('api_credentials', `auth ${r.status}`, '重跑 bootstrap 重設 API key');
    }
    if (!r.ok) return warn('api_credentials', `HTTP ${r.status}`, '看 server log');
    return pass('api_credentials', `auth OK`);
  } catch (e) {
    return fail('api_credentials', sanitizePath(e?.message || String(e)),
      '檢查 server 連線');
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
      // Windows 沒有 exec bit；Mac/Linux 看 0o111
      if (PLATFORM !== 'win32' && (st.mode & 0o111) === 0) notExec.push(name);
    } catch { missing.push(name); }
  }
  if (missing.length > 0) {
    return fail('git_hooks', `缺：${missing.join(', ')}`, '重跑 install.sh / install.ps1');
  }
  if (notExec.length > 0) {
    return warn('git_hooks', `沒 exec bit：${notExec.join(', ')}`,
      `chmod +x ${notExec.map(n => path.join(dir, n)).join(' ')}`);
  }
  return pass('git_hooks', `${expected.length} 個鉤子都在`);
}

async function checkScheduler() {
  if (PLATFORM === 'darwin') {
    try {
      const { stdout } = await execFileAsync('launchctl', ['list'], { timeout: TIMEOUT_MS });
      if (stdout.includes('com.ownmind.usage-scanner')) {
        return pass('scheduler', 'launchd com.ownmind.usage-scanner 已載入');
      }
      return fail('scheduler', 'launchd 沒看到 com.ownmind.usage-scanner',
        '重跑 install.sh 或手動：launchctl load ~/Library/LaunchAgents/com.ownmind.usage-scanner.plist');
    } catch (e) {
      return fail('scheduler', `launchctl 跑失敗：${sanitizePath(e?.message)}`, '檢查 launchctl');
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
        '重跑 install.sh 或：systemctl --user enable --now ownmind-usage-scanner.timer');
    } catch (e) {
      return fail('scheduler', `systemctl 跑失敗：${sanitizePath(e?.message)}`,
        '檢查 systemd user instance');
    }
  }
  if (PLATFORM === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell.exe',
        ['-NoProfile', '-Command', "Get-ScheduledTask -TaskName 'OwnMind Usage Scanner' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty State"],
        { timeout: TIMEOUT_MS, shell: true });
      const state = stdout.trim();
      if (state === 'Ready' || state === 'Running') {
        return pass('scheduler', `Task Scheduler state=${state}`);
      }
      if (!state) {
        return fail('scheduler', 'Task Scheduler 找不到 OwnMind Usage Scanner',
          'PowerShell 跑：powershell -ExecutionPolicy Bypass -File "$HOME\\.ownmind\\scripts\\windows\\register-scanner-task.ps1"');
      }
      return warn('scheduler', `Task Scheduler state=${state}`,
        '檢查 Task Scheduler 介面或重跑 register-scanner-task.ps1');
    } catch (e) {
      return fail('scheduler', `Get-ScheduledTask 失敗：${sanitizePath(e?.message)}`,
        '需要 Windows + PowerShell');
    }
  }
  return warn('scheduler', `不支援的平台：${PLATFORM}`, null);
}

// ============================================================
// 主流程
// ============================================================

// 每個 check 都包一層 try/catch — 一個 check 拋 uncaught 不能讓整支 self-check
// 中斷（不然就是這個功能要解決的「silent fail」）。fallback 直接回 fail，
// detail 跟 fix 給 user 看 log 找原因。
async function safeCheck(name, fn) {
  try {
    return await fn();
  } catch (e) {
    return fail(name,
      `check 拋例外：${sanitizePath(e?.message || String(e))}`,
      '看 ~/.ownmind/logs/self-check-*.log 找原因');
  }
}

async function runAllChecks() {
  const { apiKey, apiUrl } = readCredentials();
  const checks = [];
  checks.push(await safeCheck('mcp_files', checkMcpFiles));
  checks.push(await safeCheck('package_version', checkPackageVersion));
  checks.push(await safeCheck('mcp_node_modules', checkMcpNodeModules));
  checks.push(await safeCheck('server_health', () => checkServerHealth(apiUrl)));
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

function buildReport({ checks, trigger, clientVersion, machine }) {
  return {
    ts: new Date().toISOString(),
    trigger,
    client_version: clientVersion,
    platform: PLATFORM,
    node_version: process.version,
    machine,
    checks,
    summary: summarize(checks),
  };
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

function printConsole(report) {
  const icons = { pass: '✅', warn: '⚠️ ', fail: '❌' };
  process.stderr.write('\n');
  process.stderr.write('===== OwnMind self-check =====\n');
  for (const c of report.checks) {
    process.stderr.write(`${icons[c.status]} ${c.name.padEnd(20)} ${c.detail}\n`);
    if (c.fix && c.status !== 'pass') {
      process.stderr.write(`     修復：${c.fix}\n`);
    }
  }
  const s = report.summary;
  process.stderr.write(`\n總結：✅ ${s.pass || 0}　⚠️  ${s.warn || 0}　❌ ${s.fail || 0}\n`);
}

async function uploadReport(report, apiUrl, apiKey) {
  if (fs.existsSync(NO_UPLOAD_FLAG)) {
    return { skipped: true, reason: 'opt_out_flag' };
  }
  if (!apiUrl || !apiKey) {
    return { skipped: true, reason: 'no_credentials' };
  }
  try {
    const r = await fetchWithTimeout(
      `${apiUrl.replace(/\/$/, '')}/api/debug/install-check`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OwnMind-API-Key': apiKey,
        },
        body: JSON.stringify(report),
      },
      TIMEOUT_MS,
    );
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: sanitizePath(e?.message || String(e)) };
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
  const report = buildReport({ checks, trigger: args.trigger, clientVersion, machine });

  const logPath = writeLog(report);
  printConsole(report);
  if (logPath) {
    process.stderr.write(`本機 log：${sanitizePath(logPath)}\n`);
  }

  const upload = await uploadReport(report, apiUrl, apiKey);
  if (upload.skipped) {
    process.stderr.write(`上傳：跳過（${upload.reason}）\n`);
  } else if (upload.ok) {
    process.stderr.write(`上傳：成功\n`);
  } else {
    process.stderr.write(`上傳：失敗（${upload.error || `HTTP ${upload.status}`}）\n`);
  }
  process.stderr.write('==============================\n\n');

  // 即使有 fail check 也回 exit 0 — 不擋安裝/升級流程
  process.exit(0);
}

// 給 test 用
module.exports = {
  checkMcpFiles, checkPackageVersion, checkMcpNodeModules,
  checkServerHealth, checkApiCredentials, checkGitHooks, checkScheduler,
  buildReport, summarize, sanitizePath, parseArgs,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[self-check] fatal: ${sanitizePath(e?.message || String(e))}\n`);
    process.exit(0); // 不擋
  });
}
