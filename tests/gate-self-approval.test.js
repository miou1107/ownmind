/**
 * The gate, against somebody trying to get past it rather than trying to use it.
 *
 * WHAT WAS MEASURED, 2026-08-15, driving the hook Claude Code actually runs:
 *
 *   1. blocked
 *   2. blocked
 *   3. the assistant writes `{"approved":true}` to gate-ask-<session>-<guard>.json
 *   4. allowed — and the hook says nothing about having been unlocked
 *
 * Being at that path was the whole of the check. Separately, the six-digit consent code was
 * recoverable from the sha256 the gate itself wrote down: 318 ms and 32 ms on two runs, and
 * 0.7 s for a full sweep when re-measured on 2026-08-16. `MAX_ASK_MISSES = 5` never applied,
 * because working the code out costs no wrong guesses — you submit once, and you are right.
 *
 * WHAT IS AND IS NOT CLOSED. The code is now derived with a salted scrypt, so the sweep costs
 * 16.8 hours instead of 0.7 seconds, and a code-mode ask expires in one. That part is shut.
 * The seal on the record is a speed bump, not a wall: `gate.key` is mode 400 and owned by the
 * same uid the assistant runs as, so an assistant determined to forge one can read the key
 * and compute the hmac. It turns a one-line file write into deliberate key theft, and it
 * makes the attempt visible — `forged_approval` in the log, and a line to the user.
 *
 * And a verbal ask has no secret at all, by design. Nothing here can tell whether the user
 * really said "go", which is why the allow now says out loud that the assistant claimed they
 * did. That is the only check on it, so the test for it is the last one in this file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tempDir } from './helpers/temp-dir.js';
import { evaluateGate, approveAction, approveActionVerbal } from '../hooks/lib/action-gate.js';
import { ensureKey, ensureNonce } from '../hooks/lib/gate-receipt.js';

const DEPLOY = 'git push origin ima-v9.9.9';

// The user-facing lines are translated, and this machine's own locale would otherwise decide
// what these assertions are reading. Pinned to English through the documented test seam, the
// same way action-gate-i18n.test.js does it.
const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;
process.env.OWNMIND_LOCALE_FORCE = 'en';
process.on('exit', () => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
});

function stateDir() {
  const dir = tempDir('gate-self-approval-');
  ensureKey(dir);
  ensureNonce(dir, 's1');
  return dir;
}

function guard(over = {}) {
  const text = 'Ask before releasing.';
  return {
    id: 820, kind: 'action', title: 'releases are asked about first', triggers: ['deploy'],
    checks: [], read_required: false, ask_first: true,
    rule_text: text, rules_hash: createHash('sha256').update(text).digest('hex'),
    ...over,
  };
}

const askFile = (dir, sid, id) => path.join(dir, `gate-ask-${sid}-${id}.json`);
const run = (dir, g, sid = 's1') =>
  evaluateGate({ command: DEPLOY, guards: [g], stateDir: dir, sessionId: sid });

// --- The record ---

test('an approval the gate did not issue does not open the gate', () => {
  const dir = stateDir();
  const g = guard({ ask_mode: 'verbal' });
  assert.equal(run(dir, g).kind, 'ask', 'first attempt is blocked');

  // Exactly what was written by hand on 2026-08-15, and exactly what used to work.
  fs.writeFileSync(askFile(dir, 's1', 820),
    JSON.stringify({ v: 2, approved: true, kind: 'ask', mode: 'verbal', approval_mode: 'verbal' }));

  assert.equal(run(dir, g).action, 'block', 'a hand-written approval must not be honoured');
});

test('lifting the seal off the issued record and flipping the flag does not work either', () => {
  const dir = stateDir();
  const g = guard({ ask_mode: 'verbal' });
  run(dir, g);

  // The seal the gate really wrote, on the record it really wrote — with one field changed.
  const issued = JSON.parse(fs.readFileSync(askFile(dir, 's1', 820), 'utf8'));
  assert.ok(issued.seal, 'the issued record carries a seal');
  fs.writeFileSync(askFile(dir, 's1', 820), JSON.stringify({ ...issued, approved: true }));

  assert.equal(run(dir, g).action, 'block', 'the seal has to cover the approval itself');
});

test('a seal from another guard cannot be moved sideways onto this one', () => {
  const dir = stateDir();
  const a = guard({ id: 820, ask_mode: 'verbal' });
  const b = guard({ id: 821, ask_mode: 'verbal' });
  run(dir, a);
  run(dir, b);
  approveActionVerbal(dir, 's1', 821);

  const approvedB = JSON.parse(fs.readFileSync(askFile(dir, 's1', 821), 'utf8'));
  assert.equal(approvedB.approved, true, 'guard 821 really was approved');
  fs.writeFileSync(askFile(dir, 's1', 820), JSON.stringify(approvedB));

  assert.equal(run(dir, a).action, 'block', 'a seal names the guard it was written for');
});

test('a forged approval is recorded, and the user is told rather than the gate going quiet', () => {
  const dir = stateDir();
  const g = guard({ ask_mode: 'verbal' });
  run(dir, g);
  fs.writeFileSync(askFile(dir, 's1', 820),
    JSON.stringify({ v: 2, approved: true, kind: 'ask', mode: 'verbal' }));

  const blocked = run(dir, g);
  assert.equal(blocked.action, 'block');
  assert.match(blocked.userLine, /OwnMind did not issue it/,
    'the user hears that an approval was found and ignored');

  const log = fs.readFileSync(path.join(dir, 'gate-log.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.forged_approval === true),
    'the one entry in this log worth going back for');
});

test('a record from the format a previous version wrote is refused, not honoured', () => {
  const dir = stateDir();
  const g = guard({ ask_mode: 'verbal' });
  run(dir, g);
  // No `v`, no seal — what v1.30.8 and earlier wrote. An upgrade landing mid-approval costs
  // one extra round trip; honouring it would leave the old hole open for the whole window.
  fs.writeFileSync(askFile(dir, 's1', 820),
    JSON.stringify({ approved: true, kind: 'ask', mode: 'verbal', approval_mode: 'verbal' }));
  assert.equal(run(dir, g).action, 'block');
});

// --- The code ---

test('the stored form of the code cannot be swept in a plausible amount of time', () => {
  const dir = stateDir();
  run(dir, guard({ id: 821 }));
  const rec = JSON.parse(fs.readFileSync(askFile(dir, 's1', 821), 'utf8'));

  assert.equal(typeof rec.codeSalt, 'string', 'per-record salt, so one sweep buys one code');
  assert.equal(rec.codeHash.length, 64);

  // The defect, pinned by its own arithmetic: sha256 of the six digits used to BE the stored
  // value, so recovering the code was a loop over 900,000 numbers. Assert it is not that any
  // more without going near what the real derivation costs to run 900,000 times.
  for (let i = 0; i < 3; i += 1) {
    const candidate = String(100000 + i);
    assert.notEqual(createHash('sha256').update(candidate).digest('hex'), rec.codeHash);
    assert.notEqual(createHash('sha256').update(candidate + rec.codeSalt).digest('hex'), rec.codeHash);
  }

  // And one derivation is slow enough that the sweep is hours, not a second. The bound is
  // deliberately loose — this is a floor for CI machines, not the 67 ms measured by hand.
  const started = process.hrtime.bigint();
  approveAction(dir, 's1', 821, '000000');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms > 5, `one code check took ${ms.toFixed(1)} ms — too cheap to be a real KDF`);
});

test('a code-mode ask stops being answerable after its hour', () => {
  const dir = stateDir();
  const g = guard({ id: 821 });
  const ask = run(dir, g);
  const code = ask.userLine.match(/(\d{6})/)[1];

  // Age the record by re-sealing it with an issuedAt from two hours ago. Written through the
  // gate's own approve path first so the seal is genuine, then aged — this is a clock test,
  // not a forgery test, and it must not accidentally become the latter.
  const rec = JSON.parse(fs.readFileSync(askFile(dir, 's1', 821), 'utf8'));
  fs.writeFileSync(askFile(dir, 's1', 821),
    JSON.stringify({ ...rec, issuedAt: Date.now() - 2 * 60 * 60 * 1000 }));

  assert.equal(approveAction(dir, 's1', 821, code), false, 'the right code, too late');
});

test('the ordinary path still works: block, real code, one allow', () => {
  const dir = stateDir();
  const g = guard({ id: 821 });
  const ask = run(dir, g);
  assert.equal(ask.kind, 'ask');
  const code = ask.userLine.match(/(\d{6})/)[1];
  assert.equal(approveAction(dir, 's1', 821, code), true);
  assert.equal(run(dir, g).action, 'allow');
  assert.equal(run(dir, g).kind, 'ask', 'and the approval was one-shot');
});

// --- The verbal go-ahead, which nothing can verify ---

test('an allow granted on a spoken go-ahead says so instead of passing in silence', () => {
  const dir = stateDir();
  const g = guard({ ask_mode: 'verbal' });
  run(dir, g);
  assert.equal(approveActionVerbal(dir, 's1', 820), true);

  const allowed = run(dir, g);
  assert.equal(allowed.action, 'allow');
  assert.match(allowed.userLine, /said you agreed/,
    'the claim is the only check there is, so the user has to see it');
  assert.match(allowed.userLine, /releases are asked about first/,
    'and it has to name which thing they are said to have agreed to');
});

test('an ordinary allow still costs zero words', () => {
  const dir = stateDir();
  const g = guard({ ask_first: false, read_required: false });
  const allowed = run(dir, g);
  assert.equal(allowed.action, 'allow');
  assert.equal(allowed.userLine, undefined, 'silence is the everyday path and must stay free');
});
