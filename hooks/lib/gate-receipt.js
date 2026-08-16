import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const keyPath = (d) => path.join(d, 'gate.key');
const noncePath = (d, sid) => path.join(d, `gate-nonce-${sid}`);
const receiptPath = (d, sid, id) => path.join(d, `gate-receipt-${sid}-${id}.json`);

export function ensureKey(stateDir) {
  const p = keyPath(stateDir);
  if (fs.existsSync(p)) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(p, randomBytes(32).toString('hex'), { mode: 0o400 });
}

export function ensureNonce(stateDir, sessionId) {
  const p = noncePath(stateDir, sessionId);
  try { return fs.readFileSync(p, 'utf8'); } catch { /* create below */ }
  const nonce = randomBytes(16).toString('hex');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(p, nonce);
  return nonce;
}

function sign(stateDir, sessionId, guard) {
  const key = fs.readFileSync(keyPath(stateDir), 'utf8');
  const nonce = fs.readFileSync(noncePath(stateDir, sessionId), 'utf8');
  return createHmac('sha256', key)
    .update(`${sessionId}:${guard.id}:${guard.rules_hash}:${nonce}`)
    .digest('hex');
}

export function writeReceipt(stateDir, sessionId, guard) {
  const p = receiptPath(stateDir, sessionId, guard.id);
  // Write-side symlink defense: an attacker who pre-plants a symlink at the receipt path
  // could otherwise redirect this write through it onto a file of their choosing. Unlink the
  // link first (never its target) so we always write a real file in the state dir.
  try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* absent is the normal case */ }
  fs.writeFileSync(p, JSON.stringify({
    ruleId: guard.id, rulesHash: guard.rules_hash, hmac: sign(stateDir, sessionId, guard),
  }));
}

/**
 * Seal an approval record, so the gate can tell a record it issued from one somebody wrote.
 *
 * Measured 2026-08-15: an assistant that wanted past a blocking guard did not need the code
 * at all — writing `{"approved":true}` to `gate-ask-<session>-<guard>.json` was enough, and
 * the gate honoured it. Nothing in the record said where it came from.
 *
 * The seal covers the approval state itself, not just the record's identity: lifting the
 * seal off the issued (unapproved) record and flipping the flag has to fail too. It also
 * covers the session and the guard, so a seal cannot be moved sideways onto another block.
 *
 * WHAT THIS DOES NOT DO. `gate.key` is mode 400 and owned by the same uid the assistant runs
 * as, so an assistant determined to forge one can read the key and compute this. This turns
 * a one-line file write into deliberate, several-step key theft; it does not make it
 * impossible, and it is not sold as if it did. What makes the code path genuinely safe is
 * that the code is no longer recoverable from the record — see CODE_KDF in action-gate.js.
 *
 * Lazy provisioning on purpose: callers reach this from several entry points (the gate, the
 * approve CLI, tests) and only one of them provisions up front.
 *
 * @returns {string} hex hmac
 */
export function sealAsk(stateDir, sessionId, guardId, rec) {
  ensureKey(stateDir);
  const nonce = ensureNonce(stateDir, sessionId);
  const key = fs.readFileSync(keyPath(stateDir), 'utf8');
  return createHmac('sha256', key)
    .update([
      sessionId, guardId, rec.mode ?? '', rec.kind ?? '',
      rec.approved === true ? '1' : '0', rec.approval_mode ?? '',
      rec.issuedAt ?? '', nonce,
    ].join(':'))
    .digest('hex');
}

/**
 * True only when this record carries the seal this machine would have written for it.
 *
 * Total by contract: an unreadable key, a missing nonce, a truncated seal and a record with
 * no seal at all are all false. Never a throw — a caller treating this as "cannot tell" and
 * allowing would be the fail-open this exists to close.
 */
export function verifyAskSeal(stateDir, sessionId, guardId, rec) {
  try {
    if (!rec || typeof rec.seal !== 'string' || !rec.seal) return false;
    const got = Buffer.from(rec.seal, 'hex');
    const want = Buffer.from(sealAsk(stateDir, sessionId, guardId, rec), 'hex');
    if (got.length === 0 || got.length !== want.length) return false;
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

export function verifyReceipt(stateDir, sessionId, guard) {
  // Total by contract: a malformed guard (missing id or rules_hash) is a false, never a throw.
  // Callers treat a throw as a degraded receipt subsystem, so a bad argument must not masquerade
  // as an outage.
  try {
    if (!guard || guard.id === undefined || guard.id === null) return false;
    if (typeof guard.rules_hash !== 'string') return false;
    const p = receiptPath(stateDir, sessionId, guard.id);
    if (fs.lstatSync(p).isSymbolicLink()) return false;
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof rec.rulesHash !== 'string' || rec.rulesHash !== guard.rules_hash) return false;
    if (typeof rec.hmac !== 'string') return false;
    // Constant-time comparison with a length guard: timingSafeEqual throws on unequal-length
    // buffers, so mismatched lengths (a truncated or garbage hmac) are rejected up front.
    const got = Buffer.from(rec.hmac, 'hex');
    const want = Buffer.from(sign(stateDir, sessionId, guard), 'hex');
    if (got.length === 0 || got.length !== want.length) return false;
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
