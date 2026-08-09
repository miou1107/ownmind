#!/usr/bin/env node
/**
 * OwnMind commit-msg hook — evaluates the iron rules that judge the commit message.
 *
 * v1.26.104.
 *
 * Why this file exists
 * --------------------
 * These rules used to be evaluated in pre-commit, which reads `.git/COMMIT_EDITMSG`.
 * Git writes that file AFTER pre-commit runs, so pre-commit was reading whatever the
 * previous commit or the previous aborted attempt left behind. Measured directly with
 * two commits in a row: pre-commit saw "FIRST MESSAGE" while commit-msg saw "SECOND
 * MESSAGE".
 *
 * Both directions were wrong. Fix a violation and the retry is blocked again, quoting
 * text the message no longer contains — which is how this was found. Worse, the mirror
 * case passes: a clean first attempt leaves a clean file behind, so a violation
 * introduced on the second attempt is waved through.
 *
 * commit-msg is handed the path of the real message as its first argument, so it is the
 * only hook that can answer the question at all.
 *
 * Scope: message conditions only. Everything else about a commit — staged filenames,
 * secret content, compliance events — stays in pre-commit, which is the earlier and
 * cheaper place to refuse.
 *
 * Fails open on every unexpected condition. A hook that cannot read its rules must not
 * be the reason somebody cannot commit.
 */
// Only Node built-ins are imported statically. Everything from this project is loaded with
// `await import()` inside main(), so a half-mirrored client (a missing shared/ or hooks/lib,
// which is a real shape — see the ERR_MODULE_NOT_FOUND that bit v1.26.85) fails open rather
// than aborting the commit with a stack trace. A static import cannot be caught: the module
// never begins executing, so the process dies at exit 1 and the wrapper reads that as a
// rule violation.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
const HOOK_DIR = path.dirname(new URL(import.meta.url).pathname);

/**
 * Does this rule judge the commit message?
 *
 * Decided by the condition type, not by a rule code: every user numbers their rules
 * differently, and a check keyed to one person's numbering silently does nothing for
 * everybody else.
 */
export function isMessageRule(rule) {
  const type = rule?.metadata?.verification?.conditions?.type;
  return typeof type === 'string' && type.startsWith('commit_message');
}

/**
 * The text the user actually wrote, out of the file git hands to commit-msg.
 *
 * Two things in that file are not the message:
 *
 * 1. **Everything from the scissors line down.** `git commit --verbose` puts the staged
 *    diff there, uncommented. Measured: a diff adding a line containing the forbidden
 *    trailer arrives as `+Co-Authored-By: …`, which is not a comment line and which a
 *    substring rule matches — a commit blocked over text the message does not contain,
 *    which is the exact complaint this release exists to fix.
 * 2. **Git's own template comments**, on the editor path.
 *
 * `core.commentChar` is configurable, so it is passed in rather than assumed to be `#`.
 *
 * When stripping comments would leave nothing, the un-stripped text is used instead:
 * `git commit -m '#123 fix'` keeps that line in the real commit (cleanup is `whitespace`
 * for -m), so treating it as a comment would silently disable every message rule for
 * anyone who writes issue numbers that way.
 */
export function extractCommitMessage(raw, commentChar = '#') {
  if (typeof raw !== 'string') return '';
  const c = commentChar && commentChar.length === 1 ? commentChar : '#';
  const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scissors = new RegExp(`^${escaped} -+ >8 -+$`);

  const lines = [];
  for (const line of raw.split('\n')) {
    if (scissors.test(line)) break;
    lines.push(line);
  }
  const withoutScissors = lines.join('\n');
  const withoutComments = lines.filter((line) => !line.startsWith(c)).join('\n');

  return withoutComments.trim() || withoutScissors.trim();
}

/** `core.commentChar`, or '#'. Never throws — a missing git is not this hook's problem. */
function readCommentChar() {
  try {
    const out = execFileSync('git', ['config', '--get', 'core.commentChar'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length === 1 ? out : '#';
  } catch {
    return '#';
  }
}

function formatBlockMessage(version, failures, fingerprint) {
  const lines = ['', `[OwnMind v${version}]Commit message check: commit blocked`];
  for (const f of failures) lines.push(`  ❌ ${f}`);
  lines.push('Fix the commit message and commit again.');
  lines.push(
    '[OwnMind bug report] Think this block is wrong? Call ownmind_report_bug to file a report. '
    + `bug_fingerprint: ${fingerprint}, suggest_report: true`
  );
  lines.push('');
  return lines.join('\n');
}

async function main() {
  // The message file path, as git supplies it. No path, nothing to judge.
  const msgPath = process.argv[2];
  if (!msgPath) process.exit(0);

  let raw;
  try {
    raw = fs.readFileSync(msgPath, 'utf8');
  } catch {
    process.exit(0);
  }

  const commitMessage = extractCommitMessage(raw, readCommentChar());
  if (!commitMessage) process.exit(0);

  // Everything below comes from this project, so it is imported here where a failure can
  // be caught. See the note on the static imports at the top.
  let readJsonSafe; let getClientVersion; let parseBypass; let isBypassed; let logBypass;
  let selectBlockFingerprint; let isSessionOff; let evaluateConditions;
  try {
    const helpers = await import(path.join(HOOK_DIR, '..', 'shared', 'helpers.js'));
    const bypass = await import(path.join(HOOK_DIR, 'lib', 'bypass-handler.js'));
    const fingerprint = await import(path.join(HOOK_DIR, 'lib', 'select-block-fingerprint.js'));
    const sessionOff = await import(path.join(HOOK_DIR, '..', 'shared', 'session-off-state.js'));
    ({ readJsonSafe, getClientVersion } = helpers);
    ({ parseBypass, isBypassed, logBypass } = bypass);
    ({ selectBlockFingerprint } = fingerprint);
    ({ isOff: isSessionOff } = sessionOff);
  } catch {
    // Nothing printed: a commit is not the moment to explain an installation problem, and
    // the installer's own self-check reports it.
    process.exit(0);
  }

  const VERSION = getClientVersion();

  try {
    if (isSessionOff()) process.exit(0);
  } catch { /* state file unreadable — run normally */ }

  // Read-only on the cache. On the `git commit` path pre-commit refreshed it moments ago,
  // so a second network round trip would buy nothing and would stall the commit. On paths
  // that run commit-msg without pre-commit — merge, revert, cherry-pick — the cache may be
  // older, which errs towards enforcing a stale rule rather than towards not enforcing.
  const rules = readJsonSafe(CACHE_FILE);
  if (!Array.isArray(rules) || rules.length === 0) process.exit(0);

  const messageRules = rules.filter((r) => {
    const triggers = r.metadata?.verification?.trigger;
    return Array.isArray(triggers) && triggers.includes('commit') && isMessageRule(r);
  });
  if (messageRules.length === 0) process.exit(0);

  try {
    const mod = await import(path.join(HOME, '.ownmind', 'shared', 'verification.js'));
    evaluateConditions = mod.evaluateConditions;
  } catch {
    console.warn(`[OwnMind v${VERSION}]⚠️ Validator engine unavailable — skipping commit message check`);
    process.exit(0);
  }

  const bypassSet = parseBypass(process.env);
  const blockFailures = [];
  const blockReasons = [];

  for (const rule of messageRules) {
    const verification = rule.metadata.verification;
    const ruleCode = rule.code || rule.metadata?.code || 'IR-???';
    const ruleTitle = rule.title || 'Unnamed rule';

    if (isBypassed(ruleCode, bypassSet)) {
      try {
        logBypass({ ruleCode, ruleTitle, source: 'commit_msg' });
      } catch { /* ignore audit error */ }
      continue;
    }

    const result = evaluateConditions(verification.conditions, { commitMessage });
    const failures = Array.isArray(result.failures) ? result.failures : [];
    const violated = !result.pass || failures.length > 0;
    if (violated && verification.block_on_fail) {
      blockFailures.push(`${ruleCode}: ${ruleTitle}`);
      for (const f of failures) blockFailures.push(`    → ${f}`);
      blockReasons.push({ ruleCode, ruleTitle, secretHit: false, isSecretRule: false });
    }
  }

  if (blockFailures.length > 0) {
    console.error(formatBlockMessage(VERSION, blockFailures, selectBlockFingerprint(blockReasons)));
    process.exit(1);
  }
  process.exit(0);
}

// Only run when git invoked us. Importing this file for its exported helpers — which the
// tests do — must not spawn the whole check.
if (process.argv[1] && process.argv[1].endsWith('ownmind-git-commit-msg.js')) {
  main().catch((err) => {
    console.error(`[OwnMind] Error report: commit-msg unexpected error — skipping check: ${err.message}`);
    process.exit(0);
  });
}
