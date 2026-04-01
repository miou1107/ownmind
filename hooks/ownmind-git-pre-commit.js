#!/usr/bin/env node
/**
 * OwnMind Git Pre-Commit Hook (L1)
 *
 * 在 commit 前自動檢查鐵律，若 block_on_fail 規則違反則阻止 commit。
 * 零網路依賴：所有資料從本地快取讀取。
 *
 * 安裝位置：~/.ownmind/hooks/ownmind-git-pre-commit.js
 * 快取來源：~/.ownmind/cache/iron_rules.json
 * 合規記錄：~/.ownmind/logs/compliance.jsonl
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
const COMPLIANCE_LOG = path.join(HOME, '.ownmind', 'logs', 'compliance.jsonl');
const COMMIT_MSG_FILE = path.join(process.cwd(), '.git', 'COMMIT_EDITMSG');

const SOURCE_PATTERNS = [/^src\//, /^mcp\//, /^hooks\//, /^shared\//];

const VERSION = (() => {
  try {
    // 統一從根目錄 package.json 讀取版號（單一來源）
    const pkg = JSON.parse(fs.readFileSync(path.join(HOME, '.ownmind', 'package.json'), 'utf8'));
    return pkg.version || '?';
  } catch { return '?'; }
})();

// ============================================================
// Helpers
// ============================================================

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getStagedFiles() {
  try {
    const raw = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    return raw ? raw.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getCommitMessage() {
  // Try COMMIT_EDITMSG first
  try {
    return fs.readFileSync(COMMIT_MSG_FILE, 'utf8').trim();
  } catch {
    // Fallback: env variable (some workflows set GIT_COMMIT_MSG)
    return process.env.GIT_COMMIT_MSG || '';
  }
}

function getChangedSourceFiles(stagedFiles) {
  return stagedFiles.filter(f =>
    SOURCE_PATTERNS.some(p => p.test(f))
  );
}

function readComplianceEvents() {
  try {
    const raw = fs.readFileSync(COMPLIANCE_LOG, 'utf8').trim();
    if (!raw) return [];

    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // last 24 hours
    const events = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const entryTime = new Date(entry.ts).getTime();
        if (entryTime >= cutoff) {
          events.push(entry);
        }
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
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

function formatPassMessage(checkedCount) {
  if (checkedCount === 0) return '';
  return `【OwnMind v${VERSION}】Commit 前檢查：${checkedCount} 條規則全部通過 ✓`;
}

// ============================================================
// Main
// ============================================================

async function main() {
  // 1. Load iron rules from local cache
  const rules = readJsonSafe(CACHE_FILE);
  if (!rules || !Array.isArray(rules) || rules.length === 0) {
    // No cache = no rules to check = pass
    process.exit(0);
  }

  // 2. Filter rules with commit trigger
  const commitRules = rules.filter(r => {
    const triggers = r.metadata?.verification?.trigger;
    return Array.isArray(triggers) && triggers.includes('commit');
  });

  if (commitRules.length === 0) {
    process.exit(0);
  }

  // 3. Collect git context
  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    // Nothing staged, nothing to check
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

  // 4. Import verification module (ESM)
  let evaluateConditions;
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const mod = await import(verificationPath);
    evaluateConditions = mod.evaluateConditions;
  } catch {
    // verification.js not found or import error = can't check = pass gracefully
    process.exit(0);
  }

  // 5. Evaluate each rule
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

  // 6. Output results
  if (blockFailures.length > 0) {
    console.error(formatBlockMessage(blockFailures));
    process.exit(1);
  }

  const passMsg = formatPassMessage(checkedCount);
  if (passMsg) {
    console.log(passMsg);
  }

  process.exit(0);
}

main().catch(err => {
  // Any unhandled error = don't block the commit
  console.error(`【OwnMind v${VERSION}】錯誤回報：pre-commit 非預期錯誤，跳過檢查: ${err.message}`);
  process.exit(0);
});
