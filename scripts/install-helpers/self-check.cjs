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
// v1.17.66 — Windows 上 spawn 統一走 safeSpawn 強制 shell:false + windowsHide:true
const { safeSpawn } = require('./safe-spawn.cjs');

const HOME = os.homedir();
const OWNMIND_DIR = path.join(HOME, '.ownmind');
const LOG_DIR = path.join(OWNMIND_DIR, 'logs');
const NO_UPLOAD_FLAG = path.join(OWNMIND_DIR, '.no-self-check-upload');
// v1.17.66 — 上傳失敗（401 / 網路 / 5xx）時把 report 暫存到這個 jsonl，
// 下次跑 self-check 開頭先試補傳。Adam 401 案例就是缺這層導致 server 永遠收不到。
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
  // v1.17.64：mcp/index.js 跟其他 client 都打 GET /api/memory/init + Authorization Bearer。
  // v1.17.63 寫成 POST /api/init + X-OwnMind-API-Key header，server 沒這條路由 (404) 且
  // auth middleware 只認 Bearer (401)，造成 api_credentials 永遠 fail。
  const url = `${apiUrl.replace(/\/$/, '')}/api/memory/init`;
  try {
    const r = await fetchWithTimeout(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
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
    // v1.17.66：以前帶 shell 旗標會被 cmd.exe 包，| 被 cmd 吃掉造成
    // 「'Select-Object' is not recognized」假性失敗（Eric/Adam 兩台都中）。
    // 現在走 safeSpawn 強制不過 shell + windowsHide。
    const r = await safeSpawn('powershell.exe',
      ['-NoProfile', '-Command', "Get-ScheduledTask -TaskName 'OwnMind Usage Scanner' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty State"],
      { timeout: TIMEOUT_MS });
    if (!r.ok) {
      return fail('scheduler', `Get-ScheduledTask 失敗：${r.error}`,
        '需要 Windows + PowerShell');
    }
    const state = r.stdout.trim();
    if (state === 'Ready' || state === 'Running') {
      return pass('scheduler', `Task Scheduler state=${state}`);
    }
    if (!state) {
      return fail('scheduler', 'Task Scheduler 找不到 OwnMind Usage Scanner',
        'PowerShell 跑：powershell -ExecutionPolicy Bypass -File "$HOME\\.ownmind\\scripts\\windows\\register-scanner-task.ps1"');
    }
    return warn('scheduler', `Task Scheduler state=${state}`,
      '檢查 Task Scheduler 介面或重跑 register-scanner-task.ps1');
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

// ============================================================
// v1.17.66 — 環境資訊收集（IR-038 觀測管道）
//
// 把每次 self-check 跑時的執行環境一起傳到 server，方便 admin dashboard 直接看：
//   - 哪台機器 bash 解到 WSL relay 還是 Git Bash？
//   - 哪台機器 Out-File 預設還是 UTF-16？
//   - Scanner 真實 state / last_run / next_run 是什麼？
// 全部資料 < 4KB，遠低於 server 端 install_check_logs.full_log 的 64KB 上限。
// ============================================================

function detectShellChain() {
  // 簡化版：用環境變數標記推測。完整 parent/grandparent process 偵測需要 Windows
  // WMIC 或 native API，留 v1.17.67 evaluate。
  const chain = [];
  if (process.env.MSYSTEM) chain.push(`msys/git-bash:${process.env.MSYSTEM}`);
  // v1.17.66 review fix — WSL_DISTRO_NAME 可含使用者命名（如 "Adam-Ubuntu"），
  // 改 boolean 標記避免 PII 外洩
  if (process.env.WSL_DISTRO_NAME) chain.push('wsl');
  // PSModulePath 在 PowerShell session 內才有；cmd.exe 沒有
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
      // 第一個遇到的 Git Bash 就贏（Find-GitBash helper 邏輯也是這樣）
      if (selected !== 'GIT_BASH') {
        selected = 'GIT_BASH';
        gitBashPath = line;
      }
    } else if (selected === 'NOT_FOUND') {
      // 不認識的 bash 路徑，標記但不選
      selected = 'OTHER';
    }
  }
  return { where_results: lines, selected, git_bash_path: gitBashPath };
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
  if (!r.ok) return null;
  const out = r.stdout.trim();
  if (out === 'NOT_FOUND') return { task_name: 'OwnMind Usage Scanner', state: 'NOT_FOUND' };
  try {
    const obj = JSON.parse(out);
    return {
      task_name: 'OwnMind Usage Scanner',
      state: obj.State || null,
      last_run_time: obj.LastRunTime || null,
      // LastTaskResult 是 hex code，0 = success；轉 hex 字串方便人看
      last_task_result: typeof obj.LastTaskResult === 'number'
        ? `0x${obj.LastTaskResult.toString(16)}`
        : null,
      next_run_time: obj.NextRunTime || null,
    };
  } catch {
    return null;
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
  // PS 5.x default Out-File = Unicode（UTF-16 LE BOM）— Bug #6 根因
  // PS 6+ default Out-File = UTF-8
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
      // 只記格式類別，不傳實際 path（PII 友善）
      style: homeStyle,
      is_msys: isMsysHome,
    },
    msystem: process.env.MSYSTEM || null,
    shell_chain: detectShellChain(),
    encoding: await detectWindowsEncoding(),
  };
  // Windows 才有的兩塊（其他平台對應 launchd / systemd 已在 checkScheduler 收）
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
  // v1.17.66 — env 是選填的（unit test 不一定每次都收集），有就帶上
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

// v1.17.66 — Spool helpers（IR-038 觀測管道）
//
// 上傳失敗時不直接丟掉 report，寫進 ~/.ownmind/logs/.upload-spool.jsonl。
// 下次跑 self-check 開頭呼叫 retrySpool 先補傳，再傳這次的 report。
// 結果：API key 401 / 網路暫斷 / server 5xx 都不再 silent 丟資料。

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
        // v1.17.64：對齊 auth middleware（src/middleware/auth.js）— 一律 Bearer。
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

  // v1.17.66 review fix — 並行 self-check 時用 rename pattern 避免 race condition：
  //   1. 把當下 spool atomically rename 到 .processing.<ts>.<pid>
  //   2. 新進來的 appendSpool 寫到新建立的 spool（互不打架）
  //   3. 處理完失敗的 append 回主 spool（appendFileSync 是 O_APPEND atomic）
  // 多個 retrySpool 並發：只有第一個 rename 成功，後面跳過。
  const processingPath = `${spoolPath}.processing.${Date.now()}.${process.pid}`;
  try {
    fs.renameSync(spoolPath, processingPath);
  } catch {
    // 可能別的 retrySpool 已 rename 過、或檔被 GC 掉
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

  let retried = 0;
  const remaining = [];
  for (const line of lines) {
    let report;
    try { report = JSON.parse(line); } catch { continue; /* 壞行丟掉 */ }
    try {
      const r = await postReport(report, apiUrl, apiKey);
      if (r.ok) {
        retried++;
      } else {
        remaining.push(line);
      }
    } catch {
      remaining.push(line);
    }
  }

  // 失敗的 append 回主 spool（不覆蓋 — 期間可能已有新 entries）
  try {
    if (remaining.length > 0) {
      fs.appendFileSync(spoolPath, remaining.join('\n') + '\n');
    }
    fs.unlinkSync(processingPath);
  } catch {}

  return { retried, failed: remaining.length };
}

async function uploadReport(report, apiUrl, apiKey, opts = {}) {
  if (fs.existsSync(NO_UPLOAD_FLAG)) {
    return { skipped: true, reason: 'opt_out_flag' };
  }
  // 開頭先試補傳之前 spool 的 report（Adam 401 後改 key 重跑時就在這裡補回）
  const retryResult = await retrySpool(apiUrl, apiKey, opts);

  if (!apiUrl || !apiKey) {
    const spooled = appendSpool(report, opts);
    return { skipped: true, reason: 'no_credentials', spooled, retried: retryResult.retried };
  }
  try {
    const r = await postReport(report, apiUrl, apiKey);
    if (r.ok) return { ok: true, status: r.status, retried: retryResult.retried };
    // 401 / 403 / 5xx → 寫 spool 不丟掉
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
  // v1.17.66 — IR-038 觀測管道：每次 self-check 都收當下執行環境
  const env = await collectEnv();
  const report = buildReport({ checks, trigger: args.trigger, clientVersion, machine, env });

  const logPath = writeLog(report);
  printConsole(report);
  if (logPath) {
    process.stderr.write(`本機 log：${sanitizePath(logPath)}\n`);
  }

  const upload = await uploadReport(report, apiUrl, apiKey);
  if (upload.skipped) {
    process.stderr.write(`上傳：跳過（${upload.reason}）${upload.spooled ? '，已暫存待重試' : ''}\n`);
  } else if (upload.ok) {
    process.stderr.write(`上傳：成功\n`);
  } else {
    const reason = upload.error || `HTTP ${upload.status}`;
    process.stderr.write(`上傳：失敗（${reason}）${upload.spooled ? '，已暫存待重試' : ''}\n`);
  }
  if (upload.retried > 0) {
    process.stderr.write(`順手補傳 spool 舊紀錄：${upload.retried} 筆\n`);
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
  // v1.17.66 — Spool 機制（IR-038 觀測管道）
  uploadReport, appendSpool, retrySpool,
  // v1.17.66 — 環境資訊收集（IR-038）
  collectEnv, detectShellChain, detectBashResolution,
  detectSchedulerDetail, detectWindowsEncoding,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[self-check] fatal: ${sanitizePath(e?.message || String(e))}\n`);
    process.exit(0); // 不擋
  });
}
