import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { tempDir } from './helpers/temp-dir.js';
import {
  ensureKey, ensureNonce, writeReceipt, verifyReceipt,
} from '../hooks/lib/gate-receipt.js';

test('a receipt written by the gate verifies, and binds to the rule content', () => {
  const dir = tempDir('gate-r-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  const guard = { id: 918, rule_text: 'text', rules_hash: 'aaa' };
  writeReceipt(dir, 's1', guard);
  assert.equal(verifyReceipt(dir, 's1', guard), true);
  assert.equal(verifyReceipt(dir, 's1', { ...guard, rules_hash: 'bbb' }), false, 'edited rule invalidates the receipt');
  assert.equal(verifyReceipt(dir, 's2', guard), false, 'another session cannot replay it');
});

test('a hand-written receipt is rejected', () => {
  const dir = tempDir('gate-f-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  const guard = { id: 918, rule_text: 'text', rules_hash: 'aaa' };
  fs.writeFileSync(path.join(dir, 'gate-receipt-s1-918.json'),
    JSON.stringify({ ruleId: 918, rulesHash: 'aaa', hmac: 'deadbeef' }));
  assert.equal(verifyReceipt(dir, 's1', guard), false);
});

test('ensureKey is idempotent: two consecutive calls succeed and preserve key bytes', () => {
  const dir = tempDir('gate-idem-');
  ensureKey(dir);
  const keyPath = path.join(dir, 'gate.key');
  const firstKey = fs.readFileSync(keyPath, 'utf8');

  // Second call should succeed without throwing, even though file is mode 0400
  ensureKey(dir);
  const secondKey = fs.readFileSync(keyPath, 'utf8');

  assert.equal(firstKey, secondKey, 'key bytes unchanged after second ensureKey call');
});

test('verifyReceipt returns false for missing key file (never throws)', () => {
  const dir = tempDir('gate-nokey-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  const guard = { id: 918, rule_text: 'text', rules_hash: 'aaa' };
  writeReceipt(dir, 's1', guard);

  // Remove the key file
  fs.unlinkSync(path.join(dir, 'gate.key'));

  // verifyReceipt should return false, not throw
  assert.equal(verifyReceipt(dir, 's1', guard), false);
});

test('verifyReceipt returns false for missing nonce (never throws)', () => {
  const dir = tempDir('gate-nononce-');
  ensureKey(dir);
  const guard = { id: 918, rule_text: 'text', rules_hash: 'aaa' };

  // Try to verify without creating nonce
  assert.equal(verifyReceipt(dir, 's1', guard), false);
});

test('verifyReceipt returns false when receipt path is a symlink (never throws)', () => {
  const dir = tempDir('gate-symlink-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  const guard = { id: 918, rule_text: 'text', rules_hash: 'aaa' };
  writeReceipt(dir, 's1', guard);

  // Replace receipt with a symlink
  const receiptPath = path.join(dir, 'gate-receipt-s1-918.json');
  fs.unlinkSync(receiptPath);
  fs.symlinkSync('/etc/passwd', receiptPath);

  // verifyReceipt should return false for a symlink
  assert.equal(verifyReceipt(dir, 's1', guard), false);
});

// --- FORGERY red-team (Task 9): the five prototype attacks, ported as tests ---
// Ported from docs/superpowers/specs/2026-08-14-action-gate-prototype/evidence.md § D.
// Every one must verify false. A `true` here is a Critical break, not a test to relax.

// FORGERY 1 — hand-written receipt with a fabricated hmac. Already covered above by
// 'a hand-written receipt is rejected'; the symlink case (FORGERY 4) is covered by
// 'verifyReceipt returns false when receipt path is a symlink'. The three below are new.

test('FORGERY 2: a valid receipt replayed from another session is rejected', () => {
  // Same machine (shared gate.key), two sessions with different nonces. The attacker copies
  // the victim session's genuinely valid receipt bytes into their own session's receipt path.
  const dir = tempDir('gate-replay-');
  ensureKey(dir);
  ensureNonce(dir, 's-victim');
  ensureNonce(dir, 's-attacker');
  const guard = { id: 918, rule_text: 'text', rules_hash: 'aaa' };

  writeReceipt(dir, 's-victim', guard);
  assert.equal(verifyReceipt(dir, 's-victim', guard), true, 'the victim receipt is valid in its own session');

  const victimBytes = fs.readFileSync(path.join(dir, 'gate-receipt-s-victim-918.json'));
  fs.writeFileSync(path.join(dir, 'gate-receipt-s-attacker-918.json'), victimBytes);
  assert.equal(
    verifyReceipt(dir, 's-attacker', guard), false,
    'a receipt bound to another session nonce must not replay'
  );
});

test('FORGERY 3: a receipt for tampered-then-repinned rule content is rejected', () => {
  // The old receipt binds the rule CONTENT hash; even a trusted re-pin of weakened content
  // (nonce unchanged) leaves the old receipt covering content that no longer exists.
  const dir = tempDir('gate-tamper-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  const original = { id: 918, rule_text: 'orig', rules_hash: 'hash-original' };
  writeReceipt(dir, 's1', original);
  assert.equal(verifyReceipt(dir, 's1', original), true);

  const tampered = { id: 918, rule_text: 'weakened', rules_hash: 'hash-tampered' };
  assert.equal(
    verifyReceipt(dir, 's1', tampered), false,
    'a receipt does not cover rule content changed after it was pinned'
  );
});

test('FORGERY 5: an hmac computed with a guessed key is rejected', () => {
  // The attacker knows the exact signed material (sessionId:id:rules_hash:nonce) but not the
  // key, and signs it with a guessed key. Only the real gate.key can produce a valid hmac.
  const dir = tempDir('gate-guesskey-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  const guard = { id: 918, rule_text: 'text', rules_hash: 'aaa' };
  const nonce = fs.readFileSync(path.join(dir, 'gate-nonce-s1'), 'utf8');

  const forged = createHmac('sha256', 'not-the-real-key')
    .update(`s1:918:aaa:${nonce}`).digest('hex');
  fs.writeFileSync(path.join(dir, 'gate-receipt-s1-918.json'),
    JSON.stringify({ ruleId: 918, rulesHash: 'aaa', hmac: forged }));
  assert.equal(verifyReceipt(dir, 's1', guard), false);
});

// --- Deferred hardening (Task 9 § C) ---

test('HARDENING: writeReceipt refuses to write through a pre-planted symlink', () => {
  // An attacker pre-plants a symlink at the receipt path pointing at a file they want the
  // gate to overwrite. writeReceipt must lstat and unlink the link, then write a real file.
  const dir = tempDir('gate-wsym-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  const guard = { id: 918, rule_text: 'text', rules_hash: 'aaa' };

  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'precious');
  const receiptPath = path.join(dir, 'gate-receipt-s1-918.json');
  fs.symlinkSync(victim, receiptPath);

  writeReceipt(dir, 's1', guard);

  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious', 'the symlink target must be untouched');
  assert.equal(fs.lstatSync(receiptPath).isSymbolicLink(), false, 'the planted link is replaced by a real file');
  assert.equal(verifyReceipt(dir, 's1', guard), true, 'the real receipt written in its place verifies');
});

test('HARDENING: verifyReceipt is total — a malformed guard returns false, never throws', () => {
  const dir = tempDir('gate-total-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  assert.equal(verifyReceipt(dir, 's1', undefined), false);
  assert.equal(verifyReceipt(dir, 's1', null), false);
  assert.equal(verifyReceipt(dir, 's1', {}), false, 'missing id and rules_hash');
  assert.equal(verifyReceipt(dir, 's1', { id: 918 }), false, 'missing rules_hash');
});

test('HARDENING: verifyReceipt rejects a wrong-length hmac without throwing', () => {
  // timingSafeEqual throws on unequal-length buffers; the length guard must catch it first.
  const dir = tempDir('gate-len-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  const guard = { id: 918, rule_text: 'text', rules_hash: 'aaa' };
  fs.writeFileSync(path.join(dir, 'gate-receipt-s1-918.json'),
    JSON.stringify({ ruleId: 918, rulesHash: 'aaa', hmac: 'ab' }));
  assert.equal(verifyReceipt(dir, 's1', guard), false);
});
