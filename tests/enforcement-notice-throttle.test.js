import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decideNotice, _statePathForTests } from '../hooks/lib/notice-throttle.js';
import { tempDir } from './helpers/temp-dir.js';

/**
 * Throttling for the recurring "this turn was NOT checked" notices (v1.26.171, Vin's call).
 *
 * The alternative was a line under every reply for the whole length of an outage — loud
 * enough that the rational user response is to switch the product off, which is a worse
 * failure than the outage. The rule chosen: speak on every state CHANGE (including
 * recovery), and while the same state persists, repeat every 10th turn. Silence in between
 * is safe because the state was announced when it began — it never impersonates a pass.
 *
 * Event-shaped notices (a violation pushed back, the cap reached, the lint banner) are not
 * throttled and never pass through here.
 */

let dir;
beforeEach(() => {
  dir = tempDir('om-throttle-');
  _statePathForTests(path.join(dir, 'notice-throttle.json'));
});

test('the first occurrence of a state speaks', () => {
  assert.equal(decideNotice('s1', 'not-checked:backoff'), true);
});

test('the same state stays quiet on the turns in between', () => {
  decideNotice('s1', 'not-checked:backoff');
  for (let i = 0; i < 8; i += 1) {
    assert.equal(decideNotice('s1', 'not-checked:backoff'), false, `turn ${i + 2} must be quiet`);
  }
});

test('the 10th consecutive turn in the same state speaks again', () => {
  decideNotice('s1', 'not-checked:backoff');
  for (let i = 0; i < 8; i += 1) decideNotice('s1', 'not-checked:backoff');
  assert.equal(decideNotice('s1', 'not-checked:backoff'), true, 'the 10th turn is the reminder');
});

test('a different state speaks immediately', () => {
  decideNotice('s1', 'not-checked:backoff');
  assert.equal(decideNotice('s1', 'not-checked:no-credentials'), true);
});

test('recovery speaks exactly once', () => {
  decideNotice('s1', 'not-checked:backoff');
  assert.equal(decideNotice('s1', null), true, 'the all-clear must be announced');
  assert.equal(decideNotice('s1', null), false, 'a healthy turn after a healthy turn is silent');
});

test('a healthy session never speaks', () => {
  assert.equal(decideNotice('s1', null), false);
});

test('sessions do not share state', () => {
  decideNotice('s1', 'not-checked:backoff');
  assert.equal(decideNotice('s2', 'not-checked:backoff'), true);
});

test('a corrupt state file behaves like a fresh one rather than throwing', () => {
  fs.writeFileSync(path.join(dir, 'notice-throttle.json'), '{not json');
  assert.equal(decideNotice('s1', 'not-checked:backoff'), true);
});
