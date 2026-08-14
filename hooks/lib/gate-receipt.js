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
