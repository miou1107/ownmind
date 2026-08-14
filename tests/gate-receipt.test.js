import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
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
