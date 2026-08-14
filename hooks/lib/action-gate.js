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
    const regex = new RegExp(pattern);
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
 * sessionId is trusted from the harness only. It is embedded in state file
 * names, so anything outside this set (e.g. a "/" from "../") could steer
 * state paths outside the state directory.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function log(stateDir, entry) {
  try { fs.appendFileSync(logPath(stateDir), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); }
  catch { /* the log must never take the gate down */ }
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
  // The code is a consent secret, not a label: use a CSPRNG, not Math.random.
  const code = String(randomInt(100000, 1000000));
  try {
    fs.writeFileSync(askPath(stateDir, sid, guard.id),
      JSON.stringify({ codeHash: createHash('sha256').update(code).digest('hex'), approved: false }));
  } catch { /* without the file the approve step fails closed */ }
  return {
    action: 'block', kind: kindLabel, guardId: guard.id,
    reason: `[OwnMind gate] "${guard.title}" needs the user's explicit go for this action. `
      + 'Ask the user for the 6-digit approval code shown on their screen, then run: '
      + `node ~/.ownmind/hooks/lib/approve-action.js ${guard.id} <code> — and retry the command.`,
    userLine: `[OwnMind] ⛔ "${guard.title}" wants your approval for: ${kindLabel === 'limit' ? 'a command blocked 3 times in a row' : 'this action'}. Approval code: ${code} (paste it to the AI to allow it once)`,
    code_issued: true,
  };
}

export function approveAction(stateDir, sessionId, guardId, code) {
  // I4: Apply same sessionId sanitization and validate guardId
  const sid = typeof sessionId === 'string' && SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : 'unknown';
  if (!Number.isInteger(guardId) || guardId <= 0) return false;

  const p = askPath(stateDir, sid, guardId);
  const rec = readJson(p);
  if (!rec || rec.approved) return false;
  if (createHash('sha256').update(String(code)).digest('hex') !== rec.codeHash) return false;
  try { fs.writeFileSync(p, JSON.stringify({ ...rec, approved: true })); } catch { return false; }
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
  let degradedRead = false;

  // I2: Evaluate all guards first, collect verdicts, defer approval consumption
  const approvalsToConsume = [];

  for (const guard of matched) {
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
            return ask;
          }
          const logEntry = { sessionId: sid, guardId: guard.id, command, kind: 'read', action: 'block' };
          log(stateDir, logEntry);
          return {
            action: 'block', kind: 'read', guardId: guard.id,
            reason: `[OwnMind gate] Read this rule before acting, then retry the command:\n--- RULE ${guard.id}: ${guard.title} ---\n${guard.rule_text}`,
          };
        }
      }
    }

    // Checks still run (stateless) even with receipt degradation
    // I1: Check if there's a redeemable limit approval first
    const hasLimitApproval = (() => {
      const p = askPath(stateDir, sid, guard.id);
      const rec = readJson(p);
      return rec && rec.approved === true;
    })();

    if (hasLimitApproval) {
      // Defer consumption until all guards pass
      approvalsToConsume.push(guard.id);
      // Clear counter for this guard
      clearLimit(stateDir, sid, guard.id);
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
          return ask;
        }
        const logEntry = { sessionId: sid, guardId: guard.id, command, kind: 'check', action: 'block' };
        log(stateDir, logEntry);
        return {
          action: 'block', kind: 'check', guardId: guard.id,
          reason: `[OwnMind gate] The command violates "${guard.title}": ${c.reason}. Fix the command and retry.`,
          ...(degradedRead && { degraded: 'no-receipts' }),
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
        log(stateDir, logEntry);
        return ask;
      }
      // Defer consumption until all guards pass
      approvalsToConsume.push(guard.id);
    }

    // Guard passed all gates
    clearLimit(stateDir, sid, guard.id);
  }

  // All guards passed: now consume deferred approvals
  for (const guardId of approvalsToConsume) {
    consumeApproval(stateDir, sid, guardId);
  }

  // Log and return allow
  log(stateDir, { sessionId: sid, command, action: 'allow', ...(degradedRead && { degraded: 'no-receipts' }) });
  return { action: 'allow', ...(degradedRead && { degraded: 'no-receipts' }) };
}
