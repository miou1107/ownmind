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
import { createHash, scryptSync } from 'node:crypto';
import { tempDir } from './helpers/temp-dir.js';
import { evaluateGate, approveAction, approveActionVerbal } from '../hooks/lib/action-gate.js';
import { ensureKey, ensureNonce, sealAsk } from '../hooks/lib/gate-receipt.js';

/** Matches CODE_KDF in action-gate.js. An attacker deriving their own hash uses these too. */
const KDF = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const derive = (code, salt) => scryptSync(String(code), String(salt), 32, KDF).toString('hex');

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
  assert.match(blocked.userLine, /OwnMind did not issue/,
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

// --- The approve path, which used to sign whatever it was handed ---
//
// Review of the first version found the seal was a signing oracle: `approveAction` and
// `approveActionVerbal` read the record with no seal check, then wrote it back THROUGH the
// sealing helper. Four attacks were reproduced, none of which reads `gate.key`, and three of
// which were silent. One test each, because the four fail in four different places.

test('a planted verbal record cannot walk a code-mode guard through the verbal approval', () => {
  const dir = stateDir();
  const g = guard();                      // no ask_mode → the owner left this one in code mode
  run(dir, g);
  fs.writeFileSync(askFile(dir, 's1', 820),
    JSON.stringify({ v: 2, approved: false, kind: 'ask', mode: 'verbal' }));

  assert.equal(approveActionVerbal(dir, 's1', 820), false,
    'the mode it checks must not come out of the record it is being asked to trust');
  assert.equal(run(dir, g).action, 'block');
});

test('a record carrying the attacker\'s own salt and hash is not signed on request', () => {
  const dir = stateDir();
  const g = guard();
  run(dir, g);
  const salt = 'aa'.repeat(16);
  fs.writeFileSync(askFile(dir, 's1', 820), JSON.stringify({
    v: 2, approved: false, kind: 'ask', mode: 'code',
    codeSalt: salt, codeHash: derive('000000', salt), issuedAt: Date.now(),
  }));

  assert.equal(approveAction(dir, 's1', 820, '000000'), false);
  assert.equal(run(dir, g).action, 'block');
  // Deliberately no forgery line here, and that is the right answer: this record never
  // claimed to be an approval. Nothing was bypassed, so there is nobody to accuse — the gate
  // simply declines to sign it and issues a fresh ask. The accusation is reserved for a
  // record that says `approved: true`, which is the case the user needs to hear about.
});

test('the genuine seal does not cover for a swapped code', () => {
  // The quietest of the four: keep the real record and the real seal, change only the two
  // fields that decide which code opens it. The first seal did not cover them.
  const dir = stateDir();
  const g = guard();
  run(dir, g);
  const real = JSON.parse(fs.readFileSync(askFile(dir, 's1', 820), 'utf8'));
  const salt = 'bb'.repeat(16);
  fs.writeFileSync(askFile(dir, 's1', 820),
    JSON.stringify({ ...real, codeSalt: salt, codeHash: derive('111111', salt) }));

  assert.equal(approveAction(dir, 's1', 820, '111111'), false,
    'codeSalt and codeHash have to be inside the seal');
  assert.equal(run(dir, g).action, 'block');
});

test('the burn counter cannot be reset by editing the record', () => {
  const dir = stateDir();
  const g = guard();
  const ask = run(dir, g);
  const code = ask.userLine.match(/(\d{6})/)[1];
  for (let i = 0; i < 5; i += 1) approveAction(dir, 's1', 820, '000000');
  assert.equal(approveAction(dir, 's1', 820, code), false, 'burned');

  const rec = JSON.parse(fs.readFileSync(askFile(dir, 's1', 820), 'utf8'));
  fs.writeFileSync(askFile(dir, 's1', 820), JSON.stringify({ ...rec, misses: 0 }));
  assert.equal(approveAction(dir, 's1', 820, code), false,
    'misses has to be inside the seal too, or MAX_ASK_MISSES is a suggestion');
});

// --- Reporting a forgery, rather than noticing one and dropping it ---

test('a forged record on a guard that never blocks is still recorded and still reported', () => {
  // The single-slot version only ever read this inside the ask_first branch, so a forgery
  // sitting on any other guard was detected and then thrown away, on the allow path, silently.
  const dir = stateDir();
  const g = guard({ ask_first: false });
  run(dir, g);
  fs.writeFileSync(askFile(dir, 's1', 820),
    JSON.stringify({ v: 2, approved: true, kind: 'ask', mode: 'verbal' }));

  const allowed = run(dir, g);
  assert.equal(allowed.action, 'allow', 'this guard was never going to block; the command runs');
  assert.match(allowed.userLine ?? '', /did not issue/,
    'but the one event worth noticing must not be the one nobody is told about');
  const log = fs.readFileSync(path.join(dir, 'gate-log.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.forged_approval === true));
});

test('"OwnMind cannot tell" is not reported as "somebody forged this"', () => {
  // verifyAskSeal answers false when the key or the nonce cannot be read, which is a
  // different fact from a bad seal — and the first version said the accusing sentence for
  // both. Reproduced by deleting the session nonce beside a genuine approval.
  const dir = stateDir();
  const g = guard({ ask_mode: 'verbal' });
  run(dir, g);
  assert.equal(approveActionVerbal(dir, 's1', 820), true);
  fs.unlinkSync(path.join(dir, 'gate-nonce-s1'));

  const blocked = run(dir, g);
  assert.equal(blocked.action, 'block', 'it still refuses — this is about the wording, not the verdict');
  assert.doesNotMatch(blocked.userLine, /did not issue/,
    'a genuine approval must not be called a forgery because the nonce went missing');
  assert.match(blocked.userLine, /cannot tell/);
  const log = fs.readFileSync(path.join(dir, 'gate-log.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.unverifiable_approval === true));
  assert.ok(!log.some((e) => e.forged_approval === true),
    'and the field described as worth going back for stays uncontaminated');
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

  // Age the record and RE-SEAL it, so the only thing wrong with it is its age.
  //
  // The first version of this test rewrote `issuedAt` and left the original seal in place. It
  // passed, but not for the reason it claimed: `issuedAt` is inside the sealed field set, so
  // the record was simply unsealed — and once the approve path started checking seals, this
  // would have gone on passing while the TTL itself could be deleted without turning it red.
  // Review caught it. A test that cannot fail for its own reason is not a test.
  const rec = JSON.parse(fs.readFileSync(askFile(dir, 's1', 821), 'utf8'));
  const aged = { ...rec, issuedAt: Date.now() - 2 * 60 * 60 * 1000 };
  delete aged.seal;
  fs.writeFileSync(askFile(dir, 's1', 821),
    JSON.stringify({ ...aged, seal: sealAsk(dir, 's1', 821, aged) }));

  // The control: the same record, re-sealed and still fresh, must approve. Without it a
  // mistake in the re-sealing above would look exactly like the TTL working.
  const fresh = { ...rec };
  delete fresh.seal;
  assert.equal(
    approveAction(dir, 's1', 821, code), false, 'the right code, too late',
  );
  fs.writeFileSync(askFile(dir, 's1', 821),
    JSON.stringify({ ...fresh, seal: sealAsk(dir, 's1', 821, fresh) }));
  assert.equal(
    approveAction(dir, 's1', 821, code), true,
    're-sealed and inside the hour, the same code must still work — otherwise the test above '
    + 'was measuring the seal, not the clock',
  );
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

test('an ask the gate could not save says so, instead of handing out a dead code', () => {
  // Failing closed is right. Failing closed while looking exactly like working is the pairing
  // this product exists to end: the user was shown a six-digit code that nothing could ever
  // redeem, because the record behind it was never written.
  const dir = stateDir();
  const g = guard();
  fs.chmodSync(dir, 0o500);           // readable, not writable
  try {
    const blocked = run(dir, g);
    assert.equal(blocked.action, 'block', 'still refuses, which was never in doubt');
    assert.match(blocked.userLine, /could not save this approval/,
      'and now says that answering will not help');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test('a verbal record cannot satisfy a guard its owner moved to code mode', () => {
  // The seal already stops a planted record. This is the other half: an ask issued while the
  // guard was verbal, still sitting there after the owner switched the guard to code mode.
  // Genuine record, genuine seal, wrong kind of consent for the rule as it stands now.
  const dir = stateDir();
  run(dir, guard({ ask_mode: 'verbal' }));
  assert.equal(approveActionVerbal(dir, 's1', 820), true);

  const nowCodeMode = guard();       // same id, ask_mode removed
  const blocked = run(dir, nowCodeMode);
  assert.equal(blocked.action, 'block', 'a spoken go must not carry a rule the owner tightened');
  assert.match(blocked.userLine, /\d{6}/, 'and the user is asked again, in the mode now configured');
});

test('an ordinary allow still costs zero words', () => {
  const dir = stateDir();
  const g = guard({ ask_first: false, read_required: false });
  const allowed = run(dir, g);
  assert.equal(allowed.action, 'allow');
  assert.equal(allowed.userLine, undefined, 'silence is the everyday path and must stay free');
});
