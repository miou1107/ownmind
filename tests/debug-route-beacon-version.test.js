import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDebugRouter } from '../src/routes/debug.js';

/**
 * v1.17.85 — install_check_logs.client_version 別被 beacon sentinel 污染
 *
 * 背景：v1.17.78 起 install_started / update_started beacon 用字面字串
 * "install-script" / "update-script" 當 client_version 占位（升級剛開始時不知道
 * 目標版號）。但 server 端 debug.js 直接把 sentinel 寫進 client_version column →
 * admin query last_version 撈到 "update-script" 不是版號，誤判 user 卡在哪一版。
 *
 * 修法：debug.js 偵測 beacon trigger（install_started / update_started /
 * install_failed / update_failed / upgrade_failed_*），把 client_version 強制改 NULL。
 * - install_check_logs 仍會留 beacon 記錄（觀測管道完整）
 * - 但 client_version column 只放真實版號，admin query 不會誤判
 *
 * 不 backfill 歷史資料（污染量小，~20 筆 5/8 之後的 beacon）。
 */

function setupTestApp() {
  const insertedRows = [];
  const fakeQuery = async (sql, params) => {
    if (sql.includes('INSERT INTO install_check_logs')) {
      insertedRows.push({
        user_id: params[0], ts: params[1], client_version: params[2],
        platform: params[3], trigger_kind: params[4], machine: params[5],
        summary: params[6], full_log: params[7],
      });
      return { rows: [] };
    }
    return { rows: [] };
  };
  const fakeAuth = (req, res, next) => { req.user = { id: 99 }; next(); };
  const app = express();
  app.use(express.json());
  app.use('/api/debug', createDebugRouter({ query: fakeQuery, auth: fakeAuth }));
  return { app, insertedRows };
}

async function post(app, payload) {
  const port = await new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv.address().port));
    app._server = srv;
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/debug/install-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json() };
  } finally {
    app._server.close();
  }
}

describe('v1.17.85 — debug.js beacon trigger client_version 強制 NULL', () => {
  it('install_started + sentinel client_version "install-script" → DB 寫 NULL', async () => {
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'install_started',
      client_version: 'install-script',
      platform: 'win32',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].client_version, null,
      'beacon trigger 的 client_version 必須寫 NULL，不能讓 "install-script" 污染欄位');
    assert.equal(insertedRows[0].trigger_kind, 'install_started',
      'trigger_kind 仍要保留（觀測管道完整）');
  });

  it('update_started + sentinel "update-script" → DB 寫 NULL', async () => {
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'update_started',
      client_version: 'update-script',
      platform: 'darwin',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, null);
  });

  it('install_failed_terminal_* (v1.17.85 新增) → DB 寫 NULL', async () => {
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'upgrade_failed_terminal_no_ownmind',
      client_version: 'unknown',  // FAIL 時可能也無真版號
      platform: 'win32',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, null);
  });

  it('正常 self-check report (post_install / manual / post_upgrade) → 保留真版號', async () => {
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'post_install',
      client_version: '1.17.85',
      platform: 'darwin',
      checks: [{ name: 'mcp_files', status: 'pass', detail: 'ok' }],
      summary: { pass: 1, warn: 0, fail: 0 },
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, '1.17.85',
      '正常 report 必須保留真版號');
  });

  it('正常 self-check 但 client_version 是 sentinel 也要保留（防 over-zealous filter）', async () => {
    // 邊界 case：trigger 不是 beacon 但 client_version 偶然是 sentinel 樣式字串
    // 設計選擇：只看 trigger 不看 client_version 內容 — 簡單可預期
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'manual',
      client_version: 'install-script',  // 怪 case，但不過濾
      platform: 'darwin',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, 'install-script',
      'trigger 不是 beacon、即使 client_version 內容像 sentinel 也照樣留');
  });

  it('既有 _step 級 report (upgrade_dirty_tree / upgrade_npm_install_failed) → 保留真版號', async () => {
    // reviewer I1：trailing underscore 強化讓既有 caller 級報錯不會誤中
    // 既有的 caller 級 report 沒有 _failed_ 中綴、不會被當 beacon
    const cases = [
      { trigger: 'upgrade_dirty_tree', expect: '1.17.85' },
      { trigger: 'upgrade_npm_install_failed', expect: '1.17.85' },  // 結尾 _failed 不是 _failed_
      { trigger: 'upgrade_git_pull_failed', expect: '1.17.85' },
      { trigger: 'upgrade_file_locked', expect: '1.17.85' },
    ];
    for (const c of cases) {
      const { app, insertedRows } = setupTestApp();
      const r = await post(app, {
        ts: '2026-05-11T03:50:00Z',
        trigger: c.trigger,
        client_version: '1.17.85',
        platform: 'darwin',
      });
      assert.equal(r.status, 200);
      assert.equal(insertedRows[0].client_version, c.expect,
        `${c.trigger} 不該被當 beacon、應保留真版號`);
    }
  });

  it('beacon prefix trailing underscore 防誤中（upgrade_failedtest ≠ upgrade_failed_*）', async () => {
    // 防未來有人手滑命名 upgrade_failedtest 被當 beacon
    const { app, insertedRows } = setupTestApp();
    await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'upgrade_failedtest',  // 沒底線、不算 beacon
      client_version: '1.17.85',
      platform: 'darwin',
    });
    assert.equal(insertedRows[0].client_version, '1.17.85',
      'upgrade_failedtest 不該被當 upgrade_failed_* beacon 誤中');
  });

  it('beacon trigger 但 client_version 是真版號（v1.17.85+ 升級腳本送的）→ 也寫 NULL', async () => {
    // 設計選擇：trigger 是 beacon 就一律 NULL，不看 client_version 內容
    // 理由：beacon 的 client_version 不可靠（升級流程中），即使真版號也不該當 last_version 證據
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'install_started',
      client_version: '1.17.85',  // 假設未來腳本改傳真版號
      platform: 'win32',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, null,
      'beacon trigger 一律寫 NULL（last_version 只能來自 self-check report）');
  });
});
