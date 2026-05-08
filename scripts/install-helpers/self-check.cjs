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

// v1.17.68 IR-007 防同類雷：v1.17.9 之前 install.ps1 沒過濾 flag-like args，
// 舊版 interactive-upgrade.ps1 把 `--update` 當 positional arg 傳進去，被當 API key
// 寫進 settings.json。Adam 從 2026-03-26 建帳號到 2026-05-08 都吃 401（token_events
// 0 筆 / install_check_logs 0 筆 / scanner 永遠 401）— 沒人發現是因為 self-check
// 只打 server 看 200/401，不檢查 key 字串本身的格式。這個 check 不打 server，
// 純看 settings.json 裡 OWNMIND_API_KEY 的字串長相，把已經中招的存量挖出來。
function checkApiKeyFormat(apiKey) {
  if (typeof apiKey !== 'string' || apiKey === '') {
    return fail('api_key_format', 'OWNMIND_API_KEY 空白',
      '重跑 bootstrap，重新填 API key');
  }
  // 已知壞值清單（歷史踩坑）
  const KNOWN_BAD = new Set(['--update', '--upgrade', '--install', '--help',
    '/help', '/?', 'true', 'false', 'undefined', 'null', '${OWNMIND_API_KEY}']);
  if (KNOWN_BAD.has(apiKey)) {
    return fail('api_key_format',
      `OWNMIND_API_KEY 是已知壞值 "${apiKey}"（v1.17.9 之前 install.ps1 沒過濾 flag-like args 的存量問題）`,
      '從 OwnMind admin UI 拿 API key 重設 settings.json，或請 admin 重發');
  }
  // flag-like：開頭 `-` 通常是 PowerShell 參數誤傳
  if (apiKey.startsWith('-')) {
    return fail('api_key_format',
      `OWNMIND_API_KEY 以 - 開頭，疑似 PowerShell 旗標誤傳`,
      '從 OwnMind admin UI 重發 API key');
  }
  // 長度太短：合法 key 至少 16 chars（UUID v4 是 36，custom prefix 也 ≥ 20）
  if (apiKey.length < 16) {
    return fail('api_key_format',
      `OWNMIND_API_KEY 長度 ${apiKey.length} 太短（合法 ≥ 16）`,
      '從 OwnMind admin UI 重發 API key');
  }
  // 不能含空白（CRLF / 空格 / tab — 設定檔複製貼上常見污染）
  if (/\s/.test(apiKey)) {
    return fail('api_key_format',
      'OWNMIND_API_KEY 含空白字元（換行 / 空格 / tab）',
      '檢查 settings.json，把 key 中間的空白移掉；或重發 key');
  }
  // 不能含非 printable ASCII（BOM / 控制字元）
  if (/[\x00-\x1F\x7F-\x9F﻿]/.test(apiKey)) {
    return fail('api_key_format',
      'OWNMIND_API_KEY 含不可見字元（BOM / 控制字元）',
      '從 OwnMind admin UI 重發 API key，避免從帶 BOM 的檔案複製');
  }
  return pass('api_key_format', `格式 OK (len=${apiKey.length})`);
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

// v1.17.67 IR-038：抓 install.ps1 寫的 register-task log，task 註冊失敗時
// 把 PS 錯誤訊息一併上傳。狀況：v1.17.66 兩個 battery param 拼錯導致整個
// register 動作 throw、task 沒註冊；舊版 detectSchedulerDetail 只回 NOT_FOUND，
// 看不到根因。現在補上「最近一次 install 跑 register-scanner-task.ps1 的輸出」。
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
    // 最多 8KB（log 通常很小，超過代表異常）
    const buf = fs.readFileSync(fullPath, { encoding: 'utf8' });
    const tail = buf.length > 8192 ? '...(truncated)...\n' + buf.slice(-8192) : buf;
    // 走 sanitizePath：PowerShell 錯誤訊息常帶絕對 path（C:\Users\<realname>\...），
    // 本機 user 名是 PII，上傳前替換成 ~ 跟其他欄位一致。
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
      // LastTaskResult 是 hex code，0 = success；轉 hex 字串方便人看
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
  // v1.17.68：先驗 key 格式（不打 server），抓 Adam 那種 settings.json 殘留 "--update"
  // 的存量問題；放在 api_credentials 之前讓 fail 訊息更具體（指向格式 vs server 拒絕）。
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

// ============================================================
// v1.17.79 — Error spool drain（IR-038 觀測管道延伸）
//
// errors/ spool dir：所有 client 端失敗都用「寫檔」回報（cmd.exe / .sh / .ps1 /
// .cjs / hook 都能參與），self-check 統一把目錄裡的所有 JSON 檔案上傳。
// 跟 install-check spool 並存：
//   - install-check spool（.upload-spool.jsonl）= self-check report 自己上傳失敗的重試
//   - errors spool（errors/<ts>-<kind>.json）= 全 client 端 fatal-path 觀測管道
// 上傳成功就刪檔；失敗就保留下次再試（同 install-check 模式）。
// 壞掉的 JSON（部分寫入）直接刪，不能永遠卡在 spool 裡。
// ============================================================
// v1.17.79 — cmd.exe 寫的 .txt 格式（key=value 一行一條）轉成 report shape
// 為什麼要這個 fallback：start.cmd 寫 JSON 要處理 escape，痛點大。讓 cmd 寫
// 簡單的 key=value 文字檔，drainErrorSpool 統一轉換。
function parseKeyValueText(raw, filename) {
  const obj = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_]+)=(.*)$/);
    if (m) obj[m[1]] = m[2];
  }
  // kind 從 content 取，沒有就從 filename 推（去掉 timestamp 前綴）
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
        // .txt: cmd.exe 寫的 key=value 格式（start.cmd 用，因為 cmd 寫 JSON 太痛）
        report = parseKeyValueText(raw, name);
      }
    } catch {
      // 壞檔（部分寫入 / 非 JSON / 非 key=value）— 直接刪掉避免永遠卡 spool
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

  // v1.17.79 — 順手 drain errors/ spool（全 client 端失敗回報）
  try {
    const errDrain = await drainErrorSpool(apiUrl, apiKey);
    if (errDrain.uploaded > 0 || errDrain.failed > 0) {
      process.stderr.write(`Error spool：上傳 ${errDrain.uploaded} 筆，失敗 ${errDrain.failed} 筆\n`);
    }
  } catch (e) {
    process.stderr.write(`Error spool drain 失敗：${sanitizePath(e?.message || String(e))}\n`);
  }
  process.stderr.write('==============================\n\n');

  // 即使有 fail check 也回 exit 0 — 不擋安裝/升級流程
  process.exit(0);
}

// 給 test 用
module.exports = {
  checkMcpFiles, checkPackageVersion, checkMcpNodeModules,
  checkServerHealth, checkApiKeyFormat, checkApiCredentials, checkGitHooks, checkScheduler,
  buildReport, summarize, sanitizePath, parseArgs,
  // v1.17.66 — Spool 機制（IR-038 觀測管道）
  uploadReport, appendSpool, retrySpool,
  // v1.17.79 — Error spool drain（廣域 client 端失敗回報）
  drainErrorSpool,
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
