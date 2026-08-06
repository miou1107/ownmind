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
import { selectBlockFingerprint } from './lib/select-block-fingerprint.js';
import { isSecretGuardRule } from './lib/secret-guard-rule.js';
import { parseIronRulesResponse, shouldOverwriteCache } from './lib/iron-rule-sync.js';
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
  // Exclude pure deletions (status 'D'): `git rm --cached file.pem` is the
  // desired cleanup action — removing a sensitive file from the index — and
  // must not trip staged_files_exclude filename matches. For renames ('R'),
  // git emits both the old and new path; the new path is what's being added,
  // so we keep that.
  try {
    const raw = execSync('git diff --cached --name-status -z', { encoding: 'utf8' });
    if (!raw) return [];
    const out = [];
    const tokens = raw.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const status = tokens[i];
      if (!status) continue;
      const code = status[0];
      if (code === 'R' || code === 'C') {
        // R<score>\0<old>\0<new>
        i += 2;
        if (tokens[i]) out.push(tokens[i]);
      } else {
        i += 1;
        const file = tokens[i];
        if (!file) continue;
        if (code === 'D') continue; // skip deletions
        out.push(file);
      }
    }
    return out;
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
 * backtick would either explode or silently swallow secret-guard violations).
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
 * v1.26.28: mask the middle of a matched fragment before display.
 *
 * Used for regex:* hits only — those match known real-key formats (JWT /
 * PAT / AWS / OpenAI…), so the fragment very likely IS a secret. The
 * detector truncates matched_text to 80 chars, but most real keys are
 * shorter than that and would be echoed in full — into the terminal, the
 * session transcript, and potentially a cloud bug report (the block
 * message ends with a "call ownmind_report_bug" call-to-action).
 * head(8) + '…' + tail(4) keeps the line locatable via grep without
 * leaking the key. heuristic:* hits stay unmasked: they are only
 * "key-shaped" and are exactly the fragments users need to see in full
 * to diagnose a false positive (bug-report id=6).
 */
function maskSecretFragment(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= 12) return text.slice(0, 4) + '…';
  return text.slice(0, 8) + '…' + text.slice(-4);
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
 * @returns {Array<{file, rule, reason, matched_text}>} list of hits
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
          // v1.26.28: surface the matched fragment so the user can locate
          // the exact line instead of guessing — bug-report id=6 was
          // misdiagnosed precisely because the block message hid what
          // matched. regex:* hits (known real-key formats) are masked;
          // see maskSecretFragment above.
          matched_text: r.rule && r.rule.startsWith('regex:')
            ? maskSecretFragment(r.matched_text)
            : r.matched_text,
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
    // The endpoint answers with a { data: [...] } envelope. Reading it as a bare
    // array yielded zero rules on every sync, which then overwrote the cache and
    // let the next commit through unchecked and unannounced.
    const verifiable = parseIronRulesResponse(raw).filter(r => r.metadata?.verification);

    // Never replace a cache with nothing: an empty result almost always means the
    // sync went wrong, and a stale cache still enforces something while an empty
    // one enforces nothing.
    if (shouldOverwriteCache(verifiable.length)) {
      const cacheDir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(verifiable, null, 2));
    }

    return verifiable;
  } catch {
    return null;
  }
}

function formatBlockMessage(failures, blockReasons = []) {
  const lines = ['', `[OwnMind v${VERSION}]Pre-commit check: commit blocked`];
  for (const f of failures) {
    lines.push(`  ❌ ${f}`);
  }
  lines.push('Complete the steps above before committing.');
  // v1.26.8: dispatch the bug_fingerprint based on which rule actually blocked,
  // so ownmind_report_bug calls don't hit "fingerprint not registered" on prod
  // servers still on older registry versions. See hooks/lib/select-block-fingerprint.js.
  const fingerprint = selectBlockFingerprint(blockReasons);
  lines.push(
    '[OwnMind bug report] Think this block is wrong? Call ownmind_report_bug to file a report. ' +
    `bug_fingerprint: ${fingerprint}, suggest_report: true`
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
  // v1.19.7: integrate the OWNMIND_BYPASS env var + secret-guard content double check.
  const bypassSet = parseBypass(process.env);
  const blockFailures = [];
  const blockReasons = [];  // v1.26.8: parallel to blockFailures, used for fingerprint dispatch
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

    // v1.19.7: the secret-guard rule additionally scans the staged diff
    // content; a detectSecretLike hit counts as a violation.
    // v1.26.33: keyed on the rule's semantic identity (the commit_no_secrets
    // template's conditions.type), not a personal code — so the content scan
    // runs for every user's secret rule regardless of its number.
    let secretHit = false;
    const secretGuard = isSecretGuardRule(verification);
    if (secretGuard) {
      const secretHits = checkStagedDiffForSecrets(stagedFiles);
      for (const hit of secretHits) {
        const matched = hit.matched_text ? ` matched="${hit.matched_text}"` : '';
        failures.push(`${hit.file}: ${hit.reason} (detected_by=${hit.rule})${matched}`);
        secretHit = true;
      }
    }

    const violated = !result.pass || failures.length > 0;
    if (violated && verification.block_on_fail) {
      blockFailures.push(`${ruleCode}: ${ruleTitle}`);
      for (const f of failures) {
        blockFailures.push(`    → ${f}`);
      }
      blockReasons.push({ ruleCode, ruleTitle, secretHit, isSecretRule: secretGuard });
    }
  }

  // 7. Output results
  if (blockFailures.length > 0) {
    console.error(formatBlockMessage(blockFailures, blockReasons));
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
