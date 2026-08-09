/**
 * v1.19.3 — pure-function tests for the session counter.
 *
 * Maps to openspec/changes/v1.19.3-reply-lint-progressive-block/spec.md
 *   scenarios 7 / 8 / 14.
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
  cleanupStale,
  _resetCounterPathForTests,
} from '../hooks/lib/session-counter.js';

let tmpCounterPath;

beforeEach(() => {
  // Use a per-test temp file to avoid polluting the real ~/.ownmind/logs/.
  tmpCounterPath = path.join(os.tmpdir(), `session-counter-test-${Date.now()}-${Math.random()}.json`);
  _resetCounterPathForTests(tmpCounterPath);
});

afterEach(() => {
  try { fs.unlinkSync(tmpCounterPath); } catch { /* ignore */ }
  _resetCounterPathForTests(null); // restore default
});

describe('v1.19.3 scenario 7 — missing counter file is treated as 0', () => {
  it('readCounter returns 0 for an unknown session', () => {
    const count = readCounter('session-abc');
    assert.equal(count, 0);
  });

  it('incrementCounter writes 1 for an unknown session', () => {
    const newCount = incrementCounter('session-abc');
    assert.equal(newCount, 1);
    assert.equal(readCounter('session-abc'), 1);
  });
});

describe('v1.19.3 scenario 8 — corrupt counter file is treated as 0 and overwritten', () => {
  it('file content is not valid JSON → read returns 0', () => {
    fs.mkdirSync(path.dirname(tmpCounterPath), { recursive: true });
    fs.writeFileSync(tmpCounterPath, 'this is not json {{{');
    const count = readCounter('session-abc');
    assert.equal(count, 0);
  });

  it('after corruption, increment overwrites with a clean file', () => {
    fs.mkdirSync(path.dirname(tmpCounterPath), { recursive: true });
    fs.writeFileSync(tmpCounterPath, 'garbage');
    const newCount = incrementCounter('session-abc');
    assert.equal(newCount, 1);
    // Confirm the file is now valid JSON.
    const parsed = JSON.parse(fs.readFileSync(tmpCounterPath, 'utf8'));
    assert.equal(parsed['session-abc'].count, 1);
  });
});

describe('v1.19.3 scenario 14 — sessions older than 30 days are auto-cleaned', () => {
  it('cleanupStale removes records older than maxAgeMs', () => {
    const now = Date.now();
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000;
    fs.mkdirSync(path.dirname(tmpCounterPath), { recursive: true });
    fs.writeFileSync(tmpCounterPath, JSON.stringify({
      'old-session': { count: 5, last_violation_ts: new Date(now - thirtyOneDaysMs).toISOString(), started_at: new Date(now - thirtyOneDaysMs).toISOString() },
      'fresh-session': { count: 2, last_violation_ts: new Date(now).toISOString(), started_at: new Date(now).toISOString() },
    }));
    cleanupStale(30 * 24 * 60 * 60 * 1000);

    const data = JSON.parse(fs.readFileSync(tmpCounterPath, 'utf8'));
    assert.equal(data['old-session'], undefined, 'old session should be cleared');
    assert.ok(data['fresh-session'], 'fresh session should be retained');
  });

  it('cleanupStale does not throw when the file is missing', () => {
    // Ensure the file is absent.
    try { fs.unlinkSync(tmpCounterPath); } catch { /* ignore */ }
    // Must not throw.
    cleanupStale(30 * 24 * 60 * 60 * 1000);
  });
});

describe('v1.19.3 basic flow', () => {
  it('consecutive increments on the same session accumulate', () => {
    assert.equal(incrementCounter('session-x'), 1);
    assert.equal(incrementCounter('session-x'), 2);
    assert.equal(incrementCounter('session-x'), 3);
    assert.equal(readCounter('session-x'), 3);
  });

  it('different sessions count independently', () => {
    incrementCounter('session-a');
    incrementCounter('session-a');
    incrementCounter('session-b');
    assert.equal(readCounter('session-a'), 2);
    assert.equal(readCounter('session-b'), 1);
  });

  it('after write, last_violation_ts is an ISO8601 string', () => {
    incrementCounter('session-y');
    const data = JSON.parse(fs.readFileSync(tmpCounterPath, 'utf8'));
    assert.match(data['session-y'].last_violation_ts, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('v1.19.3 defensive — write failure must not throw', () => {
  it('writing to an unwritable path: incrementCounter swallows the error and returns 1 or 0, never throws', () => {
    // Was `/root/no-permission/x.json` — unwritable to a normal user on Linux and macOS,
    // and an ordinary creatable directory on Windows. See the note on makeUnwritablePath.
    const target = makeUnwritablePath();
    try {
      _resetCounterPathForTests(target.path);
      // Must not throw.
      let didThrow = false;
      try { incrementCounter('session-z'); }
      catch { didThrow = true; }
      assert.equal(didThrow, false, 'incrementCounter must not throw on write failure');
      assert.equal(fs.existsSync(target.path), false,
        'the write must actually have failed — otherwise this proves nothing');
    } finally {
      target.cleanup();
    }
  });
});
