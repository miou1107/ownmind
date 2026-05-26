#!/usr/bin/env node
/**
 * OwnMind Git Post-Commit Hook (L5)
 *
 * After the commit completes, check iron rules; on violation, write to compliance.jsonl and emit a warning.
 * Does not abort the commit (it already happened) — only records for later analysis.
 * Zero network dependency: everything reads from local cache.
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
    console.warn(`[OwnMind v${VERSION}]⚠️ Validator engine unavailable — skipping post-commit check`);
    process.exit(0);
  }

  const violations = [];

  for (const rule of commitRules) {
    const verification = rule.metadata?.verification;
    if (!verification?.conditions) continue;

    const result = evaluateConditions(verification.conditions, context);

    if (!result.pass) {
      const ruleCode = rule.code || rule.metadata?.code || 'IR-???';
      const ruleTitle = rule.title || 'Unnamed rule';

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
        // v1.19: read tier directly from the cached rule object (when missing, appendCompliance just omits the field).
        tier: rule.tier,
      });
    }
  }

  // Version-tag sync check: does the version have a corresponding tag?
  try {
    const pkgVersion = VERSION !== '?' ? VERSION : null;
    if (pkgVersion) {
      const expectedTag = `v${pkgVersion}`;
      const tagOutput = execSync(`git tag -l ${expectedTag}`, { encoding: 'utf8' }).trim();
      if (!tagOutput) {
        console.warn('');
        console.warn(`[OwnMind v${VERSION}]Version reminder: package.json version is ${pkgVersion}, but no matching git tag exists yet`);
        console.warn(`  → run: git tag ${expectedTag}`);
        console.warn('');
      }
    }
  } catch { /* ignore version check errors */ }


  if (violations.length > 0) {
    console.warn('');
    console.warn(`[OwnMind v${VERSION}]Post-commit audit: this commit has the following violations`);
    for (const v of violations) {
      console.warn(`  ⚠️  ${v.ruleCode}: ${v.ruleTitle}`);
      for (const f of v.failures) {
        console.warn(`    → ${f}`);
      }
    }
    console.warn(`  commit: ${commitHash}`);
    console.warn(`  Violations logged. To fix: amend or re-commit after fixing, or git revert ${commitHash} to undo.`);
    console.warn('');
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`[OwnMind v${VERSION}]Error report: post-commit unexpected error: ${err.message}`);
  process.exit(0);
});
