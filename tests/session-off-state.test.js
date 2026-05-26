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
    it('檔案不存在 → readSessionOffState 回 null', () => {
      assert.equal(readSessionOffState(), null);
    });

    it('writeSessionOffState 寫入 + readSessionOffState 讀回一致', () => {
      const ok = writeSessionOffState('S1');
      assert.equal(ok, true);
      const state = readSessionOffState();
      assert.equal(state.session_id, 'S1');
      assert.equal(state.tick_count, 0);
      assert.ok(typeof state.off_at === 'string');
    });

    it('重複寫同 session_id → tick_count 保留', () => {
      writeSessionOffState('S1');
      incrementTickCount();
      incrementTickCount();
      assert.equal(readSessionOffState().tick_count, 2);
      writeSessionOffState('S1');
      assert.equal(readSessionOffState().tick_count, 2,
        '同 session_id 再寫應保留 tick_count');
    });

    it('寫不同 session_id → tick_count 歸零', () => {
      writeSessionOffState('S1');
      incrementTickCount();
      incrementTickCount();
      writeSessionOffState('S2');
      assert.equal(readSessionOffState().tick_count, 0);
    });

    it('clearSessionOffState 後讀回 null', () => {
      writeSessionOffState('S1');
      assert.equal(clearSessionOffState(), true);
      assert.equal(readSessionOffState(), null);
    });

    it('檔案損毀（非 JSON）→ readSessionOffState 回 null 不 crash', () => {
      fs.writeFileSync(TMP_FILE, 'not-a-json{{{');
      assert.equal(readSessionOffState(), null);
    });

    it('檔案缺欄位 → readSessionOffState 回 null', () => {
      fs.writeFileSync(TMP_FILE, JSON.stringify({ session_id: 'S1' })); // 缺 off_at / tick_count
      assert.equal(readSessionOffState(), null);
    });

    it('writeSessionOffState 空字串 session_id → 回 false 不寫', () => {
      assert.equal(writeSessionOffState(''), false);
      assert.equal(readSessionOffState(), null);
    });
  });

  describe('incrementTickCount', () => {
    it('沒狀態檔 → 回 0 不創建', () => {
      assert.equal(incrementTickCount(), 0);
      assert.equal(readSessionOffState(), null);
    });

    it('有狀態檔 → 每次呼叫 +1', () => {
      writeSessionOffState('S1');
      assert.equal(incrementTickCount(), 1);
      assert.equal(incrementTickCount(), 2);
      assert.equal(incrementTickCount(), 3);
      assert.equal(readSessionOffState().tick_count, 3);
    });
  });

  describe('isOff（Stop hook + pre-commit hook 共用）', () => {
    it('沒狀態檔 → false', () => {
      assert.equal(isOff(), false);
    });

    it('剛寫入（off_at 為現在）→ true', () => {
      writeSessionOffState('S1');
      assert.equal(isOff(), true);
    });

    it('off_at 是 25 小時前（過期）→ false 且自動清掉', () => {
      const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(TMP_FILE, JSON.stringify({
        session_id: 'S1',
        off_at: expired,
        tick_count: 0,
      }));
      assert.equal(isOff(), false);
      assert.equal(readSessionOffState(), null);
    });

    it('off_at 無法 parse → false 且自動清掉', () => {
      fs.writeFileSync(TMP_FILE, JSON.stringify({
        session_id: 'S1',
        off_at: 'not-a-date',
        tick_count: 0,
      }));
      assert.equal(isOff(), false);
      assert.equal(readSessionOffState(), null);
    });

    it('off_at 是 1 小時前（仍在 24 小時內）→ true', () => {
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
