import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readSessionOffState,
  writeSessionOffState,
  clearSessionOffState,
  incrementTickCount,
  isOff,
} from '../shared/session-off-state.js';

const TMP_FILE = path.join(os.tmpdir(), `ownmind-test-session-off-${process.pid}.json`);

describe('v1.20.3 session-off-state', () => {
  before(() => {
    process.env.__OWNMIND_SESSION_OFF_PATH = TMP_FILE;
  });

  after(() => {
    if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
    delete process.env.__OWNMIND_SESSION_OFF_PATH;
  });

  beforeEach(() => {
    if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
  });

  describe('read / write / clear', () => {
    it('file does not exist → readSessionOffState returns null', () => {
      assert.equal(readSessionOffState(), null);
    });

    it('writeSessionOffState writes + readSessionOffState reads back consistently', () => {
      const ok = writeSessionOffState('S1');
      assert.equal(ok, true);
      const state = readSessionOffState();
      assert.equal(state.session_id, 'S1');
      assert.equal(state.tick_count, 0);
      assert.ok(typeof state.off_at === 'string');
    });

    it('rewriting the same session_id → tick_count preserved', () => {
      writeSessionOffState('S1');
      incrementTickCount();
      incrementTickCount();
      assert.equal(readSessionOffState().tick_count, 2);
      writeSessionOffState('S1');
      assert.equal(readSessionOffState().tick_count, 2,
        '同 session_id 再寫應保留 tick_count');
    });

    it('writing a different session_id → tick_count resets to zero', () => {
      writeSessionOffState('S1');
      incrementTickCount();
      incrementTickCount();
      writeSessionOffState('S2');
      assert.equal(readSessionOffState().tick_count, 0);
    });

    it('reads back null after clearSessionOffState', () => {
      writeSessionOffState('S1');
      assert.equal(clearSessionOffState(), true);
      assert.equal(readSessionOffState(), null);
    });

    it('corrupted file (non-JSON) → readSessionOffState returns null without crashing', () => {
      fs.writeFileSync(TMP_FILE, 'not-a-json{{{');
      assert.equal(readSessionOffState(), null);
    });

    it('file missing fields → readSessionOffState returns null', () => {
      fs.writeFileSync(TMP_FILE, JSON.stringify({ session_id: 'S1' })); // missing off_at / tick_count
      assert.equal(readSessionOffState(), null);
    });

    it('writeSessionOffState with empty-string session_id → returns false, no write', () => {
      assert.equal(writeSessionOffState(''), false);
      assert.equal(readSessionOffState(), null);
    });
  });

  describe('incrementTickCount', () => {
    it('no state file → returns 0, does not create', () => {
      assert.equal(incrementTickCount(), 0);
      assert.equal(readSessionOffState(), null);
    });

    it('state file exists → +1 per call', () => {
      writeSessionOffState('S1');
      assert.equal(incrementTickCount(), 1);
      assert.equal(incrementTickCount(), 2);
      assert.equal(incrementTickCount(), 3);
      assert.equal(readSessionOffState().tick_count, 3);
    });
  });

  describe('isOff (shared by Stop hook + pre-commit hook)', () => {
    it('no state file → false', () => {
      assert.equal(isOff(), false);
    });

    it('just written (off_at is now) → true', () => {
      writeSessionOffState('S1');
      assert.equal(isOff(), true);
    });

    it('off_at is 25 hours ago (expired) → false and auto-cleared', () => {
      const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(TMP_FILE, JSON.stringify({
        session_id: 'S1',
        off_at: expired,
        tick_count: 0,
      }));
      assert.equal(isOff(), false);
      assert.equal(readSessionOffState(), null);
    });

    it('off_at cannot be parsed → false and auto-cleared', () => {
      fs.writeFileSync(TMP_FILE, JSON.stringify({
        session_id: 'S1',
        off_at: 'not-a-date',
        tick_count: 0,
      }));
      assert.equal(isOff(), false);
      assert.equal(readSessionOffState(), null);
    });

    it('off_at is 1 hour ago (still within 24 hours) → true', () => {
      const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      fs.writeFileSync(TMP_FILE, JSON.stringify({
        session_id: 'S1',
        off_at: recent,
        tick_count: 0,
      }));
      assert.equal(isOff(), true);
    });
  });
});
