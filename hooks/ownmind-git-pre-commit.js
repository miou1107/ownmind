#!/usr/bin/env node
/**
 * OwnMind Git Pre-Commit Hook (L1)
 *
 * 在 commit 前自動檢查鐵律，若 block_on_fail 規則違反則阻止 commit。
 * 快取為空時嘗試從 API 同步（fail-closed）。
 * 零網路依賴（有快取時）：所有資料從本地快取讀取。
 */

import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import https from 'https';
import http from 'http';
import os from 'os';
import { readJsonSafe, getChangedSourceFiles, getClientVersion, readCredentials } from '../shared/helpers.js';
import { readComplianceEvents } from '../shared/compliance.js';
import { detectSecretLike } from '../shared/secret-detect.js';
import { parseBypass, isBypassed, logBypass } from './lib/bypass-handler.js';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
const COMMIT_MSG_FILE = path.join(process.cwd(), '.git', 'COMMIT_EDITMSG');
const VERSION = getClientVersion();

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================
// Helpers
// ============================================================

function getStagedFiles() {
  try {
    const raw = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    return raw ? raw.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * v1.19.7：抓 staged diff 中各檔的「新增行」內容
 * 用於跑 detectSecretLike 偵測寫入的敏感資料
 *
 * 取 unified diff context=0（白話：不顯示前後參考行，只給真正改動的行）
 * 並過濾出開頭為 '+' 但非檔頭 '+++' 的純新增行
 *
 * v1.19.7 code-review I-3：用 execFileSync 把檔名當參數陣列傳，避免 shell 解析。
 * 如此檔名含 $、反引號、空白、反斜線都安全（之前 execSync 字串拼接只 escape 雙引號、
 * 對 backslash / dollar / backtick 的檔名會中招或誤吞 IR-002 違規）。
 *
 * 失敗一律回空（fail-open、不擋 commit）
 */
function getStagedAddedLines(file) {
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--cached', '-U0', '--', file], {
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024, // 5 MB，足以覆蓋一般 patch
    });
  } catch {
    return [];
  }
  const lines = diff.split('\n');
  const added = [];
  for (const line of lines) {
    if (!line.startsWith('+')) continue;
    if (line.startsWith('+++')) continue; // 檔頭 +++ b/file 排除
    added.push(line.slice(1));
  }
  return added;
}

/**
 * v1.19.7：對 staged 檔案逐一掃 diff 內容、命中 detectSecretLike 即列為違規
 *
 * 設計：
 * - 用 skip_keyword=true 跑 regex + length heuristic，不抓 keyword（白話：
 *   原始碼很常出現 "password"／"secret" 變數名／字串字面值，keyword 模式會誤擋）
 * - 同一檔多行命中只報第一筆（避免報太細）
 * - 文字檔 binary 都跑（diff 由 git 處理過、binary 通常無 + 行可掃）
 *
 * @returns {Array<{file, rule, reason, sample}>} 命中列表
 */
function checkStagedDiffForSecrets(stagedFiles) {
  const hits = [];
  for (const file of stagedFiles) {
    const lines = getStagedAddedLines(file);
    for (const line of lines) {
      const r = detectSecretLike(line, { skip_keyword: true });
      if (r.detected) {
        hits.push({
          file,
          rule: r.rule,
          reason: r.reason,
        });
        break; // 同檔只報一筆、保留訊息精簡
      }
    }
  }
  return hits;
}

function getCommitMessage() {
  try {
    return fs.readFileSync(COMMIT_MSG_FILE, 'utf8').trim();
  } catch {
    return process.env.GIT_COMMIT_MSG || '';
  }
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * 嘗試從 API 同步 iron rules 到本地快取
 * @returns {Array|null} — 成功回傳 rules array，失敗回傳 null
 */
async function fetchAndCacheRules() {
  const { apiKey, apiUrl } = readCredentials();
  if (!apiKey || !apiUrl) return null;

  try {
    const raw = await httpGet(`${apiUrl}/api/memory/type/iron_rule`, {
      'Authorization': `Bearer ${apiKey}`
    });
    const allRules = JSON.parse(raw);
    const verifiable = (Array.isArray(allRules) ? allRules : []).filter(r => r.metadata?.verification);

    // Write to cache
    const cacheDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(verifiable, null, 2));

    return verifiable;
  } catch {
    return null;
  }
}

function formatBlockMessage(failures) {
  const lines = ['', `【OwnMind v${VERSION}】Commit 前檢查：commit 被擋下`];
  for (const f of failures) {
    lines.push(`  ❌ ${f}`);
  }
  lines.push('請先完成上述步驟再 commit。');
  // v1.20.2 follow-up #3：附帶 bug report 路徑、AI 認為鉤子擋下不對時可送回報
  lines.push(
    '[OwnMind bug report] 認為這次擋下不對嗎？可呼叫 ownmind_report_bug 送回報。' +
    'bug_fingerprint: mem_iron_rule_blocking_commit_no_fingerprint, suggest_report: true'
  );
  lines.push('');
  return lines.join('\n');
}

function formatPassMessage(checkedCount, cacheAgeHours = 0) {
  if (checkedCount === 0) return '';
  const ageNote = cacheAgeHours > 1 ? ` (快取 ${Math.round(cacheAgeHours)} 小時前更新)` : '';
  return `【OwnMind v${VERSION}】Commit 前檢查：${checkedCount} 條規則全部通過 ✓${ageNote}`;
}

// ============================================================
// Main
// ============================================================

async function main() {
  // 1. Load iron rules from local cache (with staleness check)
  let rules = readJsonSafe(CACHE_FILE);
  let cacheStale = false;
  let cacheAgeHours = 0;

  if (rules && Array.isArray(rules) && rules.length > 0) {
    // Check staleness
    try {
      const mtime = fs.statSync(CACHE_FILE).mtimeMs;
      cacheAgeHours = (Date.now() - mtime) / (60 * 60 * 1000);
      if (Date.now() - mtime > CACHE_MAX_AGE_MS) {
        cacheStale = true;
      }
    } catch {}
  }

  // 2. If cache empty or stale, try API fetch (fail-closed for empty, best-effort for stale)
  if (!rules || !Array.isArray(rules) || rules.length === 0) {
    // Cache empty — try to fetch from API
    const fetched = await fetchAndCacheRules();
    if (!fetched || fetched.length === 0) {
      // Truly no rules available — pass
      process.exit(0);
    }
    rules = fetched;
  } else if (cacheStale) {
    // Cache stale — best-effort refresh, fall back to old cache
    const fetched = await fetchAndCacheRules();
    if (fetched && fetched.length > 0) {
      rules = fetched;
    }
    // If fetch failed, continue with old cache
  }

  // 3. Filter rules with commit trigger
  const commitRules = rules.filter(r => {
    const triggers = r.metadata?.verification?.trigger;
    return Array.isArray(triggers) && triggers.includes('commit');
  });

  if (commitRules.length === 0) {
    process.exit(0);
  }

  // 4. Collect git context
  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    process.exit(0);
  }

  const commitMessage = getCommitMessage();
  const changedSourceFiles = getChangedSourceFiles(stagedFiles);
  const complianceEvents = readComplianceEvents();

  const context = {
    stagedFiles,
    commitMessage,
    changedSourceFiles,
    complianceEvents,
  };

  // 5. Import verification module (ESM)
  let evaluateConditions;
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const mod = await import(verificationPath);
    evaluateConditions = mod.evaluateConditions;
  } catch {
    // Fail-open but not silent
    console.warn(`【OwnMind v${VERSION}】⚠️ 驗證引擎不可用，跳過 pre-commit 檢查`);
    process.exit(0);
  }

  // 6. Evaluate each rule
  // v1.19.7：整合 OWNMIND_BYPASS 環境變數 + IR-002 secret-detect 雙重檢查
  const bypassSet = parseBypass(process.env);
  const blockFailures = [];
  let checkedCount = 0;

  for (const rule of commitRules) {
    const verification = rule.metadata?.verification;
    if (!verification?.conditions) continue;

    const ruleCode = rule.code || rule.metadata?.code || 'IR-???';
    const ruleTitle = rule.title || '未命名規則';

    // v1.19.7：bypass 命中 → 跳過 + 寫 audit
    if (isBypassed(ruleCode, bypassSet)) {
      try {
        logBypass({ ruleCode, ruleTitle, source: 'pre_commit' });
      } catch { /* ignore audit error */ }
      continue;
    }

    checkedCount++;
    const result = evaluateConditions(verification.conditions, context);
    const failures = Array.isArray(result.failures) ? [...result.failures] : [];

    // v1.19.7：IR-002 額外掃 staged diff 內容，命中 detectSecretLike 即視為違反
    if (ruleCode === 'IR-002') {
      const secretHits = checkStagedDiffForSecrets(stagedFiles);
      for (const hit of secretHits) {
        failures.push(`${hit.file}: ${hit.reason}（detected_by=${hit.rule}）`);
      }
    }

    const violated = !result.pass || failures.length > 0;
    if (violated && verification.block_on_fail) {
      blockFailures.push(`${ruleCode}: ${ruleTitle}`);
      for (const f of failures) {
        blockFailures.push(`    → ${f}`);
      }
    }
  }

  // 7. Output results
  if (blockFailures.length > 0) {
    console.error(formatBlockMessage(blockFailures));
    process.exit(1);
  }

  const passMsg = formatPassMessage(checkedCount, cacheAgeHours);
  if (passMsg) {
    console.log(passMsg);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`【OwnMind v${VERSION}】錯誤回報：pre-commit 非預期錯誤，跳過檢查: ${err.message}`);
  process.exit(0);
});
