import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDebugRouter } from '../src/routes/debug.js';

/**
 * v1.17.86 — upgrade_complete beacon（IR-038 觀測管道補洞）
 *
 * 背景：v1.17.85 的 FAIL fallback 只覆蓋「升級流程被 FAIL() 中斷」的 case，
 * 但 Adam / Michelle 是另一種場景：**升級實際完成（client 在 1.17.84，
 * collector_heartbeat 證實）但 post_install self-check 上傳沒成功**。可能原因：
 *   - self-check 跑了但 upload 401 / 5xx → 寫 .upload-spool.jsonl、等下次 retry，
 *     可是 user 升完就 quit Claude Code、永遠沒下次觸發 self-check 來 drain spool
 *   - Windows 環境特殊問題讓 self-check process 被中斷
 *   - 跨多版升級時 self-check 邏輯卡某步
 *
 * 結果：`install_check_logs` 沒任何 post_install row → admin 從 install_check_logs
 * 看「user 在哪版」會誤判（要交叉看 `collector_heartbeat`）。
 *
 * 修法：升級成功末段先打一個輕量 `upgrade_complete` beacon（fire-and-forget +
 * spool fallback），payload 只帶真版號 + ts + machine，**不包含完整 checks**。
 * 比 self-check report 早送、簡單到不會卡住。Server 收到後 install_check_logs
 * 有 row + 真版號（不像 install_started / update_started 走 sentinel）。
 *
 * 這條 beacon 跟現有 install_started / update_started 並存：
 *   install_started → 升級「開始」訊號（client_version = sentinel）
 *   upgrade_complete → 升級「完成」訊號（client_version = 真版號）
 *   post_upgrade self-check → 升級「驗證」訊號（完整 checks）
 *
 * 即使 self-check 三步驟全部失敗，server 至少看得到 upgrade_complete 證明
 * user 升上去了、現在版本是 X。
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

describe('v1.17.86 — interactive-upgrade.sh send_upgrade_complete_beacon 行為', () => {
  let tmpHome;

  function setup() {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-uc-beacon-'));
    const claudeDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
    // 寫假 settings.json 但用 invalid URL → 強制 curl 失敗 → 走 spool fallback
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          ownmind: {
            env: {
              OWNMIND_API_KEY: 'test-key',
              OWNMIND_API_URL: 'http://127.0.0.1:1/ownmind',  // port 1 → 必失敗
            },
          },
        },
      })
    );
  }

  function cleanup() {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  it('bash: send_upgrade_complete_beacon 失敗時 spool fallback、payload 含真版號 + upgrade_complete trigger', () => {
    setup();
    try {
      const fakeScript = `
        #!/usr/bin/env bash
        set -u
        # 抽真實 send_upgrade_complete_beacon function 從 interactive-upgrade.sh
        eval "$(sed -n '/^send_upgrade_complete_beacon()/,/^}/p' "${path.join(repoRoot, 'scripts/interactive-upgrade.sh')}")"
        send_upgrade_complete_beacon "1.17.86-test"
      `;
      const r = spawnSync('bash', ['-c', fakeScript], {
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, OSTYPE: 'darwin' },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, 'beacon function 失敗也要 exit 0、不擋升級');

      const spoolPath = path.join(tmpHome, '.ownmind', 'logs', '.upload-spool.jsonl');
      assert.ok(fs.existsSync(spoolPath), 'curl 失敗應該 spool fallback');

      const line = fs.readFileSync(spoolPath, 'utf8').trim();
      const rec = JSON.parse(line);
      assert.equal(rec.trigger, 'upgrade_complete');
      assert.equal(rec.client_version, '1.17.86-test',
        '真版號要直接放、不是 sentinel');
      assert.ok(rec.ts);
      assert.ok(rec.machine);
    } finally { cleanup(); }
  });

  it('bash: interactive-upgrade.sh 末段有呼叫 send_upgrade_complete_beacon', () => {
    const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.sh'), 'utf8');
    assert.match(content, /^send_upgrade_complete_beacon\s+"\$\{?VERSION\}?"/m,
      'interactive-upgrade.sh 必須在升級成功末段 call beacon 帶 $VERSION');
  });

  it('SessionStart hook 也跑 retrySpool drain（reviewer I1 修法：縮短「user 升完→server 看到」延遲）', () => {
    // 場景：v1.17.86 加 upgrade_complete beacon 解決 self-check upload 失敗時
    // server 看不到 user 升完。但 beacon 自己上傳失敗也會 spool、原本要等下次
    // self-check 才 drain。user 升完就 quit Claude Code 永遠沒下次 → 卡死。
    // 修法：SessionStart 也呼叫 retrySpool，任何新 session 起來都會 drain。
    const content = fs.readFileSync(path.join(repoRoot, 'hooks/ownmind-session-start.sh'), 'utf8');
    assert.match(content, /retrySpool/,
      'SessionStart hook 必須呼叫 retrySpool drain 累積的 spool record');
    assert.match(content, /\.upload-spool/,
      'SessionStart 註解或邏輯應提到 .upload-spool 來源');
    // fire-and-forget：必須以 `&` 背景跑，不擋 SessionStart
    assert.match(content, /retrySpool[\s\S]{0,500}&/,
      'drain 必須 fire-and-forget 背景跑、不擋 SessionStart');
  });

  it('ps1: interactive-upgrade.ps1 含 Send-UpgradeCompleteBeacon function + 呼叫', () => {
    const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.ps1'), 'utf8');
    assert.match(content, /function Send-UpgradeCompleteBeacon/,
      'PS1 必須定義 Send-UpgradeCompleteBeacon function');
    assert.match(content, /Send-UpgradeCompleteBeacon\s+-ClientVersion\s+\$Version/,
      'PS1 必須末段呼叫 Send-UpgradeCompleteBeacon -ClientVersion $Version');
    assert.match(content, /trigger\s*=\s*'upgrade_complete'/,
      'PS1 beacon payload trigger 必須是 upgrade_complete');
  });
});

describe('v1.17.86 — upgrade_complete beacon: server 端認得且保留真版號', () => {
  it('upgrade_complete + 真版號 → client_version 寫真版號（不被當 beacon-sentinel 過濾）', async () => {
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T10:00:00Z',
      trigger: 'upgrade_complete',
      client_version: '1.17.86',
      platform: 'win32',
      machine: 'adam-laptop',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].client_version, '1.17.86',
      'upgrade_complete 是升級「完成」訊號、真版號必須保留');
    assert.equal(insertedRows[0].trigger_kind, 'upgrade_complete');
  });

  it('upgrade_complete 跟 install_started / update_started 行為相反', async () => {
    // install_started 用 sentinel "install-script" → 過濾成 NULL
    // upgrade_complete 用真版號 → 保留
    const { app, insertedRows } = setupTestApp();

    await post(app, {
      ts: '2026-05-11T10:00:00Z',
      trigger: 'install_started',
      client_version: 'install-script',
      platform: 'win32',
    });
    await post(app, {
      ts: '2026-05-11T10:00:30Z',
      trigger: 'upgrade_complete',
      client_version: '1.17.86',
      platform: 'win32',
    });

    assert.equal(insertedRows[0].client_version, null,
      'install_started sentinel 被過濾');
    assert.equal(insertedRows[1].client_version, '1.17.86',
      'upgrade_complete 真版號保留');
  });

  it('upgrade_complete + sentinel 字串（不該發生但防呆）→ 也寫進去不過濾', async () => {
    // 設計選擇：trigger 是 upgrade_complete 就信任 client 給的 client_version
    // 升級完成時 client 必然知道真版號（reads package.json post-pull）
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T10:00:00Z',
      trigger: 'upgrade_complete',
      client_version: 'install-script',  // 不該發生但防呆
      platform: 'win32',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, 'install-script',
      'trigger 不是 beacon-sentinel-trigger 系列、不過濾 client_version');
  });
});
