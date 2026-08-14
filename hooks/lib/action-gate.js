/**
 * Action gate: guard matching against real command lines.
 *
 * Matches action guards against a detected command trigger, including special
 * handling for version-tag pushes which are deployments even when the general
 * classifier detects them as plain git pushes.
 */

import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { detectCommandTrigger } from '../../shared/helpers.js';
import { writeReceipt, verifyReceipt } from './gate-receipt.js';
// Guarded, NOT static. A static `import { t } from './i18n.js'` is unrecoverable at module
// scope: if i18n.js is missing, unparseable, or throws while loading, action-gate.js itself
// fails to load, the callers' outer catch fires, and the command runs UNGATED. That hands a
// message-formatting module the power to switch enforcement off — a half-written file from an
// interrupted update.sh, a failed copy, or a Windows AV quarantine would be enough. The gate
// must still decide with no message layer at all, so the binding is lazy and every use goes
// through safeT() below. reason strings stay raw English template literals; only userLine
// (user-facing) routes through translations.
let translate = null;
try { ({ t: translate } = await import('./i18n.js')); } catch { /* gate must decide even with no message layer */ }

/**
 * Total message lookup: returns the localized string when the message layer works, and the
 * exact pre-i18n English literal otherwise. Never throws, never returns a bare dictionary key.
 *
 * Three separate failures collapse to the same fallback: the module never loaded (translate
 * stays null), t() throws at call time, and t() echoes the key back because no dictionary was
 * found beside it (hooks/locales/ missing). A raw key is not a message, so the last one counts
 * as a failure too even though nothing threw.
 *
 * @param {string} key dictionary key
 * @param {string} fallback the English literal this site emitted before i18n existed
 * @param {Record<string, unknown>} [params] placeholder values, same set as the fallback uses
 * @returns {string}
 */
const safeT = (key, fallback, params) => {
  try {
    if (!translate) return fallback;
    const rendered = translate(key, params);
    return typeof rendered === 'string' && rendered !== key ? rendered : fallback;
  } catch { return fallback; }
};

/**
 * Regex for version-tag pushes.
 * Matches git push commands with version-like tags that indicate a deployment.
 * Examples: v0.35.13, ima-v1.2.9, ima-rc123
 */
const TAG_PUSH = /git\s+push\b.*\s(?:refs\/tags\/)?(?:v\d|ima-v|ima-rc)/;

/**
 * Regex for plain `docker build` invocations.
 * The shared classifier only recognises `docker compose` verbs as deploys, so the
 * non-compliant sibling — `docker build` where a guard demands `docker compose build`
 * — would never reach the gate, making its must_not_match check dead code. Anchored
 * to a command position (start of string, or after ;, &, |, or sudo) so quoted
 * mentions like `git grep "docker build"` stay unmatched.
 */
const DOCKER_BUILD = /(^|[;&|]\s*|\bsudo\s+)docker\s+build(\s|$)/;

/**
 * Check if a command matches a guard's applies_pattern.
 * If the pattern is invalid, returns true (fail toward enforcement).
 * @param {string} command
 * @param {string} pattern
 * @returns {boolean}
 */
function patternMatches(command, pattern) {
  // No pattern or empty pattern: always matches
  if (!pattern || typeof pattern !== 'string' || !pattern.trim()) return true;

  try {
    // Case-insensitive: the shared trigger classifier is /i, so a bare-trigger guard already
    // catches `Git push` (capital G). A guard that scopes itself with applies_pattern must not
    // be weaker — a capitalized command must not walk past a rule that narrowed itself.
    const regex = new RegExp(pattern, 'i');
    return regex.test(command);
  } catch {
    // Invalid regex: fail toward enforcement (return true)
    return true;
  }
}

/**
 * Match action guards whose triggers include the detected command trigger.
 *
 * Detects the trigger from the command using detectCommandTrigger. Also
 * applies special logic for version-tag pushes, which count as deployments
 * even if the general classifier identifies them as plain git pushes.
 *
 * Guards may carry an applies_pattern field (regex string) to further
 * restrict matching. If present, the guard only matches if the pattern
 * matches the command. Invalid patterns are treated as always matching
 * (fail toward enforcement).
 *
 * @param {string} command — bash command
 * @param {Array} guards — array of guard objects
 * @returns {Array} guards whose triggers match the detected trigger and patterns match
 */
export function matchGuards(command, guards) {
  // Reject null/undefined/empty commands
  if (typeof command !== 'string' || !command.trim()) return [];

  // Build the set of triggers this command activates
  const triggers = new Set();

  // Detect trigger from command classifier
  const detected = detectCommandTrigger(command);
  if (detected) triggers.add(detected);

  // Special case: version-tag pushes are deployments
  if (TAG_PUSH.test(command)) triggers.add('deploy');

  // Special case: a plain `docker build` is a deploy attempt — it is the very
  // command the compose guards exist to intercept, and the shared classifier
  // does not see it.
  if (DOCKER_BUILD.test(command)) triggers.add('deploy');

  // No triggers matched, return empty array
  if (!triggers.size) return [];

  // Filter guards: only action guards with matching triggers and patterns
  // Use Array.isArray to safely handle non-array values (e.g., corrupted cache data)
  return (Array.isArray(guards) ? guards : []).filter(
    (g) =>
      g &&
      g.kind === 'action' &&
      Array.isArray(g.triggers) &&
      g.triggers.some((t) => triggers.has(t)) &&
      patternMatches(command, g.applies_pattern)
  );
}

// --- Decision core: read gate, compliance gate, ask-first, stop-and-ask limit ---

const askPath = (d, sid, gid) => path.join(d, `gate-ask-${sid}-${gid}.json`);
const limitPath = (d, sid, gid) => path.join(d, `gate-limit-${sid}-${gid}.json`);
const logPath = (d) => path.join(d, 'gate-log.jsonl');

/**
 * Audit-log size cap. Past this, the current log is rotated to gate-log.jsonl.old (overwriting
 * any prior .old) before the next line is appended, so the audit record cannot grow unbounded.
 * Same pattern and intent as the banner spool's PENDING_FILE_MAX_BYTES in ownmind-reply-lint.js.
 */
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * sessionId is trusted from the harness only. It is embedded in state file
 * names, so anything outside this set (e.g. a "/" from "../") could steer
 * state paths outside the state directory.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function log(stateDir, entry) {
  try {
    const p = logPath(stateDir);
    try {
      if (fs.statSync(p).size > LOG_MAX_BYTES) {
        try { fs.renameSync(p, p + '.old'); } catch { /* ignore — worst case the log keeps growing */ }
      }
    } catch { /* file does not exist yet → nothing to rotate */ }
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* the log must never take the gate down */ }
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function bumpLimit(stateDir, sid, gid, kind) {
  const p = limitPath(stateDir, sid, gid);
  const prev = readJson(p) || { kind: null, count: 0 };
  const count = prev.kind === kind ? prev.count + 1 : 1;
  try { fs.writeFileSync(p, JSON.stringify({ kind, count })); } catch { /* over-asks, never under */ }
  return count;
}
function clearLimit(stateDir, sid, gid) { try { fs.unlinkSync(limitPath(stateDir, sid, gid)); } catch { /* absent is fine */ } }

function issueAsk(stateDir, sid, guard, kindLabel) {
  // Amendment 3 (verbal mode): an ask_first guard the owner marked ask_mode:'verbal' still BLOCKS
  // and surfaces the rule, but requires no secret code — a spoken "go" approves it. This is a
  // stop-and-confirm gate, not an unforgeable-consent gate; the honesty downgrade is recorded
  // as approval_mode:'verbal'. The limit backstop is NEVER verbal ("limit path unchanged"), so
  // verbal only applies to the ask_first path (kindLabel === 'ask').
  const verbal = kindLabel === 'ask' && guard.ask_mode === 'verbal';
  if (verbal) {
    try {
      // No codeHash: a verbal ask has no code to satisfy. mode:'verbal' is the on-disk marker
      // that only approveActionVerbal — never the code CLI — may approve this record.
      fs.writeFileSync(askPath(stateDir, sid, guard.id),
        JSON.stringify({ approved: false, kind: kindLabel, mode: 'verbal' }));
    } catch { /* without the file the approve step fails closed */ }
    return {
      action: 'block', kind: kindLabel, guardId: guard.id,
      reason: `[OwnMind gate] "${guard.title}" needs the user's explicit go-ahead before this action runs. `
        + 'Relay this block to the user in your own words. ONLY if the user then replies with an '
        + 'affirmative (go / ok / 好 / yes) run: '
        // `--session ${sid}` is not optional decoration: without it the CLI falls back to a
        // single global pointer that the most recent SessionStart owns, so with two Claude
        // sessions open the approval lands on the wrong one and a genuine "go" is refused.
        + `node ~/.ownmind/hooks/lib/approve-action.js --verbal ${guard.id} --session ${sid} — then retry the command. `
        + 'Do NOT run that command otherwise, and do not state or imply the user approved unless they actually did.',
      userLine: safeT(
        'gate.ask.verbal',
        `[OwnMind] 🟢 The AI wants to do something your rules say to ask about first, so OwnMind stopped it: ${guard.title}\n`
        + '  Reply "go" and OwnMind allows it this once; reply "no" and it does not.',
        { title: guard.title }
      ),
      approval_mode: 'verbal',
    };
  }

  // The code is a consent secret, not a label: use a CSPRNG, not Math.random.
  const code = String(randomInt(100000, 1000000));
  try {
    // NEW-1: Store kindLabel so we can distinguish ask vs limit approvals.
    // mode:'code' is the explicit sentinel so approveActionVerbal can refuse to downgrade it.
    fs.writeFileSync(askPath(stateDir, sid, guard.id),
      JSON.stringify({ codeHash: createHash('sha256').update(code).digest('hex'), approved: false, kind: kindLabel, mode: 'code' }));
  } catch { /* without the file the approve step fails closed */ }
  return {
    action: 'block', kind: kindLabel, guardId: guard.id,
    reason: `[OwnMind gate] "${guard.title}" needs the user's explicit go for this action. `
      + 'Ask the user for the 6-digit approval code shown on their screen, then run: '
      // Same reason as the verbal branch above: the session has to be named, or a second
      // open session silently owns the pointer this CLI would otherwise resolve through.
      + `node ~/.ownmind/hooks/lib/approve-action.js ${guard.id} <code> --session ${sid} — and retry the command.`,
    userLine: kindLabel === 'limit'
      ? safeT(
        'gate.ask.code.limit',
        `[OwnMind] 🟡 OwnMind has blocked the same command from the AI 3 times and it is still trying. It is stuck on this rule: ${guard.title}\n`
        + `  Paste this number to the AI and OwnMind allows it this once: ${code}. If you would rather it stopped, just ignore this.`,
        { title: guard.title, code }
      )
      : safeT(
        'gate.ask.code.action',
        `[OwnMind] 🟢 The AI wants to do something your rules say to ask about first, so OwnMind stopped it: ${guard.title}\n`
        + `  Paste this number to the AI and OwnMind allows it this once: ${code}`,
        { title: guard.title, code }
      ),
    code_issued: true,
  };
}

/**
 * How many wrong codes an ask tolerates before it is burned. A 6-digit code is a small space;
 * without a cap, an attacker could enumerate it against a single ask file. After this many
 * misses the ask never approves again — the AI must trigger a fresh ask (new code) to proceed.
 */
const MAX_ASK_MISSES = 5;

export function approveAction(stateDir, sessionId, guardId, code) {
  // I4: Apply same sessionId sanitization and validate guardId
  const sid = typeof sessionId === 'string' && SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : 'unknown';
  if (!Number.isInteger(guardId) || guardId <= 0) return false;

  const p = askPath(stateDir, sid, guardId);
  const rec = readJson(p);
  if (!rec || rec.approved) return false;

  // A code approve may satisfy ONLY a code-mode ask. A verbal-mode ask carries no code, so the
  // code CLI must not be able to approve it — the two consent paths stay separate on purpose.
  if (rec.mode === 'verbal') return false;

  // A burned ask never yields, even to the correct code. issueAsk overwrites the file with a
  // fresh record (no misses), so a new ask resets the counter — a wrong-guess run cannot lock
  // the user out, it only wastes the one code it was guessing against.
  const misses = Number.isInteger(rec.misses) ? rec.misses : 0;
  if (misses >= MAX_ASK_MISSES) return false;

  if (createHash('sha256').update(String(code)).digest('hex') !== rec.codeHash) {
    // Wrong code: burn one attempt so guessing the 6-digit space is not free.
    try { fs.writeFileSync(p, JSON.stringify({ ...rec, misses: misses + 1 })); } catch { /* fail closed: no approval */ }
    return false;
  }
  try { fs.writeFileSync(p, JSON.stringify({ ...rec, approved: true })); } catch { return false; }
  return true;
}

/**
 * Verbal approval (Amendment 3): mark a verbal-mode ask approved with NO code. The user said
 * "go" out loud; the AI records that and proceeds. This is the accepted honesty downgrade — a
 * stop-and-confirm, not unforgeable consent — so the record carries approval_mode:'verbal'.
 *
 * It REFUSES a code-mode ask: a verbal "go" cannot downgrade a guard the owner left in code mode.
 * It applies the same sessionId/guardId sanitization as approveAction, so a path-traversal
 * sessionId or a non-positive guardId can never approve anything.
 *
 * @param {string} stateDir
 * @param {string} sessionId
 * @param {number} guardId
 * @returns {boolean}
 */
export function approveActionVerbal(stateDir, sessionId, guardId) {
  const sid = typeof sessionId === 'string' && SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : 'unknown';
  if (!Number.isInteger(guardId) || guardId <= 0) return false;

  const p = askPath(stateDir, sid, guardId);
  const rec = readJson(p);
  if (!rec || rec.approved) return false;

  // A verbal approve may satisfy ONLY a verbal-mode ask. A code-mode ask (or any ask without
  // the verbal marker) cannot be waved through by the verbal CLI — that would defeat the code
  // guard entirely.
  if (rec.mode !== 'verbal') return false;

  try { fs.writeFileSync(p, JSON.stringify({ ...rec, approved: true, approval_mode: 'verbal' })); }
  catch { return false; }
  return true;
}

function consumeApproval(stateDir, sessionId, guardId) {
  const p = askPath(stateDir, sessionId, guardId);
  const rec = readJson(p);
  if (!rec || rec.approved !== true) return false;
  try { fs.unlinkSync(p); } catch { /* worst case: one extra allowed retry this session */ }
  return true;
}

export function evaluateGate({ command, guards, stateDir, sessionId }) {
  // Path-traversal hardening: never let an untrusted sessionId steer state paths.
  const sid = typeof sessionId === 'string' && SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : 'unknown';

  const matched = matchGuards(command, guards);
  let globalDegraded = false;
  const consumedGuards = [];
  // Amendment 3: record when an allow is being granted on the strength of a verbal go-ahead,
  // so the audit log shows the honesty boundary rather than hiding it.
  let verbalApprovalConsumed = false;

  // I2: Evaluate all guards first, collect verdicts, defer approval consumption
  const approvalsToConsume = [];

  for (const guard of matched) {
    let degradedRead = false; // (c) Reset degradedRead per guard

    // C2: Wrap receipt operations; skip read gate on failure but set degraded flag
    if (guard.read_required) {
      let receiptValid = false;
      try {
        receiptValid = verifyReceipt(stateDir, sid, guard);
      } catch {
        degradedRead = true;
      }

      if (!receiptValid) {
        try {
          writeReceipt(stateDir, sid, guard);
        } catch {
          degradedRead = true;
        }

        // If receipt subsystem failed (not just missing receipt), skip read gate
        // but don't block - let checks run (stateless)
        if (degradedRead) {
          globalDegraded = true;
          // Skip to checks, don't block on read gate
          // Continue to check phase below
        } else {
          // Normal case: receipt missing or invalid, bump counter and block
          const count = bumpLimit(stateDir, sid, guard.id, 'read');
          if (count >= 3) {
            const ask = issueAsk(stateDir, sid, guard, 'limit');
            const logEntry = { sessionId: sid, guardId: guard.id, command, kind: 'limit', action: 'block' };
            if (ask.code_issued) logEntry.code_issued = true;
            log(stateDir, logEntry);
            // (a) Carry degraded flag in blocks
            return { ...ask, ...(globalDegraded && { degraded: 'no-receipts' }) };
          }
          const logEntry = { sessionId: sid, guardId: guard.id, command, kind: 'read', action: 'block' };
          log(stateDir, logEntry);
          // NEW-2: Restore userLine for read-block
          return {
            action: 'block', kind: 'read', guardId: guard.id,
            reason: `[OwnMind gate] Read this rule before acting, then retry the command:\n--- RULE ${guard.id}: ${guard.title} ---\n${guard.rule_text}`,
            userLine: safeT(
              'gate.read.blocked',
              `[OwnMind] 🟢 The AI tried to act without reading this rule first, so OwnMind stopped it: ${guard.title}\n`
              + '  Once the AI has read the rule and retried, OwnMind lets it through automatically. Nothing for you to do.',
              { title: guard.title }
            ),
            ...(globalDegraded && { degraded: 'no-receipts' }),
          };
        }
      }
    }

    // Checks still run (stateless) even with receipt degradation
    // I1 & NEW-1: Check if there's a redeemable approval first
    // NEW-1: Only bypass checks for 'limit' kind, not 'ask' kind
    const hasLimitApproval = (() => {
      const p = askPath(stateDir, sid, guard.id);
      const rec = readJson(p);
      return rec && rec.approved === true && rec.kind === 'limit';
    })();

    if (hasLimitApproval) {
      // Defer consumption until all guards pass (only for limit, not ask)
      approvalsToConsume.push(guard.id);
      // Clear counter for this guard
      clearLimit(stateDir, sid, guard.id);
      consumedGuards.push(guard.id);
      // Continue to next guard
      continue;
    }

    for (const c of guard.checks || []) {
      let re; try { re = new RegExp(c.pattern); } catch { continue; }
      const hit = re.test(command);
      if ((c.type === 'must_match' && !hit) || (c.type === 'must_not_match' && hit)) {
        const count = bumpLimit(stateDir, sid, guard.id, 'check');
        if (count >= 3) {
          const ask = issueAsk(stateDir, sid, guard, 'limit');
          const logEntry = { sessionId: sid, guardId: guard.id, command, kind: 'limit', action: 'block' };
          if (ask.code_issued) logEntry.code_issued = true;
          log(stateDir, logEntry);
          // (a) Carry degraded flag in blocks
          return { ...ask, ...(globalDegraded && { degraded: 'no-receipts' }) };
        }
        const logEntry = { sessionId: sid, guardId: guard.id, command, kind: 'check', action: 'block' };
        log(stateDir, logEntry);
        // NEW-2: Restore userLine for check-block
        return {
          action: 'block', kind: 'check', guardId: guard.id,
          reason: `[OwnMind gate] The command violates "${guard.title}": ${c.reason}. Fix the command and retry.`,
          userLine: safeT('gate.check.blocked',
            `[OwnMind] 🟢 The AI's command does not meet your rules, so OwnMind stopped it: ${c.reason}\n`
            + '  Once the AI fixes the command and retries it will go through. Nothing for you to do.',
            { reason: c.reason }),
          ...(globalDegraded && { degraded: 'no-receipts' }),
        };
      }
    }

    // ask_first: fails closed even with degradation - check without consuming
    if (guard.ask_first) {
      const p = askPath(stateDir, sid, guard.id);
      const rec = readJson(p);
      if (!rec || rec.approved !== true) {
        const ask = issueAsk(stateDir, sid, guard, 'ask');
        const logEntry = { sessionId: sid, guardId: guard.id, command, kind: 'ask', action: 'block' };
        if (ask.code_issued) logEntry.code_issued = true;
        // A verbal ask logs approval_mode:'verbal' instead of code_issued — never a code.
        if (ask.approval_mode) logEntry.approval_mode = ask.approval_mode;
        log(stateDir, logEntry);
        // (a) Carry degraded flag in blocks
        return { ...ask, ...(globalDegraded && { degraded: 'no-receipts' }) };
      }
      // The go-ahead was verbal: mark it so the eventual allow log records the honesty boundary.
      if (rec.approval_mode === 'verbal') verbalApprovalConsumed = true;
      // Defer consumption until all guards pass (ask approvals also deferred)
      approvalsToConsume.push(guard.id);
      consumedGuards.push(guard.id);
    }

    // Guard passed all gates
    clearLimit(stateDir, sid, guard.id);
  }

  // All guards passed: now consume deferred approvals
  for (const guardId of approvalsToConsume) {
    consumeApproval(stateDir, sid, guardId);
  }

  // (b) Allow log entries record per-guard guardId list
  const logEntry = { sessionId: sid, command, action: 'allow' };
  if (consumedGuards.length > 0) logEntry.guardIds = consumedGuards;
  if (globalDegraded) logEntry.degraded = 'no-receipts';
  if (verbalApprovalConsumed) logEntry.approval_mode = 'verbal';
  log(stateDir, logEntry);

  return { action: 'allow', ...(globalDegraded && { degraded: 'no-receipts' }) };
}
