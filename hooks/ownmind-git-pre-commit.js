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
import { pathToFileURL } from 'url';
import { readJsonSafe, getChangedSourceFiles, getClientVersion, readCredentials } from '../shared/helpers.js';
import { readComplianceEvents } from '../shared/compliance.js';
import { detectSecretLike } from '../shared/secret-detect.js';
import { parseBypass, isBypassed, logBypass } from './lib/bypass-handler.js';
import { selectBlockFingerprint } from './lib/select-block-fingerprint.js';
import { isSecretGuardRule } from './lib/secret-guard-rule.js';
import { parseIronRulesResponse, shouldOverwriteCache } from './lib/iron-rule-sync.js';
import { isOff as isSessionOff } from '../shared/session-off-state.js';
// One definition of "this rule judges the message", shared with the hook that enforces
// them. Two copies of that predicate is the pair that drifts.
import { isMessageRule } from './ownmind-git-commit-msg.js';
// v1.26.108 — `await import()` takes a module specifier, and an absolute filesystem path is
// only accidentally one. On Windows it starts with a drive letter, which the ESM loader reads
// as a URL scheme and rejects: ERR_UNSUPPORTED_ESM_URL_SCHEME. On macOS and Linux the same
// string begins with `/` and resolves, which is why this only ever failed on Windows — and
// failed into a catch that exits 0, so the hook went quiet instead of going wrong.
const importFile = (p) => import(pathToFileURL(p).href);

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
// v1.26.104: there is deliberately no COMMIT_EDITMSG here. Git writes that file AFTER
// pre-commit runs, so reading it yields the previous commit's message, not this one's.
// Commit-message rules moved to hooks/ownmind-git-commit-msg.js, which git hands the
// real message path.
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
function getStagedAddedLines(file, srcPath = null) {
  let diff;
  try {
    // v1.26.103: for a rename, ask for BOTH paths. Scoped to the destination alone,
    // git has no deleted counterpart to pair the addition with, so rename detection
    // cannot run and it renders the file as brand new — every pre-existing line comes
    // back as an addition. Move a file and edit one line of it, and the scan reads the
    // other 400 untouched lines as newly written. -M forces the pairing even where
    // diff.renames is turned off in the user's config. Bug-report id=10.
    //
    // --literal-pathspecs, and it is load-bearing: these are paths from git, but git
    // reads them back as PATHSPECS, and `--` does not turn that off. A file committed
    // as `:!victim.txt` is a valid filename and also an exclude pattern — renaming it
    // cancels the destination out of its own diff, which returns empty, and a secret
    // added in that same commit sails through. Measured, not theorised: the hook
    // exited 0 on a freshly added `sk-proj-…` line.
    const paths = srcPath && srcPath !== file ? [srcPath, file] : [file];
    diff = execFileSync('git', ['--literal-pathspecs', 'diff', '--cached', '-U0', '-M', '--', ...paths], {
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
 * v1.26.103: where each staged path came from, when it was renamed.
 *
 * The content scan asks git for the diff of ONE path. A single-path diff has no
 * deleted counterpart to pair the addition with, so rename detection cannot run and
 * git renders a moved file as brand new — every pre-existing line comes back as an
 * addition. `git mv` a committed file holding key-shaped text (a spec's positive
 * example, a checksum table, a test fixture) and the commit is blocked over content
 * that has been in the repository for versions; the only way past is a bypass, which
 * switches off every other rule at the same time. Bug-report id=10.
 *
 * Handing the scan the source path too is what lets git pair them again.
 *
 * On any failure this returns an empty map, so every staged file is scanned as a
 * whole — the fail-safe direction for a security check.
 *
 * @returns {Map<string, string>} destination path → source path, renames only
 */
function getRenameSources() {
  const renames = new Map();
  try {
    // -M explicitly: with diff.renames=false in the user's config, git reports a move
    // as an unrelated delete plus add, the source path is lost, and the scan falls
    // straight back into the bug. The user's rename-detection preference must not
    // decide whether their commit is blocked.
    //
    // No --literal-pathspecs here, unlike the scan below: this call passes no pathspec at
    // all, so the flag would be a no-op carrying a comment that implies otherwise.
    const raw = execFileSync('git', ['diff', '--cached', '--raw', '-M', '-z'], {
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
    });
    if (!raw) return renames;
    const tokens = raw.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const meta = tokens[i];
      if (!meta || meta[0] !== ':') continue;
      // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<old>\0<new>  for R and C
      // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>        for everything else
      const status = meta.slice(1).split(' ')[4];
      if (!status) continue;
      const isPair = status[0] === 'R' || status[0] === 'C';
      if (!isPair) { i += 1; continue; }
      const srcPath = tokens[i + 1];
      const destPath = tokens[i + 2];
      i += 2;
      if (srcPath && destPath) renames.set(destPath, srcPath);
    }
  } catch {
    return new Map();
  }
  return renames;
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
  // v1.26.103: a moved file needs both of its paths, or git reads it as brand new.
  // See getRenameSources.
  const renameSources = getRenameSources();
  for (const file of stagedFiles) {
    const lines = getStagedAddedLines(file, renameSources.get(file));
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

  // 3. Filter rules with commit trigger.
  //
  // v1.26.104: message rules are excluded rather than merely left unevaluated. The
  // condition handlers return true when no message is present, so leaving them in would
  // have them counted in "all N rules passed ✓" — an assurance about a check that never
  // ran. They are enforced in hooks/ownmind-git-commit-msg.js, which git hands the real
  // message.
  const commitRules = rules.filter(r => {
    const triggers = r.metadata?.verification?.trigger;
    if (!Array.isArray(triggers) || !triggers.includes('commit')) return false;
    return !isMessageRule(r);
  });

  if (commitRules.length === 0) {
    process.exit(0);
  }

  // 4. Collect git context
  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    process.exit(0);
  }

  const changedSourceFiles = getChangedSourceFiles(stagedFiles);
  const complianceEvents = readComplianceEvents();

  // No commitMessage: this hook runs before git writes the message anywhere it could be
  // read from. Omitting the key is the point — a wrong value here is worse than none,
  // because the condition handlers cannot tell "absent" from "genuinely empty".
  const context = {
    stagedFiles,
    changedSourceFiles,
    complianceEvents,
  };

  // 5. Import verification module (ESM)
  let evaluateConditions;
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const mod = await importFile(verificationPath);
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
