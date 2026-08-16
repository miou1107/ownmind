/**
 * Action gate: guard matching against real command lines.
 *
 * Matches action guards against a detected command trigger, including special
 * handling for version-tag pushes which are deployments even when the general
 * classifier detects them as plain git pushes.
 */

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { detectCommandTrigger } from '../../shared/helpers.js';
import { writeReceipt, verifyReceipt, sealAsk, verifyAskSeal } from './gate-receipt.js';
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

/**
 * The record format this version writes. A record without it was written by a version that
 * stored the code as a plain sha256 — see CODE_KDF — and is refused rather than upgraded in
 * place, because there is nothing in it worth keeping. Refusing reissues on the next attempt,
 * so the cost of an upgrade landing mid-approval is one extra round trip.
 */
const ASK_FORMAT = 2;

/**
 * How the consent code is stored.
 *
 * It used to be `sha256(code)`, written to a file in the state directory. A six-digit code is
 * 900,000 values, so the fingerprint the product wrote down was the code: measured 2026-08-15
 * at 318 ms and 32 ms on two runs to recover it, and re-measured 2026-08-16 at 0.7 s for a
 * full sweep of the space. `MAX_ASK_MISSES` was no defence, because recovering the code costs
 * no wrong guesses — the attacker submits once, and is right.
 *
 * scrypt with a per-record salt is what changes that. Measured on the author's machine at
 * these parameters: 67 ms for one verification, so 16.8 hours for the sweep that used to take
 * 0.7 seconds. Memory-hard (32 MB per attempt at N=32768, r=8), so the usual answer of
 * throwing parallel hardware at it does not collapse the number either.
 *
 * 67 ms is paid twice per approval — once issuing, once checking — by a human who is being
 * asked a question. It is not detectable at that scale.
 */
const CODE_KDF = {
  N: 32768,
  r: 8,
  p: 1,
  keylen: 32,
  // 128 * N * r comes to exactly 33,554,432 bytes here, and node's default ceiling is exactly
  // 33,554,432 — it wants headroom, not a tie, so the default throws "Invalid scrypt params".
  // Left out, that throw lands in issueAsk's catch, no ask file is written, and every approval
  // is then refused for a record that does not exist. Caught by the existing gate tests.
  maxmem: 64 * 1024 * 1024,
};

/**
 * How long a code-mode ask can still be approved. The point is to keep the window shorter
 * than the sweep above by a wide margin: an hour against 16.8 hours.
 *
 * Verbal asks are exempt and carry no expiry. They hold no secret to recover — that is the
 * accepted honesty downgrade the mode is named for — so expiring them would buy nothing and
 * cost a user their answer for being slow.
 */
const ASK_TTL_MS = 60 * 60 * 1000;

/** Derive the stored form of a code. Total: a malformed salt yields a value that matches nothing. */
function deriveCode(code, salt) {
  return scryptSync(String(code), String(salt), CODE_KDF.keylen, CODE_KDF).toString('hex');
}

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

/**
 * Write an ask record with this machine's seal on it. Every write of that file goes through
 * here — an unsealed write is a record the gate would then refuse to honour, which reads at
 * the call site as the approval mysteriously not taking.
 */
function writeAsk(stateDir, sid, guardId, rec) {
  const sealed = { ...rec, seal: sealAsk(stateDir, sid, guardId, rec) };
  const p = askPath(stateDir, sid, guardId);
  // Same write-side symlink defence as writeReceipt: unlink a planted link, never its target.
  try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* absent is normal */ }
  fs.writeFileSync(p, JSON.stringify(sealed));
}

/**
 * Read an ask record this gate really issued, or nothing.
 *
 * The approve functions used to read this file with a bare `readJson`, check the code
 * against whatever hash was in it, and then hand the result to `writeAsk` — which signs it
 * with the real key. That made the pair a signing oracle: anything able to write the file
 * could have the gate seal an approval for it, without ever reading `gate.key`. Review found
 * it and four attacks were reproduced against it, three of them silent. The seal check has
 * to come first, before any other test, or every test after it is judging the attacker's own
 * record.
 *
 * @returns {object|null} the record, only when this machine wrote it
 */
function readIssuedAsk(stateDir, sid, guardId) {
  const rec = readJson(askPath(stateDir, sid, guardId));
  if (!rec || rec.v !== ASK_FORMAT) return null;
  if (verifyAskSeal(stateDir, sid, guardId, rec) !== 'valid') return null;
  return rec;
}

/**
 * Read an approval that this gate actually granted, or nothing.
 *
 * Three separate answers collapse to null here, and they must: no file, a file in the format
 * a prior version wrote, and a file whose seal does not match. The last one is the case this
 * function exists for — on 2026-08-15 an assistant put `{"approved":true}` at this path by
 * hand and the gate honoured it, because being at the path was the whole of the check.
 *
 * @returns {{rec: object, problem: null|'invalid'|'unverifiable'}|null}
 *   `problem` separates two things the first version ran together. `invalid` is a record
 *   this machine did not write — an accusation, and worth making. `unverifiable` is the key
 *   or the session nonce being unreadable, where nothing can be told either way; saying
 *   "OwnMind did not issue it" there would accuse somebody over a perfectly genuine
 *   approval. Both refuse; only the sentence differs.
 *
 *   A file in the format a prior version wrote returns null, like no file at all: an upgrade
 *   landing mid-approval reissues on the next attempt, which is not worth alarming anybody
 *   about.
 */
function readApprovedAsk(stateDir, sid, guardId) {
  const rec = readJson(askPath(stateDir, sid, guardId));
  if (!rec || rec.approved !== true) return null;
  if (rec.v !== ASK_FORMAT) return null;
  const seal = verifyAskSeal(stateDir, sid, guardId, rec);
  return { rec, problem: seal === 'valid' ? null : seal };
}

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
  // An ask the gate could not write to disk fails closed, which is right — but it used to do
  // it in silence, handing the user a six-digit code, or a "reply go", that nothing could
  // ever redeem. Failing closed and looking exactly like working is the pairing this product
  // exists to end, so the block says so. Sealing brought a key read and a nonce write onto
  // this path, which widened the window this covers.
  let notRecorded = false;
  const notRecordedLine = () => (notRecorded
    ? `\n${safeT(
      'gate.ask.notRecorded',
      '[OwnMind] 🔴 OwnMind could not save this approval, so it will not recognise your answer.\n'
      + '  Re-running the OwnMind update script repairs this.',
    )}`
    : '');

  const verbal = kindLabel === 'ask' && guard.ask_mode === 'verbal';
  if (verbal) {
    try {
      // No stored code: a verbal ask has no code to satisfy. mode:'verbal' is the on-disk
      // marker that only approveActionVerbal — never the code CLI — may approve this record.
      writeAsk(stateDir, sid, guard.id,
        { v: ASK_FORMAT, approved: false, kind: kindLabel, mode: 'verbal' });
    } catch { notRecorded = true; }
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
      ) + notRecordedLine(),
      approval_mode: 'verbal',
      ...(notRecorded && { not_recorded: true }),
    };
  }

  // The code is a consent secret, not a label: use a CSPRNG, not Math.random.
  const code = String(randomInt(100000, 1000000));
  try {
    // NEW-1: Store kindLabel so we can distinguish ask vs limit approvals.
    // mode:'code' is the explicit sentinel so approveActionVerbal can refuse to downgrade it.
    // The salt is per-record, so one sweep buys one code rather than a rainbow table.
    const codeSalt = randomBytes(16).toString('hex');
    writeAsk(stateDir, sid, guard.id, {
      v: ASK_FORMAT,
      codeSalt,
      codeHash: deriveCode(code, codeSalt),
      approved: false,
      kind: kindLabel,
      mode: 'code',
      issuedAt: Date.now(),
    });
  } catch { notRecorded = true; }
  return {
    action: 'block', kind: kindLabel, guardId: guard.id,
    reason: `[OwnMind gate] "${guard.title}" needs the user's explicit go for this action. `
      + 'Ask the user for the 6-digit approval code shown on their screen, then run: '
      // Same reason as the verbal branch above: the session has to be named, or a second
      // open session silently owns the pointer this CLI would otherwise resolve through.
      + `node ~/.ownmind/hooks/lib/approve-action.js ${guard.id} <code> --session ${sid} — and retry the command.`,
    userLine: (kindLabel === 'limit'
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
      )) + notRecordedLine(),
    code_issued: true,
    ...(notRecorded && { not_recorded: true }),
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

  const rec = readIssuedAsk(stateDir, sid, guardId);
  if (!rec || rec.approved) return false;

  // A code approve may satisfy ONLY a code-mode ask. A verbal-mode ask carries no code, so the
  // code CLI must not be able to approve it — the two consent paths stay separate on purpose.
  if (rec.mode === 'verbal') return false;

  // A sealed record with no salt cannot be a code ask this version issued. (The older format
  // never gets here at all — readIssuedAsk refuses it, so no miss is burned over a record the
  // user did nothing wrong with, and retrying the command reissues in the current format.)
  if (typeof rec.codeSalt !== 'string') return false;

  // Past its hour. Same reasoning as the miss cap, against the other attack: a code that stays
  // answerable forever is a code somebody has forever to work out.
  if (!Number.isFinite(rec.issuedAt) || Date.now() - rec.issuedAt > ASK_TTL_MS) return false;

  // A burned ask never yields, even to the correct code. issueAsk overwrites the file with a
  // fresh record (no misses), so a new ask resets the counter — a wrong-guess run cannot lock
  // the user out, it only wastes the one code it was guessing against.
  const misses = Number.isInteger(rec.misses) ? rec.misses : 0;
  if (misses >= MAX_ASK_MISSES) return false;

  // Constant-time, with the length guard timingSafeEqual needs: a truncated or garbage stored
  // hash must be a mismatch, not a throw.
  const got = Buffer.from(deriveCode(code, rec.codeSalt), 'hex');
  const want = Buffer.from(String(rec.codeHash ?? ''), 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    // Wrong code: burn one attempt so guessing the 6-digit space is not free.
    try { writeAsk(stateDir, sid, guardId, { ...rec, misses: misses + 1 }); }
    catch { /* fail closed: no approval */ }
    return false;
  }
  try { writeAsk(stateDir, sid, guardId, { ...rec, approved: true }); }
  catch { return false; }
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

  // Seal first, before anything reads a field off this record. A planted `mode:'verbal'`
  // record used to be enough to walk a CODE-mode guard through this function, because the
  // mode it checked came out of the attacker's own file.
  const rec = readIssuedAsk(stateDir, sid, guardId);
  if (!rec || rec.approved) return false;

  // A verbal approve may satisfy ONLY a verbal-mode ask. A code-mode ask (or any ask without
  // the verbal marker) cannot be waved through by the verbal CLI — that would defeat the code
  // guard entirely.
  if (rec.mode !== 'verbal') return false;

  try { writeAsk(stateDir, sid, guardId, { ...rec, approved: true, approval_mode: 'verbal' }); }
  catch { return false; }
  return true;
}

function consumeApproval(stateDir, sessionId, guardId) {
  const p = askPath(stateDir, sessionId, guardId);
  const approval = readApprovedAsk(stateDir, sessionId, guardId);
  if (!approval || approval.problem) return false;
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
  // so the audit log shows the honesty boundary rather than hiding it. Null until one is
  // consumed; the guard's title once one is, because the user has to be told WHICH thing the
  // assistant says they agreed to.
  let verbalApprovalTitle = null;
  /**
   * Approval records that were found and not honoured, by guard.
   *
   * A single slot, read only inside the ask_first block, threw the finding away in exactly
   * the cases that matter: a forged record sitting on a guard that does not ask was detected
   * and then allowed, silently; a forgery on one guard was lost when a different guard
   * blocked. Every detection is logged where it happens now, and the verdict — block or
   * allow — carries it to the user either way.
   *
   * @type {Map<number|string, 'invalid'|'unverifiable'>}
   */
  const ignoredApprovals = new Map();

  /** Record one, once per guard, at the moment it is found rather than at the moment it blocks. */
  const noteIgnoredApproval = (guardId, problem) => {
    if (!problem || ignoredApprovals.has(guardId)) return;
    ignoredApprovals.set(guardId, problem);
    log(stateDir, {
      sessionId: sid,
      guardId,
      command,
      action: 'ignored-approval',
      // Two different facts, kept apart in the log for the same reason they are kept apart in
      // the sentence: one of them is about a person.
      ...(problem === 'invalid' ? { forged_approval: true } : { unverifiable_approval: true }),
    });
  };

  /** The line the user gets about an ignored approval, whichever verdict carries it. */
  const ignoredApprovalLine = () => {
    if (!ignoredApprovals.size) return '';
    return [...ignoredApprovals.values()].includes('invalid')
      ? safeT(
        'gate.ask.forged',
        '[OwnMind] 🟡 The AI had an approval on file for this that OwnMind did not issue.\n'
        + '  OwnMind ignored it and is asking you instead.',
      )
      : safeT(
        'gate.ask.unverifiable',
        '[OwnMind] 🟡 There is an approval on file for this and OwnMind cannot tell whether it issued it.\n'
        + '  OwnMind did not use it, and is asking you instead. Re-running the OwnMind update script repairs this.',
      );
  };

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
    const limitApproval = readApprovedAsk(stateDir, sid, guard.id);
    noteIgnoredApproval(guard.id, limitApproval?.problem);
    const hasLimitApproval = Boolean(
      limitApproval && !limitApproval.problem && limitApproval.rec.kind === 'limit'
    );

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
      const approval = readApprovedAsk(stateDir, sid, guard.id);
      noteIgnoredApproval(guard.id, approval?.problem);
      // Defence in depth on top of the seal: the record has to be in the mode the owner
      // configured for THIS guard, not merely in some mode of its own choosing. Before the
      // seal covered `mode`, a planted verbal record walked a code-mode guard straight
      // through the verbal CLI. The seal closes that; this makes it closed twice, and also
      // covers an owner who switches a guard to code mode while a verbal ask is in flight.
      const wantMode = guard.ask_mode === 'verbal' ? 'verbal' : 'code';
      const modeMismatch = Boolean(approval && !approval.problem && approval.rec.mode !== wantMode);
      if (!approval || approval.problem || modeMismatch) {
        const ask = issueAsk(stateDir, sid, guard, 'ask');
        const logEntry = { sessionId: sid, guardId: guard.id, command, kind: 'ask', action: 'block' };
        if (ask.code_issued) logEntry.code_issued = true;
        // A verbal ask logs approval_mode:'verbal' instead of code_issued — never a code.
        if (ask.approval_mode) logEntry.approval_mode = ask.approval_mode;
        if (modeMismatch) logEntry.approval_mode_mismatch = true;
        log(stateDir, logEntry);
        const extra = ignoredApprovalLine();
        // (a) Carry degraded flag in blocks
        return {
          ...ask,
          ...(extra && { userLine: `${ask.userLine}\n${extra}` }),
          ...(globalDegraded && { degraded: 'no-receipts' }),
        };
      }
      // The go-ahead was verbal: mark it so the eventual allow log records the honesty boundary.
      if (approval.rec.approval_mode === 'verbal') verbalApprovalTitle = guard.title || '';
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
  if (verbalApprovalTitle !== null) logEntry.approval_mode = 'verbal';
  log(stateDir, logEntry);

  // Everything the user should hear about an allow, in one line each and never instead of
  // one another. The first version branched — verbal OR degraded OR nothing — so a verbal
  // approval on a turn whose receipts could not be checked told the user about the first and
  // silently dropped the second.
  const allowLines = [
    // A verbal go-ahead is the one approval nothing can verify — no code, no secret, by
    // design. So the only check on it is the user seeing the claim: the assistant says they
    // agreed, and they get to notice if they did not. Writing it to gate-log.jsonl and
    // stopping there would leave the check to somebody who reads log files, which is nobody.
    verbalApprovalTitle !== null
      ? safeT(
        'gate.allow.verbal',
        `[OwnMind] 🟡 The AI said you agreed to 「${verbalApprovalTitle}」, so OwnMind allowed it this once.\n`
        + '  If you did say so, ignore this; if you did not, stop it now.',
        { title: verbalApprovalTitle },
      )
      : '',
    // An approval was found and not used, on a guard that was never going to block anyway.
    // The command still runs; staying quiet about it would put the one event worth noticing
    // on the one path that says nothing.
    ignoredApprovalLine(),
  ].filter(Boolean);

  return {
    action: 'allow',
    ...(allowLines.length && { userLine: allowLines.join('\n') }),
    ...(globalDegraded && { degraded: 'no-receipts' }),
  };
}
