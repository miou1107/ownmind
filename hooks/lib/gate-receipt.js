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
 * Every field of an ask record that the seal covers. Order is part of the signed value.
 *
 * The first version signed only the record's identity and its approval state. Review found
 * three ways past that, all of them without reading `gate.key` — and the worst was the
 * quietest: leave the genuine seal untouched, swap `codeSalt` and `codeHash` for a pair you
 * generated, and the gate accepts your code as if it had issued it. `misses` was outside the
 * seal too, so the burn counter could simply be reset.
 *
 * The rule this list encodes: if changing a field changes who may open the gate, the seal
 * covers it.
 */
const SEALED_FIELDS = [
  'v', 'mode', 'kind', 'approved', 'approval_mode', 'issuedAt',
  'codeSalt', 'codeHash', 'misses',
];

/** Domain separator, so a seal can never be mistaken for one over some other structure. */
const SEAL_DOMAIN = 'ownmind-gate-ask-v2';

/**
 * The exact bytes signed.
 *
 * `JSON.stringify` of an array rather than a delimiter join: every string it emits is quoted
 * and escaped, so no field value can impersonate the boundary between two fields. The joined
 * form was ambiguous the moment the list grew to include values a record's author chooses.
 */
function sealedPayload(sessionId, guardId, rec, nonce) {
  return JSON.stringify([
    SEAL_DOMAIN, String(sessionId), String(guardId), nonce,
    ...SEALED_FIELDS.map((f) => (rec?.[f] === undefined ? null : rec[f])),
  ]);
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
 * Provisions on purpose: this is the ISSUING side, and a first ask on a fresh machine has no
 * key or nonce yet. Verification deliberately does not provision — see readSealInputs.
 *
 * @returns {string} hex hmac
 */
export function sealAsk(stateDir, sessionId, guardId, rec) {
  ensureKey(stateDir);
  const nonce = ensureNonce(stateDir, sessionId);
  const key = fs.readFileSync(keyPath(stateDir), 'utf8');
  return createHmac('sha256', key)
    .update(sealedPayload(sessionId, guardId, rec, nonce))
    .digest('hex');
}

/**
 * Key and nonce as they already are on disk. Throws if either is missing.
 *
 * Deliberately not `ensureNonce`. Creating a nonce here would turn "this session's nonce is
 * gone, so nothing can be checked" into "the seal does not match" — reported to the user as
 * `OwnMind did not issue it`, which is an accusation, about a record that may be perfectly
 * genuine. Measured: deleting the nonce beside a real approval produced exactly that.
 */
function readSealInputs(stateDir, sessionId) {
  return {
    key: fs.readFileSync(keyPath(stateDir), 'utf8'),
    nonce: fs.readFileSync(noncePath(stateDir, sessionId), 'utf8'),
  };
}

/**
 * What this machine can say about a record's seal. Three answers, not two.
 *
 * - `valid` — this machine wrote it.
 * - `invalid` — this machine did not write it. An accusation, and only said when earned.
 * - `unverifiable` — the key or the nonce is unreadable, so nothing can be told either way.
 *
 * Only `valid` may open the gate; the caller refuses on the other two alike. The split
 * exists so the SENTENCE differs, because "somebody forged this" and "OwnMind cannot check"
 * are different facts and only one of them is about a person.
 *
 * Total by contract: never throws. A caller treating a throw as "cannot tell, allow anyway"
 * would be the fail-open this whole mechanism exists to close.
 *
 * @returns {'valid'|'invalid'|'unverifiable'}
 */
export function verifyAskSeal(stateDir, sessionId, guardId, rec) {
  if (!rec || typeof rec.seal !== 'string' || !rec.seal) return 'invalid';
  let inputs;
  try {
    inputs = readSealInputs(stateDir, sessionId);
  } catch {
    return 'unverifiable';
  }
  try {
    const want = createHmac('sha256', inputs.key)
      .update(sealedPayload(sessionId, guardId, rec, inputs.nonce))
      .digest('hex');
    const got = Buffer.from(rec.seal, 'hex');
    const expected = Buffer.from(want, 'hex');
    if (got.length === 0 || got.length !== expected.length) return 'invalid';
    return timingSafeEqual(got, expected) ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
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
