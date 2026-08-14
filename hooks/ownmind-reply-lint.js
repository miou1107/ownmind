#!/usr/bin/env node
/**
 * OwnMind Reply Lint — Claude Code Stop Hook (v1.17.96)
 *
 * Purpose (extends v1.17.95 + the "reminders don't work, only logic does" principle):
 *   v1.17.95 extracted the mixed-Chinese-English and jargon-without-plain-Chinese-explanation
 *   detection logic into shared/language-lint.js as a pure
 *   function lib, but never wired it into any gating point — the AI still relied on
 *   self-discipline, so the logic-over-reminders principle never actually landed.
 *
 *   v1.17.96 plugs into the Claude Code Stop hook (fires at the end of every AI turn),
 *   reads the transcript, extracts the last assistant text, runs lintReply, and on
 *   violations:
 *     1. Queues a user-facing notice, emitted as `{"systemMessage": ...}` JSON on stdout
 *     2. Writes a compliance event to ~/.ownmind/logs/YYYY-MM-DD.jsonl (picked up by MCP buffer)
 *        + best-effort POST /api/activity/batch (spool is the fallback, POST is the fast path)
 *
 * Output-channel specs (v1.26.171, replacing the /dev/tty design):
 *   1. User-facing text travels ONLY via systemMessage JSON on stdout at exit 0 — the one
 *      channel Claude Code documents as rendering to the human. /dev/tty is never opened:
 *      a hook subprocess has no controlling terminal on any platform, so that write failed
 *      on every turn it was ever attempted.
 *   2. stdout carries either that single JSON object or nothing at all.
 *   3. ~/.ownmind/logs/banner-pending.jsonl is the audit record of everything queued.
 *
 * Stop hook stdin schema (Claude Code official):
 *   {
 *     session_id: string,
 *     transcript_path: string,    // ~/.claude/projects/<proj>/<session>.jsonl
 *     hook_event_name: 'Stop',
 *     stop_hook_active: boolean   // true means this Stop was triggered by a previous hook block
 *                                 // → must exit immediately to avoid infinite loop
 *   }
 *
 * Transcript JSONL format (one message per line):
 *   { type: 'assistant', message: { content: [{type: 'text', text: '...'}, ...] }, ... }
 *
 * Activity log schema (aligned with src/routes/activity.js batch handler and mcp/ownmind-log.js logEvent):
 *   { ts: ISO8601, event: 'iron_rule_compliance', tool: 'claude-code',
 *     source: 'reply-lint-hook',
 *     details: { action: 'violate', rule_code, rule_title, ... } }
 *
 * Always exit 0 (never block the AI flow).
 *
 * Environment variables (test / opt-out):
 *   OWNMIND_REPLY_LINT_NO_NETWORK=1  Disable POST /api/activity/batch (test)
 *   OWNMIND_REPLY_LINT_DISABLE=1     Skip lint entirely (user opt-out)
 *   OWNMIND_REPLY_LINT_API_URL       Override API URL (test with a fake server)
 */

// ============================================================
// logic-over-reminders spec #3 (absolute): never write stderr / stdout.
// Register process-wide handlers covering every sync / async exception,
// including import-time failures, unhandled rejections, uncaughtException.
// These MUST be installed before any other logic.
// ============================================================
process.on('uncaughtException', () => { try { process.exit(0); } catch { /* ignore */ } });
process.on('unhandledRejection', () => { try { process.exit(0); } catch { /* ignore */ } });

// Only import Node built-ins (these are guaranteed not to fail at module load time).
// shared/* modules are loaded via dynamic import wrapped in try/catch (v1.17.96 review A2).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

// v1.26.124: assigned from shared/local-date.js inside main()'s guarded dynamic import.
// Module-level so spoolEvents can reach it; spoolEvents only ever runs after that import
// has succeeded, because main() exits on failure before any event is spooled.
let localDateOnly = null;

// v1.26.173: assigned from shared/update-banner.js in that same import. Module-level because
// exitWith is where the drain has to happen — the queue may only be cleared once the notice
// has actually gone out on stdout.
let clearDeliveredUpdateNotices = null;
let deliveredUpdateNoticeCount = 0;

const NO_NETWORK = process.env.OWNMIND_REPLY_LINT_NO_NETWORK === '1';
const DISABLED = process.env.OWNMIND_REPLY_LINT_DISABLE === '1';
const API_URL_OVERRIDE = process.env.OWNMIND_REPLY_LINT_API_URL || '';

// v1.19.3: MODE env, gradual block
// v1.19.4: default flipped from warn to block (logic-over-reminders says logic-only — opt-in equals "not deployed")
// v1.19.7: block path switched to exit 2 + stderr reason (replacing stdout JSON); also added
//          downgrade to warning after BLOCK_DOWNGRADE_LIMIT consecutive blocks (avoid an AI loop
//          and give the user a chance to step in manually)
// - block (default): violations accumulate; once count reaches BLOCK_THRESHOLD (4) → exit 2 + stderr
//                    triggers Claude rewrite. First 3 violations only warn (gradual buffer, avoids one
//                    misfire destroying a conversation). After 3 consecutive blocks → downgrade to
//                    warning exit 1 (loop protection).
// - warn: violations write a banner but never block (opt-out for users who find it noisy).
// - disable: skip entirely (same as OWNMIND_REPLY_LINT_DISABLE=1).
// - unknown value (fail-open): treat as warn + add a banner notice.
const RAW_MODE = (process.env.OWNMIND_REPLY_LINT_MODE || 'block').toLowerCase();
const VALID_MODES = new Set(['warn', 'block', 'disable']);
const MODE = VALID_MODES.has(RAW_MODE) ? RAW_MODE : 'warn';
const MODE_INVALID = !VALID_MODES.has(RAW_MODE);
const BLOCK_THRESHOLD = 4;  // 4th violation triggers block (first 3 only warn)
const BLOCK_DOWNGRADE_LIMIT = 3;  // v1.19.7: after this many consecutive blocks, downgrade next violation to warning
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PENDING_FILE = path.join(HOME, '.ownmind', 'logs', 'banner-pending.jsonl');
const PENDING_FILE_MAX_BYTES = 1024 * 1024;

// v1.17.97 — only spool to this file when POST fails or NO_NETWORK; SessionStart resends.
// Kept separate from the archive YYYY-MM-DD.jsonl: archive is for debugging, pending is the retry queue.
const COMPLIANCE_PENDING_FILE = path.join(HOME, '.ownmind', 'logs', 'reply-lint-pending.jsonl');

// Safety: when the transcript file is large, only read the tail (avoid slowing the hook on huge sessions).
// A single JSON line is usually < 50KB; 256KB covers the last 5+ messages.
const MAX_TRANSCRIPT_TAIL_BYTES = 256 * 1024;

// POST timeout — Stop hook must not block too long (user is waiting for the next prompt).
const POST_TIMEOUT_MS = 1500;

main().catch(() => { try { process.exit(0); } catch { /* ignore */ } });

/**
 * Looks up a lint/compliance notice through t(), same fail-open contract as the gate's
 * gateNotice() helper (hooks/lib/action-gate-cli.js). A dynamic import here — not a static one
 * at module scope — means a broken hooks/lib/i18n.js only ever degrades one notice's text to
 * its English fallback. Spec #3 above forbids anything besides Node built-ins as a static
 * import for exactly this reason: a broken shared/lib module must not crash this file before
 * its own process-wide error handlers (installed at the very top) are what catch it.
 */
async function lintNotice(key, fallback, params = {}) {
  try {
    const { t } = await import('./lib/i18n.js');
    return t(key, params);
  } catch {
    return fallback;
  }
}

/** The origin of the repo this session is in. Absent outside a repo, which is normal. */
function readRepoRemote() {
  try {
    return execSync('git remote get-url origin', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run the compliance step once for this turn.
 *
 * Kept out of main() so the decision it carries out lives in a module with its own tests. The
 * first draft of this step was pasted inline and referenced a constant this file does not
 * have; the ReferenceError went into a bare catch, and the whole check would have been dead
 * on arrival with the suite green.
 */
async function runComplianceOnce(payload, transcript) {
  // Every dependency resolved here, including readCredentials.
  //
  // The hook loads its shared helpers into function-scoped `let`s inside main() (line 176),
  // so nothing from '../shared/helpers.js' is in scope out here. The first version of this
  // helper called `readCredentials()` on the assumption that it was, and the ReferenceError
  // went into the caller's catch: the check ran on no turn at all, silently, exactly the
  // failure this whole feature exists to remove. The behavioural test caught it; no unit test
  // could have.
  const [
    { runComplianceStep, readComplianceBlockCount, incrementComplianceBlockCount },
    { requestCheck },
    { readEnforcementBundle },
    { readCredentials },
    { decideNotice },
  ] = await Promise.all([
    import('./lib/compliance-step.js'),
    import('./lib/compliance-client.js'),
    import('./lib/enforcement-cache.js'),
    import('../shared/helpers.js'),
    import('./lib/notice-throttle.js'),
  ]);

  const sessionId = (typeof payload.session_id === 'string' && payload.session_id) || 'unknown';
  const step = await runComplianceStep({
    disabled: DISABLED,
    mode: MODE,
    ...readCredentials(),
    sessionId,
    assistantText: transcript.lastAssistantText,
    userPrompts: transcript.recentUserPrompts,
    repoRemote: readRepoRemote(),
    // A reply is the assistant talking, and usually reporting on work as well. Both labels
    // go in so a rule tagged either way is in scope for this turn.
    trigger: ['respond', 'report'],
    bundle: readEnforcementBundle(),
    blockCount: readComplianceBlockCount(sessionId),
    requestCheckImpl: requestCheck,
  });

  if (step.action === 'exit2') incrementComplianceBlockCount(sessionId);

  // v1.26.171 throttle (the user's call): state-shaped notices — the recurring "this turn
  // was NOT checked" family, identified by noticeKey — speak on every state change and
  // every 10th turn while the state persists; recovery is announced once. Event-shaped
  // notices (a pushback, the cap reached) have no key and always speak. Suppressed turns
  // still reach the audit spool via the caller.
  const speak = decideNotice(sessionId, step.noticeKey ?? null);
  if (step.noticeKey && !speak) {
    return { ...step, banner: undefined, suppressedBanner: step.banner };
  }
  if (!step.noticeKey && speak && step.action !== 'exit2' && !step.banner) {
    return {
      ...step,
      banner: await lintNotice(
        'lint.recovered',
        '[OwnMind] compliance checks are running again - this turn was checked',
      ),
    };
  }
  return step;
}

async function main() {
  // v1.19.3: MODE=disable is equivalent to the legacy DISABLED env.
  if (DISABLED || MODE === 'disable') { process.exit(0); return; }

  // dynamic import of shared/* wrapped in try: failure must not leak (review A2).
  // v1.19: all shared/* and hooks/lib/* uniformly caught → exit 0, no inline fallback (review M-2).
  // v1.19.3: added session-counter
  // v1.20.3: added session-off-state (temporary session disable toggle)
  let lintReply, readCredentials, getClientVersion, getTierFromRules, buildComplianceEvents;
  let incrementCounter, cleanupStale, incrementBlockCount, readBlockCount, resetBlockCount;
  let detectPrivacyLeak;
  let writeLintEvent, extractViolatedWords;
  let isOff, incrementTickCount;
  let readUpdateNotices;
  // v1.21.0: validator registry (rule-driven lint).
  let findValidator, extractEnabledValidators;
  try {
    // v1.26.124: loaded here rather than as a static import at the top of the file, because
    // spec #3 above allows only Node built-ins to be imported statically — a shared/* module
    // missing on a half-installed machine would otherwise kill this hook before its own
    // error handlers are installed. Assigned to the module-level binding so spoolEvents,
    // which is not in this scope, stops needing its own copy of "what day is it".
    ({ localDateOnly } = await import('../shared/local-date.js'));
    ({ lintReply } = await import('../shared/language-lint.js'));
    ({ findValidator, extractEnabledValidators } = await import('../shared/validators/index.js'));
    ({ readCredentials, getClientVersion } = await import('../shared/helpers.js'));
    ({ getTierFromRules } = await import('../shared/iron-rule-tier.js'));
    ({ buildComplianceEvents } = await import('./lib/build-compliance-events.js'));
    ({
      incrementCounter,
      cleanupStale,
      incrementBlockCount,
      readBlockCount,
      resetBlockCount,
    } = await import('./lib/session-counter.js'));
    ({ detectPrivacyLeak } = await import('../shared/privacy-detect.js'));
    ({
      writeEvent: writeLintEvent,
      extractViolatedWords,
    } = await import('./lib/lint-event-logger.js'));
    ({ isOff, incrementTickCount } = await import('../shared/session-off-state.js'));
    ({ readUpdateNotices, clearDeliveredUpdateNotices } = await import('../shared/update-banner.js'));
  } catch {
    process.exit(0); return;
  }

  let payload;
  try {
    const input = await readStdin();
    payload = safeParse(input);
  } catch { process.exit(0); return; }
  if (!payload) { process.exit(0); return; }

  // v1.26.173 — the background updater's outcome, which has no turn of its own.
  //
  // The update runs in a detached child that outlives the session that started it, so there
  // is no reply left to attach the result to. It waits in logs/update-pending.jsonl and is
  // delivered here, on the first turn that reaches exitWith(0). Queued before anything below
  // can exit early, so a failed update is not held hostage by whatever the lint decides about
  // this particular reply; the queue is only drained once the bytes are actually on stdout.
  try {
    const { blocks, lineCount } = readUpdateNotices();
    if (blocks.length) {
      for (const block of blocks) queueUserNotice(block);
      // Every line read is consumed, including ones that parsed to nothing — leaving an
      // unshowable line behind would re-read it on every turn for the life of the machine.
      deliveredUpdateNoticeCount = lineCount;
    }
  } catch { /* a queue that cannot be read must not cost the reply its lint */ }

  // === Standard enforcement ===
  //
  // Ahead of the stop_hook_active early return, deliberately. That return exists so the
  // string validators below cannot loop, but it also means a reply produced *because* the
  // assistant was pushed back is never examined - so one rejection would buy a permanently
  // unchecked turn. The loop is bounded here instead, by a counter of this path's own that
  // shares nothing with BLOCK_THRESHOLD or incrementCounter: a rule violation has to reach
  // the assistant on the first offence, not the fourth.
  //
  // Everything it needs is imported dynamically and every failure is caught: a broken or
  // half-upgraded lib file must not take the three existing validators down with it.
  let complianceTranscript = null;
  try {
    const transcriptForCompliance = sanitizeTranscriptPath(payload.transcript_path);
    if (transcriptForCompliance) {
      complianceTranscript = readTranscriptTail(transcriptForCompliance);
      if (complianceTranscript.lastAssistantText) {
        const step = await runComplianceOnce(payload, complianceTranscript);
        if (step.banner) queueUserNotice(step.banner);
        // A throttled state-notice still belongs in the audit spool - suppression is about
        // the screen, never about the record.
        else if (step.suppressedBanner) writeFallback(step.suppressedBanner);
        if (step.action === 'exit2') {
          // stderr is the model's rewrite instruction, and it also renders to the user as
          // the block reason — the queued banner stays in the spool for the audit trail.
          try { process.stderr.write(step.stderr + '\n'); } catch { /* ignore */ }
          process.exit(2);
          return;
        }
      }
    }
  } catch { /* fail open: the compliance check must never block the user's work */ }

  // stop_hook_active=true means this Stop was triggered by a previous hook block →
  // exit immediately to avoid an infinite loop (Claude Code Stop hook spec).
  // v1.19.3: also guarantees the Stop during Claude rewrite isn't counted again.
  if (payload.stop_hook_active === true) { exitWith(0); return; }

  // v1.20.3: user invoked /ownmind-off → skip lint, remind in the terminal every 10 turns.
  // When a new session starts, the SessionStart hook clears the state file automatically.
  if (typeof isOff === 'function' && isOff()) {
    try {
      const tick = incrementTickCount();
      if (tick > 0 && tick % 10 === 0) {
        const version = getClientVersion();
        const reminder = await lintNotice(
          'lint.offReminder',
          [
            `[OwnMind v${version}] ⚠️ OwnMind is currently disabled (${tick} AI responses skipped lint)`,
            '  → Re-enable with /ownmind-on, or open a new conversation to restore',
          ].join('\n'),
          { version, tick },
        );
        queueUserNotice(reminder);
      }
    } catch { /* reminder failure must not block the main flow */ }
    exitWith(0); return;
  }

  const transcriptPath = sanitizeTranscriptPath(payload.transcript_path);
  if (!transcriptPath) { exitWith(0); return; }

  // v1.19.12: single transcript read pulls both the last assistant text and recent user prompts
  // (replaces v1.19.7's two statSync + readFileSync calls, halving I/O).
  // User prompts are passed to the privacy detector as an exemption source: personal data the user
  // typed themselves and the AI quotes back shouldn't count as a leak.
  // Note: users with a matching privacy iron rule (the user's own privacy rule) receive the event code
  //       'privacy_check' and their rule decides whether to block; the hook itself is not bound
  //       to any specific user's rule number (v1.19.10 neutralization).
  // v1.20.2 follow-up #3: in addition to lastAssistantText / userPrompts, also extract historical
  // assistant corpus for jargon-explanation cross-reply vocabulary memory (the rule's text says "if already
  // explained in context, may be kept" — now actually implemented).
  // Reuses the read the compliance step already did. Reading the tail twice per turn is
  // cheap but pointless, and two reads of a file being appended to can disagree.
  const { lastAssistantText, recentUserPrompts: userPrompts, historicalAssistantCorpus } =
    complianceTranscript || readTranscriptTail(transcriptPath);
  if (!lastAssistantText) { exitWith(0); return; }

  const sessionId = (typeof payload.session_id === 'string' && payload.session_id) || 'unknown';

  // v1.21.0: rule-driven — look up enabled validators from the user's iron rule cache.
  // No user has any enabled → the hook does nothing (the user set no rules, so OwnMind stays quiet).
  let resolvedValidators = [];
  try {
    const rulesForValidator = readIronRulesCache();
    if (typeof extractEnabledValidators === 'function') {
      const enabled = extractEnabledValidators(rulesForValidator);
      resolvedValidators = enabled
        .map((entry) => {
          const v = typeof findValidator === 'function' ? findValidator(entry.validator) : null;
          if (!v || typeof v.check !== 'function') return null;
          return {
            rule: entry.rule,
            validator: entry.validator,
            params: entry.params,
            check: v.check,
          };
        })
        .filter(Boolean);
    }
  } catch { /* fail-open: validator not found → treat as not enabled */ }

  let lintResult = { ok: true, violations: [] };
  try {
    lintResult = lintReply(lastAssistantText, resolvedValidators, {
      historicalCorpus: historicalAssistantCorpus || '',
      userPrompts,
    });
  } catch { exitWith(0); return; }

  const violations = Array.isArray(lintResult.violations) ? [...lintResult.violations] : [];

  const combinedOk = violations.length === 0;
  if (combinedOk) {
    // v1.19.7: when lint passes, reset block_count so the next turn starts fresh.
    try { resetBlockCount(sessionId); } catch { /* swallow */ }
    exitWith(0); return;
  }

  // === v1.19.3: accumulate violation count and decide whether to block ===
  //
  // v1.19.7 code-review M-1 partial-failure window note:
  // The violation path writes in this order: count → block_count (when threshold reached) →
  // stderr → compliance event (spool / POST). If the hook is force-killed (e.g. SIGKILL),
  // we may land between any two steps:
  //   - count already +1 but block_count not yet +1: next hook still takes the normal block
  //     path; worst case is one extra warning, no data corruption.
  //   - block_count already +1 but the compliance event wasn't written: admin loses that block
  //     record, but the hook's blocking behavior is still correct.
  // This is acceptable observability degradation (partial stats, but the actual block logic
  // is unaffected). A Stop hook should not introduce fsync just for transactional integrity.
  let currentCount = 1;  // default 1 (fallback when incrementCounter fails)
  try { currentCount = incrementCounter(sessionId); } catch { /* swallow */ }
  // best-effort sweep of expired sessions (run once per hook trigger to bound file size).
  try { cleanupStale(SESSION_TTL_MS); } catch { /* swallow */ }

  const reachedBlockThreshold = MODE === 'block' && currentCount >= BLOCK_THRESHOLD;

  // === v1.19.7: consecutive blocks reached limit → downgrade to warning (prevent AI loop) ===
  let priorBlockCount = 0;
  try { priorBlockCount = readBlockCount(sessionId); } catch { /* swallow */ }
  const downgradeToWarning = reachedBlockThreshold && priorBlockCount >= BLOCK_DOWNGRADE_LIMIT;
  const shouldHardBlock = reachedBlockThreshold && !downgradeToWarning;

  // === Banner path (shown to the user) ===
  const banner = await formatBanner(violations, getClientVersion, {
    mode: MODE,
    modeInvalid: MODE_INVALID,
    rawMode: RAW_MODE,
    count: currentCount,
    threshold: BLOCK_THRESHOLD,
    blocked: shouldHardBlock,
    downgraded: downgradeToWarning,
    blockCount: priorBlockCount,
  });
  if (banner) queueUserNotice(banner);

  // === v1.19.7: write block reason to stderr (replacing the old stdout JSON) ===
  let exitCode = 0;
  if (shouldHardBlock) {
    try { incrementBlockCount(sessionId); } catch { /* swallow */ }
    const reason = formatBlockReason(violations, { priorBlockCount });
    try { process.stderr.write(reason + '\n'); } catch { /* ignore */ }
    // v1.20.2 follow-up #3: include the bug-report path so the AI can report when it thinks lint is wrong.
    // v1.26.1: clarify fingerprint scope — `lint_context_memory_missing` is ONLY for "this lint
    // decision was a misfire". Unrelated issues must use `clt_user_reported_other`.
    try {
      process.stderr.write(
        '[OwnMind bug report] Think this lint decision is wrong (e.g. an already-explained term was blocked)? Call ownmind_report_bug to file a report. ' +
        'bug_fingerprint: lint_context_memory_missing, suggest_report: true ' +
        '(Use this fingerprint ONLY when reporting THIS lint decision as a misfire. ' +
        'For unrelated issues, use bug_fingerprint=clt_user_reported_other instead.)\n'
      );
    } catch { /* ignore */ }
    exitCode = 2;

    // v1.19.11: write a structured block event as data foundation for the self-learning mechanism.
    try {
      writeLintEvent({
        sessionId,
        event: 'blocked',
        ruleCodes: violations.map(v => v.rule),
        violatedWords: extractViolatedWords(violations),
        violationCountInSession: currentCount,
        blockCountInSession: priorBlockCount + 1,
        downgradedToWarning: false,
        aiInstructedToAnnotate: true,
      });
    } catch { /* swallow, must not block the main flow */ }
  } else if (downgradeToWarning) {
    // v1.26.171: this path used to write formatDowngradeNotice + a bug-report pointer to
    // stderr and exit 1 — a combination that renders nowhere (exit-1 stderr goes to the
    // debug log). The user-facing downgrade text is in the banner riding systemMessage;
    // the stderr writes were dead output and are gone with the exit-1 code.
    exitCode = 0;

    // v1.19.11: the downgrade path also writes one record.
    try {
      writeLintEvent({
        sessionId,
        event: 'downgraded_to_warning',
        ruleCodes: violations.map(v => v.rule),
        violatedWords: extractViolatedWords(violations),
        violationCountInSession: currentCount,
        blockCountInSession: priorBlockCount,
        downgradedToWarning: true,
        aiInstructedToAnnotate: false,
      });
    } catch { /* swallow */ }
  }

  // === Compliance event path (cross-session stats) ===
  const cachedRules = readIronRulesCache();
  const events = buildComplianceEvents(violations, cachedRules, getTierFromRules);
  if (downgradeToWarning) {
    // v1.19.7: also tag each violation as repeated_violation_softblock so admin can track downgrade events.
    for (const ev of events) {
      if (ev?.details) ev.details.action = 'repeated_violation_softblock';
    }
  }
  spoolEvents(events);

  let postOk = false;
  if (!NO_NETWORK) {
    try {
      postOk = await postEvents(events, readCredentials);
    } catch { postOk = false; }
  }
  if (!postOk) {
    spoolPendingForRetry(events);
  }

  exitWith(exitCode);
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), 1000).unref();
  });
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); }
  catch { return null; }
}

/**
 * Sanitize transcript_path (review B1 — defensive):
 *   - must be a string
 *   - must end in .jsonl
 *   - after realpath must be a regular file (reject symlinks pointing somewhere odd)
 *   - size > 0
 *
 * Note: Claude Code controls its own stdin payload — there isn't really an attacker feeding a path,
 *       but the Stop hook is a public surface, so defensive checks here cost very little.
 */
function sanitizeTranscriptPath(p) {
  if (!p || typeof p !== 'string') return null;
  if (!p.endsWith('.jsonl')) return null;
  let real;
  try { real = fs.realpathSync(p); }
  catch { return null; }
  let stat;
  try { stat = fs.lstatSync(real); }
  catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size === 0) return null;
  return real;
}

/**
 * v1.19.12: merged transcript read — returns "last assistant text + recent N user prompts" in one pass.
 *
 * Replaces v1.19.7's readLastAssistantText + readRecentUserPrompts (two statSync + readFileSync).
 * Saves half the I/O on large transcripts.
 *
 * Safety:
 *   - On large files, only read the last 256KB (the latest turn is almost always at the tail).
 *   - Tail read may slice mid-line → discard the first line (review B4).
 *
 * User message content has two shapes:
 *   1. String: { message: { role: 'user', content: 'hi' } }
 *   2. Array:  { message: { role: 'user', content: [{ type: 'text', text: '...' }] } }
 * Both are supported.
 *
 * @param {string} transcriptPath
 * @param {object} [opts]
 * @param {number} [opts.maxUserTurns=5]
 * @returns {{ lastAssistantText: string|null, recentUserPrompts: string[] }}
 */
function readTranscriptTail(transcriptPath, opts = {}) {
  const maxUserTurns = typeof opts.maxUserTurns === 'number' ? opts.maxUserTurns : 5;
  const empty = { lastAssistantText: null, recentUserPrompts: [] };

  let buf;
  let truncatedHead = false;
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size <= MAX_TRANSCRIPT_TAIL_BYTES) {
      buf = fs.readFileSync(transcriptPath, 'utf8');
    } else {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const chunk = Buffer.alloc(MAX_TRANSCRIPT_TAIL_BYTES);
        fs.readSync(fd, chunk, 0, MAX_TRANSCRIPT_TAIL_BYTES, stat.size - MAX_TRANSCRIPT_TAIL_BYTES);
        buf = chunk.toString('utf8');
        truncatedHead = true;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return empty;
  }

  let lines = buf.split('\n').filter(Boolean);
  // When truncatedHead=true, the first line may start mid-JSON → discard it (review B4).
  if (truncatedHead && lines.length > 0) lines = lines.slice(1);

  let lastAssistantText = null;
  const recentUserPrompts = [];
  // v1.20.2 follow-up #3: extract all prior assistant text (excluding the latest turn)
  // as the historical corpus for jargon-explanation lintReply — implements "if already explained in context, may be kept".
  const historicalAssistantTexts = [];

  // Scan from the end backwards, simultaneously extracting last assistant + recent N user + all prior assistant history.
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = safeParse(lines[i]);
    if (!entry) continue;

    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        const texts = content
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text);
        if (texts.length > 0) {
          const joined = texts.join('\n');
          if (lastAssistantText === null) {
            lastAssistantText = joined;
          } else {
            historicalAssistantTexts.push(joined);
          }
        }
      }
      continue;
    }

    if (entry.type === 'user' && recentUserPrompts.length < maxUserTurns) {
      const content = entry.message?.content;
      if (typeof content === 'string') {
        if (content) recentUserPrompts.push(content);
      } else if (Array.isArray(content)) {
        const texts = content
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text);
        if (texts.length > 0) recentUserPrompts.push(texts.join('\n'));
      }
    }
  }

  // Historical corpus merged in chronological order (we scanned tail-to-head; reverse back to head-to-tail).
  const historicalAssistantCorpus = historicalAssistantTexts.reverse().join('\n\n');

  return { lastAssistantText, recentUserPrompts, historicalAssistantCorpus };
}

/**
 * Wrap lint violations into the brand banner format (matches ownmind-tty-echo.cjs visual style).
 *
 * v1.19.3: added MODE and session count display.
 * v1.19.7: added the "consecutive blocks reached limit, downgrade to warning" state.
 *
 * Example (warn mode):
 *   [OwnMind v1.19.3] Reply quality lint (warn mode, session count 1)
 *     ⚠️  lint_language_mixed_ratio: mixed Chinese-English ratio 32% > 15% — refactor, codebase, ...
 *
 * Example (block mode, 3rd warning):
 *   [OwnMind v1.19.3] Reply quality lint (block mode, session count 3, next violation will block)
 *
 * Example (block mode, 4th triggers block):
 *   [OwnMind v1.19.3] Reply quality lint ⚠️ Block triggered, Claude will receive a rewrite directive
 *
 * Example (downgraded after 3 consecutive blocks):
 *   [OwnMind v1.19.7] Reply quality lint ⚠️ 3 consecutive blocks — downgrading to warning (please review manually)
 */
async function formatBanner(violations, getClientVersion, opts = {}) {
  if (!Array.isArray(violations) || violations.length === 0) return null;
  let version;
  try { version = getClientVersion(); } catch { version = '?'; }

  const {
    mode = 'warn',
    modeInvalid = false,
    rawMode = '',
    count = 1,
    threshold = 4,
    blocked = false,
    downgraded = false,
    blockCount = 0,
  } = opts;

  const out = [];
  let header;
  if (downgraded) {
    header = await lintNotice(
      'lint.banner.header.downgraded',
      `[OwnMind v${version}] Reply quality lint ⚠️ ${blockCount} consecutive blocks reached — downgrading to warning (please review manually to avoid a loop)`,
      { version, blockCount },
    );
  } else if (blocked) {
    header = await lintNotice(
      'lint.banner.header.blocked',
      `[OwnMind v${version}] Reply quality lint ⚠️ Block triggered — Claude will receive a rewrite directive (session count ${count})`,
      { version, count },
    );
  } else if (mode === 'block') {
    const remaining = Math.max(0, threshold - count);
    header = await lintNotice(
      'lint.banner.header.blockMode',
      `[OwnMind v${version}] Reply quality lint (block mode, session count ${count}, ${remaining} more before block)`,
      { version, count, remaining },
    );
  } else {
    header = await lintNotice(
      'lint.banner.header.otherMode',
      `[OwnMind v${version}] Reply quality lint (${mode} mode, session count ${count})`,
      { version, mode, count },
    );
  }
  out.push(header);

  if (modeInvalid) {
    out.push(await lintNotice(
      'lint.banner.modeInvalid',
      `  ⚠️  OWNMIND_REPLY_LINT_MODE='${rawMode}' is unrecognized — falling back to warn`,
      { rawMode },
    ));
  }

  for (const v of violations) {
    out.push(await lintNotice(
      'lint.banner.violationLine',
      `  ⚠️  ${v.rule}: ${v.message}`,
      { rule: v.rule, message: v.message },
    ));
  }
  return out.join('\n');
}

/**
 * v1.19.7: compress matched privacy items into one summary string (type×n form).
 *
 * v1.19.12 sync note: `labels` here must stay in sync with PRIVACY_TYPE_LABELS in
 * shared/privacy-detect.js — that module exports PRIVACY_TYPE_LABELS for shared use, and when
 * new types are added both places must be updated. We use a local constant rather than dynamic
 * import because this function runs at module top level — we don't want an import failure to
 * lock up the whole hook. The fallback `labels[t] || t` still guarantees unknown types won't
 * break formatting.
 */
function formatPrivacySummary(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return '';
  const byType = new Map();
  for (const m of matches) {
    byType.set(m.type, (byType.get(m.type) || 0) + 1);
  }
  const labels = {
    tw_id: 'Taiwan ID',
    email: 'Email',
    phone_tw_mobile: 'Mobile phone',
  };
  return Array.from(byType.entries())
    .map(([t, n]) => `${labels[t] || t} (${n})`)
    .join(', ');
}


/**
 * v1.19.3: package violations into a directive-style reason fed to Claude as the next prompt after a block.
 *
 * Codex review counter-warning: the reason is "the next prompt", not "a list of corrections".
 *   ❌ Report style: "You violated the mixed-Chinese-English rule, ratio 32%, found 5 English words"
 *   ✅ Directive style: "Please rewrite the previous response, using plain Chinese to replace the following English terms..."
 *
 * The rewrite directive must:
 *   1. Start with an imperative verb ("Please rewrite")
 *   2. List the specific offending words so Claude knows what to change
 *   3. Give format examples (plain Chinese, parenthetical explanations, etc.)
 *   4. Include exceptions (variable names / function names need not change) so Claude doesn't break code
 */
// v1.20.4: event-code → display-name mapping, inlined to avoid scope / import issues.
// Must stay in sync with EVENT_DISPLAY_NAMES in shared/lint-event-types.js.
const _EVENT_DISPLAY_NAMES = {
  lint_language_mixed_ratio: 'Mixed Chinese-English',
  lint_jargon_explanation_required: 'Jargon quality',
  privacy_check: 'Privacy content',
};
function _displayEventName(code) {
  return _EVENT_DISPLAY_NAMES[code] || code;
}

function formatBlockReason(violations, opts = {}) {
  const priorBlockCount = typeof opts.priorBlockCount === 'number' ? opts.priorBlockCount : 0;
  // v1.20.4: assemble using display names; no longer leak personal iron rule numbers
  // (so e.g. another user like Alice never sees a personal iron-rule code in their banner).
  const ruleCodes = violations.map(v => _displayEventName(v.rule)).join(' + ');

  // v1.19.11 graded display: for 2nd–3rd consecutive block show a brief message to avoid user fatigue.
  // priorBlockCount=0 means "1st block", =1 means "2nd block", =2 means "3rd block".
  if (priorBlockCount >= 1 && priorBlockCount <= 2) {
    return [
      `↻ Previous response violated ${ruleCodes} — Claude was instructed to rewrite (session block #${priorBlockCount + 1}).`,
      '',
      'Add this header line first, then write the new response:',
      `> ↻ Previous violated ${ruleCodes}, rewriting.`,
      '',
      'Then rewrite directly — do not re-confirm the question.',
    ].join('\n');
  }

  // 1st block (priorBlockCount=0) or 4th and later (shouldn't reach — downgrade path catches it) → full message.
  const lines = [];
  lines.push('Please rewrite your previous response to fix the following quality issues (preserve meaning, only change language style):');
  lines.push('');

  // v1.19.7 code-review I-5: use a running counter for dynamic numbering,
  // avoiding the orphan effect where partial-match cases start at "3.".
  let n = 1;
  for (const v of violations) {
    if (v.rule === 'lint_language_mixed_ratio') {
      const words = (v.detail && Array.isArray(v.detail.mixedWords)) ? v.detail.mixedWords.slice(0, 10) : [];
      lines.push(`${n}. Use plain Chinese to replace the following English terms (or, on first occurrence, add a parenthetical Chinese explanation):`);
      if (words.length > 0) {
        lines.push(`   ${words.join(', ')}`);
      }
      lines.push('');
      n += 1;
    } else if (v.rule === 'lint_jargon_explanation_required') {
      const words = (v.detail && Array.isArray(v.detail.jargon)) ? v.detail.jargon.slice(0, 10) : [];
      lines.push(`${n}. Add a plain-Chinese explanation when these technical terms first appear (use formats like "：explanation", "（白話：...）", "即...", "也就是..."):`);
      if (words.length > 0) {
        lines.push(`   ${words.join(', ')}`);
      }
      lines.push('');
      n += 1;
    } else if (v.rule === 'privacy_check') {
      // v1.19.7: on privacy match, don't tell Claude which substring matched (avoid echoing personal data in the rewrite).
      // v1.19.10: event code neutralized to 'privacy_check' (no binding to a specific user's iron rule number).
      const matches = (v.detail && Array.isArray(v.detail.matches)) ? v.detail.matches : [];
      const summary = formatPrivacySummary(matches);
      lines.push(`${n}. The response appears to contain user privacy data (${summary}). Rewrite that segment using placeholders like "[email]" or "[mobile phone]" — do NOT repeat the personal data in the new response.`);
      lines.push('');
      n += 1;
    }
  }

  lines.push('If the listed terms are variable names / function names / code references, or were already explained in context, they may be kept.');

  // v1.19.11 added: require the AI to start the rewrite with a self-annotation so the user can tell at a glance
  // "below is the rewrite, reason XXX". 85% compliance is accepted; non-compliance is NOT blocked again (log catches it).
  lines.push('');
  lines.push('Your rewrite must start with a quoted-block annotation in this format:');
  lines.push('');
  lines.push(`> ⚠️ **Previous violated ${ruleCodes}, rewriting:**`);
  lines.push('> (brief note about the violation terms or reason)');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('(Then write the new response content)');
  lines.push('');
  lines.push('Return to the original conversation context — do not re-confirm the question, just give the new answer directly.');

  return lines.join('\n');
}

/**
 * v1.26.171 — the user-facing channel, rebuilt on what actually renders.
 *
 * The old path opened /dev/tty. A hook subprocess has no controlling terminal on any
 * platform, so that open failed every time, the fallback spooled to a file, and the next
 * SessionStart flushed the spool into a stream nobody reads. Three "showing you instead of
 * asking again" notices sat unseen in this user's spool while they were told nothing.
 *
 * The documented channel that reaches the human is JSON on stdout with a `systemMessage`
 * field, exit 0. So notices queue here, and the exit path emits them as one JSON object.
 * The spool stays as an audit record, written unconditionally.
 */
const pendingUserNotices = [];

function queueUserNotice(block) {
  if (typeof block !== 'string' || !block.trim()) return;
  pendingUserNotices.push(block.trim());
  writeFallback(block);
}

/**
 * The one place stdout is written. Claude Code parses it with a real JSON parser; anything
 * else on stdout would corrupt the object, which is why spec #3 (never write stdout) still
 * holds everywhere else in this file.
 */
function exitWith(code) {
  if (code === 0 && pendingUserNotices.length) {
    try {
      process.stdout.write(JSON.stringify({ systemMessage: pendingUserNotices.join('\n') }));
      // v1.26.173 — the update queue is drained here and nowhere else, because here is the
      // only point at which the notice has demonstrably left the process. An exit down any
      // other path leaves the record in place and the next turn shows it instead: an update
      // outcome shown twice is a wart, an update failure shown never is the bug this fixes.
      if (deliveredUpdateNoticeCount > 0 && clearDeliveredUpdateNotices) {
        try {
          clearDeliveredUpdateNotices({ deliveredCount: deliveredUpdateNoticeCount });
        } catch { /* it stays queued and goes out next turn */ }
      }
    } catch { /* a notice that cannot be emitted is already in the spool */ }
  }
  process.exit(code);
}

function writeFallback(block) {
  try {
    const dir = path.dirname(PENDING_FILE);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const stat = fs.statSync(PENDING_FILE);
      if (stat.size > PENDING_FILE_MAX_BYTES) {
        try { fs.renameSync(PENDING_FILE, PENDING_FILE + '.old'); } catch { /* ignore */ }
      }
    } catch { /* file does not exist → skip */ }
    const record = { ts: new Date().toISOString(), block };
    fs.appendFileSync(PENDING_FILE, JSON.stringify(record) + '\n');
  } catch { /* swallow */ }
}

/**
 * Compliance events — schema must align with src/routes/activity.js batch handler:
 *   { ts, event, tool, source, details, client_event_id }
 * Missing ts or event causes the server to skip the row outright (no DB write).
 *
 * details.rule_code + details.action are the key fields used by later pitfalls / dashboard queries
 * (aligned with how mcp/index.js's report_compliance writes them).
 *
 * v1.17.98: client_event_id (uuid v4) — the server uses (user_id, client_event_id) as a partial
 * unique index with ON CONFLICT DO NOTHING for dedup, resolving the race where hook POST timeout
 * gets resent by SessionStart flush, or two SessionStarts run concurrently. The same violation
 * across hook and flush paths MUST carry the same id to dedup correctly, so the id is generated
 * once here and reused across banner / archive / pending.
 */
// v1.19: extracted to hooks/lib/build-compliance-events.js for unit testing:
//   buildComplianceEvents(violations, rules, getTier) — dynamic import inside main().

/**
 * v1.19: read local iron_rules cache for tier lookup.
 * Pure best-effort: missing cache or parse failure → return empty array, never block the main flow.
 */
function readIronRulesCache() {
  try {
    const cachePath = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
    if (!fs.existsSync(cachePath)) return [];
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Archive write to ~/.ownmind/logs/YYYY-MM-DD.jsonl (same as mcp/ownmind-log.js LOGS_DIR).
 * Pure debugging / human-readable artifact; no reader actively picks it up (confirmed v1.17.97).
 * Must not throw: a write failure must not block the hook.
 */
function spoolEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  try {
    const logsDir = path.join(HOME, '.ownmind', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    // v1.26.124: local, not UTC. The MCP names this file by the local date; this hook
    // named it by the UTC one, so on a UTC+8 machine every event spooled between local
    // midnight and 08:00 went into yesterday's file while the MCP wrote today's.
    const dateStr = localDateOnly(new Date());
    const filePath = path.join(logsDir, `${dateStr}.jsonl`);
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(filePath, lines);
  } catch { /* swallow */ }
}

/**
 * v1.17.97 — on POST failure, spool to reply-lint-pending.jsonl for the next SessionStart flush.
 * Append-only: existing content preserved, new events appended.
 *
 * Size cap (review N1): when above 1MB, rotate to .old (overwriting the previous .old), so an
 * extended offline period can't grow this file unbounded.
 *
 * Must not throw.
 */
const COMPLIANCE_PENDING_MAX_BYTES = 1024 * 1024;

function spoolPendingForRetry(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  try {
    const dir = path.dirname(COMPLIANCE_PENDING_FILE);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const stat = fs.statSync(COMPLIANCE_PENDING_FILE);
      if (stat.size > COMPLIANCE_PENDING_MAX_BYTES) {
        try { fs.renameSync(COMPLIANCE_PENDING_FILE, COMPLIANCE_PENDING_FILE + '.old'); } catch { /* ignore */ }
      }
    } catch { /* file does not exist → skip */ }
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(COMPLIANCE_PENDING_FILE, lines);
  } catch { /* swallow */ }
}

/**
 * Best-effort POST events to /api/activity/batch.
 * Awaits until the socket flushes before resolving (review B2 — avoid process.exit killing the socket).
 * 1500ms timeout; on timeout destroys the request and resolves(false).
 *
 * @returns {Promise<boolean>} true on HTTP 2xx; otherwise false (caller falls back to spool retry).
 */
function postEvents(events, readCredentials) {
  return new Promise((resolve) => {
    if (!Array.isArray(events) || events.length === 0) { resolve(false); return; }
    let apiKey = '', apiUrl = '';
    try {
      ({ apiKey, apiUrl } = readCredentials());
    } catch { resolve(false); return; }
    if (API_URL_OVERRIDE) apiUrl = API_URL_OVERRIDE;
    if (!apiKey || !apiUrl) { resolve(false); return; }

    let u;
    try { u = new URL('/api/activity/batch', apiUrl); }
    catch { resolve(false); return; }

    const body = JSON.stringify({ events });
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok === true); } };

    let req;
    try {
      req = mod.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: POST_TIMEOUT_MS,
      }, (res) => {
        // HTTP 2xx counts as success; 4xx/5xx counts as failure → spool retry.
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        res.on('data', () => { /* drain */ });
        res.on('end', () => done(ok));
        res.on('error', () => done(false));
      });
    } catch { resolve(false); return; }

    req.on('error', () => done(false));
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } done(false); });
    try { req.write(body); req.end(); }
    catch { done(false); }
  });
}
