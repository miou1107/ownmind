/**
 * v1.19.7 — pure-function tests for session-counter block_count.
 *
 * Maps to openspec/changes/v1.20-iron-rule-enforcement/spec.md scenario 16,
 * and tasks.md v1.19.7 "reply-lint hook switches to block mode (exit 2) +
 * downgrades to warning after 3 consecutive violations".
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeUnwritablePath } from './helpers/unwritable-path.js';

import {
  readCounter,
  incrementCounter,
  readBlockCount,
  incrementBlockCount,
  resetBlockCount,
  _resetCounterPathForTests,
} from '../hooks/lib/session-counter.js';

let tmpCounterPath;

beforeEach(() => {
  tmpCounterPath = path.join(
    os.tmpdir(),
    `session-counter-block-test-${Date.now()}-${Math.random()}.json`
  );
  _resetCounterPathForTests(tmpCounterPath);
});

afterEach(() => {
  try { fs.unlinkSync(tmpCounterPath); } catch { /* ignore */ }
  _resetCounterPathForTests(null);
});

describe('v1.19.7 — readBlockCount', () => {
  it('non-existent session returns 0', () => {
    assert.equal(readBlockCount('s1'), 0);
  });

  it('reads correctly after increment', () => {
    incrementBlockCount('s1');
    incrementBlockCount('s1');
    assert.equal(readBlockCount('s1'), 2);
  });

  it('corrupt file → treated as 0, no throw', () => {
    fs.mkdirSync(path.dirname(tmpCounterPath), { recursive: true });
    fs.writeFileSync(tmpCounterPath, '!!! not json');
    assert.equal(readBlockCount('s1'), 0);
  });

  it('non-string sessionId → returns 0, no throw', () => {
    assert.equal(readBlockCount(null), 0);
    assert.equal(readBlockCount(42), 0);
    assert.equal(readBlockCount(undefined), 0);
  });
});

describe('v1.19.7 — incrementBlockCount', () => {
  it('non-existent session → creates file, block_count=1', () => {
    const v = incrementBlockCount('s1');
    assert.equal(v, 1);
    const data = JSON.parse(fs.readFileSync(tmpCounterPath, 'utf8'));
    assert.equal(data.s1.block_count, 1);
    assert.equal(data.s1.count, 0);
    assert.ok(data.s1.started_at);
    assert.match(data.s1.last_block_ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('consecutive increments accumulate', () => {
    assert.equal(incrementBlockCount('s1'), 1);
    assert.equal(incrementBlockCount('s1'), 2);
    assert.equal(incrementBlockCount('s1'), 3);
  });

  it('existing session (has count, no block_count) → safely adds block_count field', () => {
    // Simulate legacy data upgraded from v1.19.6 without block_count.
    fs.mkdirSync(path.dirname(tmpCounterPath), { recursive: true });
    fs.writeFileSync(
      tmpCounterPath,
      JSON.stringify({
        s1: {
          count: 5,
          last_violation_ts: '2026-05-22T00:00:00.000Z',
          started_at: '2026-05-22T00:00:00.000Z',
        },
      })
    );
    const v = incrementBlockCount('s1');
    assert.equal(v, 1);
    const data = JSON.parse(fs.readFileSync(tmpCounterPath, 'utf8'));
    assert.equal(data.s1.count, 5, 'must not touch violation count');
    assert.equal(data.s1.block_count, 1);
  });

  it('incrementing block does not affect violation count (incrementCounter and incrementBlockCount are independent)', () => {
    incrementCounter('s1');
    incrementCounter('s1');
    incrementBlockCount('s1');
    assert.equal(readCounter('s1'), 2);
    assert.equal(readBlockCount('s1'), 1);
  });

  it('different sessions count independently', () => {
    incrementBlockCount('a');
    incrementBlockCount('b');
    incrementBlockCount('b');
    assert.equal(readBlockCount('a'), 1);
    assert.equal(readBlockCount('b'), 2);
  });

  it('non-string sessionId → returns 0, no throw, no write', () => {
    assert.equal(incrementBlockCount(null), 0);
    assert.equal(fs.existsSync(tmpCounterPath), false);
  });
});

describe('v1.19.7 — resetBlockCount', () => {
  it('clears existing block_count (leaves violation count alone)', () => {
    incrementCounter('s1');
    incrementCounter('s1');
    incrementBlockCount('s1');
    incrementBlockCount('s1');
    resetBlockCount('s1');
    assert.equal(readBlockCount('s1'), 0);
    assert.equal(readCounter('s1'), 2, 'must not touch violation count');
  });

  it('non-existent session → noop, no throw', () => {
    resetBlockCount('nonexistent');
  });

  it('block_count already 0 → noop, no write (avoid pointless writes)', () => {
    incrementCounter('s1'); // creates file but block_count is absent
    const before = fs.statSync(tmpCounterPath).mtimeMs;
    // Wait at least 1ms so the timestamp would change if a write happened.
    const wait = Date.now() + 5;
    while (Date.now() < wait) { /* spin */ }
    resetBlockCount('s1');
    const after = fs.statSync(tmpCounterPath).mtimeMs;
    assert.equal(after, before, 'reset must not trigger a write when block_count=0');
  });

  it('non-string sessionId → noop, no throw', () => {
    resetBlockCount(null);
    resetBlockCount(123);
  });
});

describe('v1.19.7 — defensive: write failure must not throw', () => {
  it('writing to an unwritable path: incrementBlockCount must not throw', () => {
    // Was `/root/cannot-write/x.json`, which Windows happily created and wrote — so this
    // assertion was satisfied by the success path and never entered the failure path it
    // is named after. See the note on makeUnwritablePath.
    const target = makeUnwritablePath();
    try {
      _resetCounterPathForTests(target.path);
      let didThrow = false;
      try { incrementBlockCount('s1'); } catch { didThrow = true; }
      assert.equal(didThrow, false);
      assert.equal(fs.existsSync(target.path), false,
        'the write must actually have failed — otherwise this proves nothing');
    } finally {
      target.cleanup();
    }
  });
});
