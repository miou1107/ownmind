#!/usr/bin/env node
/**
 * OwnMind Git Post-Commit Hook (L5)
 *
 * commit 完成後檢查鐵律，違反時寫入 compliance.jsonl 並輸出警告。
 * 不會阻止 commit（已經完成了），僅記錄供後續分析。
 * 零網路依賴：所有資料從本地快取讀取。
 *
 * 安裝位置：~/.ownmind/hooks/ownmind-git-post-commit.js
 * 快取來源：~/.ownmind/cache/iron_rules.json
 * 合規記錄：~/.ownmind/logs/compliance.jsonl
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
const LOG_DIR = path.join(HOME, '.ownmind', 'logs');
const COMPLIANCE_LOG = path.join(LOG_DIR, 'compliance.jsonl');

const SOURCE_PATTERNS = [/^src\//, /^mcp\//, /^hooks\//, /^shared\//];

const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HOME, '.ownmind', 'mcp', 'package.json'), 'utf8'));
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

function getLastCommitInfo() {
  try {
    const raw = execSync('git log -1 --name-only --format=%s', { encoding: 'utf8' }).trim();
    const lines = raw.split('\n').filter(Boolean);
    const commitMessage = lines[0] || '';
    const files = lines.slice(1);
    return { commitMessage, files };
  } catch {
    return { commitMessage: '', files: [] };
  }
}

function getLastCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getChangedSourceFiles(files) {
  return files.filter(f =>
    SOURCE_PATTERNS.some(p => p.test(f))
  );
}

function readComplianceEvents() {
  try {
    const raw = fs.readFileSync(COMPLIANCE_LOG, 'utf8').trim();
    if (!raw) return [];

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
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

function appendComplianceLog(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(COMPLIANCE_LOG, JSON.stringify(entry) + '\n');
  } catch {
    // silently fail
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  // 1. Load iron rules from local cache
  const rules = readJsonSafe(CACHE_FILE);
  if (!rules || !Array.isArray(rules) || rules.length === 0) {
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

  // 3. Collect commit context
  const { commitMessage, files } = getLastCommitInfo();
  if (files.length === 0) {
    process.exit(0);
  }

  const commitHash = getLastCommitHash();
  const changedSourceFiles = getChangedSourceFiles(files);
  const complianceEvents = readComplianceEvents();

  const context = {
    stagedFiles: files,       // post-commit: committed files serve as "staged"
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
    process.exit(0);
  }

  // 5. Evaluate each rule
  const violations = [];

  for (const rule of commitRules) {
    const verification = rule.metadata?.verification;
    if (!verification?.conditions) continue;

    const result = evaluateConditions(verification.conditions, context);

    if (!result.pass) {
      const ruleCode = rule.code || rule.metadata?.code || 'IR-???';
      const ruleTitle = rule.title || '未命名規則';

      violations.push({
        ruleCode,
        ruleTitle,
        failures: result.failures,
      });

      // Write violation to compliance log
      appendComplianceLog({
        event: 'post_commit_violation',
        action: 'violate',
        rule_code: ruleCode,
        rule_title: ruleTitle,
        failures: result.failures,
        commit_hash: commitHash,
        ts: new Date().toISOString(),
      });
    }
  }

  // 6. Output warnings (don't exit 1 — commit is already done)
  if (violations.length > 0) {
    console.warn('');
    console.warn(`【OwnMind v${VERSION}】Commit 後稽核：此 commit 有以下違規`);
    for (const v of violations) {
      console.warn(`  ⚠️  ${v.ruleCode}: ${v.ruleTitle}`);
      for (const f of v.failures) {
        console.warn(`    → ${f}`);
      }
    }
    console.warn(`  commit: ${commitHash}`);
    console.warn('  已記錄至 compliance.jsonl，建議儘快修正。');
    console.warn('');
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`【OwnMind v${VERSION}】錯誤回報：post-commit 非預期錯誤: ${err.message}`);
  process.exit(0);
});
