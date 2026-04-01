#!/usr/bin/env node
/**
 * OwnMind Git Post-Commit Hook (L5)
 *
 * commit 完成後檢查鐵律，違反時寫入 compliance.jsonl 並輸出警告。
 * 不會阻止 commit（已經完成了），僅記錄供後續分析。
 * 零網路依賴：所有資料從本地快取讀取。
 */

import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { readJsonSafe, getChangedSourceFiles, getClientVersion } from '../shared/helpers.js';
import { appendCompliance, readComplianceEvents } from '../shared/compliance.js';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
const VERSION = getClientVersion();

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

async function main() {
  const rules = readJsonSafe(CACHE_FILE);
  if (!rules || !Array.isArray(rules) || rules.length === 0) {
    process.exit(0);
  }

  const commitRules = rules.filter(r => {
    const triggers = r.metadata?.verification?.trigger;
    return Array.isArray(triggers) && triggers.includes('commit');
  });

  if (commitRules.length === 0) {
    process.exit(0);
  }

  const { commitMessage, files } = getLastCommitInfo();
  if (files.length === 0) {
    process.exit(0);
  }

  const commitHash = getLastCommitHash();
  const changedSourceFiles = getChangedSourceFiles(files);
  const complianceEvents = readComplianceEvents();

  const context = {
    stagedFiles: files,
    commitMessage,
    changedSourceFiles,
    complianceEvents,
  };

  let evaluateConditions;
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const mod = await import(verificationPath);
    evaluateConditions = mod.evaluateConditions;
  } catch {
    console.warn(`【OwnMind v${VERSION}】⚠️ 驗證引擎不可用，跳過 post-commit 檢查`);
    process.exit(0);
  }

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

      appendCompliance({
        event: ruleCode,
        action: 'violate',
        rule_code: ruleCode,
        rule_title: ruleTitle,
        source: 'post_commit',
        commit_hash: commitHash,
        failures: result.failures,
      });
    }
  }

  // Version-tag sync check: 版號有無對應 tag
  try {
    const pkgVersion = VERSION !== '?' ? VERSION : null;
    if (pkgVersion) {
      const expectedTag = `v${pkgVersion}`;
      const tagOutput = execSync(`git tag -l ${expectedTag}`, { encoding: 'utf8' }).trim();
      if (!tagOutput) {
        console.warn('');
        console.warn(`【OwnMind v${VERSION}】版號提醒：package.json 版號為 ${pkgVersion}，但尚未建立 git tag`);
        console.warn(`  → 請執行：git tag ${expectedTag}`);
        console.warn('');
      }
    }
  } catch { /* ignore version check errors */ }


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
    console.warn(`  違規已記錄。修正方式：修正後重新提交，或 git revert ${commitHash} 還原。`);
    console.warn('');
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`【OwnMind v${VERSION}】錯誤回報：post-commit 非預期錯誤: ${err.message}`);
  process.exit(0);
});
