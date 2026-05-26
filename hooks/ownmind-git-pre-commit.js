#!/usr/bin/env node
/**
 * OwnMind Git Pre-Commit Hook (L1)
 *
 * Automatically check iron rules before commit; if a block_on_fail rule is violated, abort the commit.
 * When the cache is empty, try fetching from the API (fail-closed).
 * Zero network dependency when cache exists: everything reads from local cache.
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
import { isOff as isSessionOff } from '../shared/session-off-state.js';

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
 * v1.19.7: extract the "added lines" content from the staged diff for each file.
 * Used to run detectSecretLike against the inserted content.
 *
 * Use unified diff context=0 (i.e. omit the surrounding context lines, only emit the actual changes)
 * and filter to lines starting with '+' that are not file headers ('+++').
 *
 * v1.19.7 code-review I-3: pass the filename as an argv element to execFileSync to avoid shell parsing.
 * That way filenames containing $, backticks, whitespace, or backslashes are all safe (the previous
 * execSync string concatenation only escaped double quotes — filenames with backslash / dollar /
 * backtick would either explode or silently swallow IR-002 violations).
 *
 * Any failure returns empty (fail-open, never block the commit).
 */
function getStagedAddedLines(file) {
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--cached', '-U0', '--', file], {
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024, // 5 MB — large enough for a typical patch
    });
  } catch {
    return [];
  }
  const lines = diff.split('\n');
  const added = [];
  for (const line of lines) {
    if (!line.startsWith('+')) continue;
    if (line.startsWith('+++')) continue; // exclude file header '+++ b/file'
    added.push(line.slice(1));
  }
  return added;
}

/**
 * v1.19.7: scan each staged file's diff content; a detectSecretLike hit is reported as a violation.
 *
 * Design:
 * - Run with skip_keyword=true so we use only regex + length heuristic, not keyword matching
 *   (source code frequently contains variable names / string literals like "password" or "secret",
 *    so keyword mode produces too many false positives).
 * - For a single file, only report the first hit (avoid being too noisy).
 * - Text and binary files both run (git's diff already handles binaries — they usually emit no '+' lines).
 *
 * @returns {Array<{file, rule, reason, sample}>} list of hits
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
        break; // one hit per file — keep the message concise
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
 * Try to sync iron rules from the API into the local cache.
 * @returns {Array|null} — on success returns the rules array; on failure returns null.
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
  const lines = ['', `[OwnMind v${VERSION}]Pre-commit check: commit blocked`];
  for (const f of failures) {
    lines.push(`  ❌ ${f}`);
  }
  lines.push('Complete the steps above before committing.');
  // v1.20.2 follow-up #3: include the bug-report path so AI can flag wrongly-blocked commits.
  // v1.26.1: clarify fingerprint scope — this fingerprint is ONLY for "this commit block was wrong".
  // Unrelated issues must use `clt_user_reported_other`.
  lines.push(
    '[OwnMind bug report] Think this block is wrong? Call ownmind_report_bug to file a report. ' +
    'bug_fingerprint: mem_iron_rule_blocking_commit_no_fingerprint, suggest_report: true ' +
    '(Use this fingerprint ONLY when reporting THIS commit block as wrong. ' +
    'For unrelated issues, use bug_fingerprint=clt_user_reported_other instead.)'
  );
  lines.push('');
  return lines.join('\n');
}

function formatPassMessage(checkedCount, cacheAgeHours = 0) {
  if (checkedCount === 0) return '';
  const ageNote = cacheAgeHours > 1 ? ` (cache updated ${Math.round(cacheAgeHours)}h ago)` : '';
  return `[OwnMind v${VERSION}]Pre-commit check: all ${checkedCount} rules passed ✓${ageNote}`;
}

// ============================================================
// Main
// ============================================================

async function main() {
  // v1.20.3: user invoked /ownmind-off → skip every iron rule check and let the commit through.
  // Stays in effect for 24 hours; expires or auto-resumes when a new session starts (SessionStart clears the state file).
  try {
    if (isSessionOff()) {
      console.error(`[OwnMind v${VERSION}]⚠️ OwnMind is temporarily disabled — commit hook skipped all iron rule checks. Re-enable with /ownmind-on or open a new conversation.`);
      process.exit(0);
      return;
    }
  } catch { /* state file read failure — fail-open and run normally */ }

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
    console.warn(`[OwnMind v${VERSION}]⚠️ Validator engine unavailable — skipping pre-commit check`);
    process.exit(0);
  }

  // 6. Evaluate each rule
  // v1.19.7: integrate the OWNMIND_BYPASS env var + IR-002 secret-detect double check.
  const bypassSet = parseBypass(process.env);
  const blockFailures = [];
  let checkedCount = 0;

  for (const rule of commitRules) {
    const verification = rule.metadata?.verification;
    if (!verification?.conditions) continue;

    const ruleCode = rule.code || rule.metadata?.code || 'IR-???';
    const ruleTitle = rule.title || 'Unnamed rule';

    // v1.19.7: bypass hit → skip + write audit.
    if (isBypassed(ruleCode, bypassSet)) {
      try {
        logBypass({ ruleCode, ruleTitle, source: 'pre_commit' });
      } catch { /* ignore audit error */ }
      continue;
    }

    checkedCount++;
    const result = evaluateConditions(verification.conditions, context);
    const failures = Array.isArray(result.failures) ? [...result.failures] : [];

    // v1.19.7: IR-002 additionally scans the staged diff content; a detectSecretLike hit counts as a violation.
    if (ruleCode === 'IR-002') {
      const secretHits = checkStagedDiffForSecrets(stagedFiles);
      for (const hit of secretHits) {
        failures.push(`${hit.file}: ${hit.reason} (detected_by=${hit.rule})`);
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
  console.error(`[OwnMind v${VERSION}]Error report: pre-commit unexpected error — skipping check: ${err.message}`);
  process.exit(0);
});
