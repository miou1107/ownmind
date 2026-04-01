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
import { execSync } from 'child_process';
import https from 'https';
import http from 'http';
import os from 'os';
import { readJsonSafe, getChangedSourceFiles, getClientVersion, readCredentials } from '../shared/helpers.js';
import { readComplianceEvents } from '../shared/compliance.js';

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
  lines.push('請先完成上述步驟再 commit。', '');
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
  const blockFailures = [];
  let checkedCount = 0;

  for (const rule of commitRules) {
    const verification = rule.metadata?.verification;
    if (!verification?.conditions) continue;

    checkedCount++;
    const result = evaluateConditions(verification.conditions, context);

    if (!result.pass) {
      const ruleCode = rule.code || rule.metadata?.code || 'IR-???';
      const ruleTitle = rule.title || '未命名規則';

      if (verification.block_on_fail) {
        blockFailures.push(`${ruleCode}: ${ruleTitle}`);
        if (result.failures.length > 0) {
          for (const f of result.failures) {
            blockFailures.push(`    → ${f}`);
          }
        }
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
