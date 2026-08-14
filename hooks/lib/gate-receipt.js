import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

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
  fs.writeFileSync(receiptPath(stateDir, sessionId, guard.id), JSON.stringify({
    ruleId: guard.id, rulesHash: guard.rules_hash, hmac: sign(stateDir, sessionId, guard),
  }));
}

export function verifyReceipt(stateDir, sessionId, guard) {
  const p = receiptPath(stateDir, sessionId, guard.id);
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return false;
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (rec.rulesHash !== guard.rules_hash) return false;
    return rec.hmac === sign(stateDir, sessionId, guard);
  } catch {
    return false;
  }
}
