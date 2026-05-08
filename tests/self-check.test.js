import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const selfCheckPath = path.join(repoRoot, 'scripts/install-helpers/self-check.cjs');
const selfCheck = require(selfCheckPath);

describe('parseArgs', () => {
  it('預設 trigger 是 manual', () => {
    assert.deepEqual(selfCheck.parseArgs(['node', 'self-check.cjs']), { trigger: 'manual' });
  });

  it('讀 --trigger=post_install', () => {
    assert.equal(
      selfCheck.parseArgs(['node', 'self-check.cjs', '--trigger=post_install']).trigger,
      'post_install'
    );
  });

  it('讀 --trigger=post_upgrade', () => {
    assert.equal(
      selfCheck.parseArgs(['node', 'self-check.cjs', '--trigger=post_upgrade']).trigger,
      'post_upgrade'
    );
  });

  it('忽略未知參數', () => {
    assert.deepEqual(
      selfCheck.parseArgs(['node', 'x', '--unknown=foo', '--trigger=manual']),
      { trigger: 'manual' }
    );
  });
});

describe('summarize', () => {
  it('算各狀態數量', () => {
    const checks = [
      { status: 'pass' }, { status: 'pass' }, { status: 'pass' },
      { status: 'warn' },
      { status: 'fail' }, { status: 'fail' },
    ];
    assert.deepEqual(selfCheck.summarize(checks), { pass: 3, warn: 1, fail: 2 });
  });

  it('空陣列回傳全 0', () => {
    assert.deepEqual(selfCheck.summarize([]), { pass: 0, warn: 0, fail: 0 });
  });
});

describe('sanitizePath', () => {
  it('家目錄路徑換成 ~', () => {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (!home) return; // skip on CI without home
    const out = selfCheck.sanitizePath(`error reading ${home}/secret.txt`);
    assert.ok(out.includes('~/secret.txt'));
    assert.ok(!out.includes(home));
  });

  it('非字串安全處理', () => {
    assert.equal(selfCheck.sanitizePath(null), '');
    assert.equal(selfCheck.sanitizePath(undefined), '');
    assert.equal(selfCheck.sanitizePath(42), '42');
  });

  it('純文字直接回傳', () => {
    assert.equal(selfCheck.sanitizePath('plain string'), 'plain string');
  });
});

describe('buildReport', () => {
  it('組裝完整 report 結構', () => {
    const checks = [
      { name: 'a', status: 'pass', detail: 'ok' },
      { name: 'b', status: 'fail', detail: 'broken' },
    ];
    const r = selfCheck.buildReport({
      checks,
      trigger: 'post_upgrade',
      clientVersion: '1.17.63',
      machine: 'test-machine',
    });
    assert.equal(r.trigger, 'post_upgrade');
    assert.equal(r.client_version, '1.17.63');
    assert.equal(r.machine, 'test-machine');
    assert.equal(r.platform, process.platform);
    assert.equal(r.node_version, process.version);
    assert.deepEqual(r.checks, checks);
    assert.deepEqual(r.summary, { pass: 1, warn: 0, fail: 1 });
    assert.match(r.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('v1.17.66 — env 有給時帶上、沒給時不出現在 report', () => {
    const fakeEnv = { os_release: '10.0.26100', arch: 'x64' };
    const withEnv = selfCheck.buildReport({ checks: [], trigger: 'manual', clientVersion: 'x', machine: 'm', env: fakeEnv });
    assert.deepEqual(withEnv.env, fakeEnv);
    const without = selfCheck.buildReport({ checks: [], trigger: 'manual', clientVersion: 'x', machine: 'm' });
    assert.equal(without.env, undefined, '沒給 env 時不該出現空 env 欄位');
  });
});

describe('v1.17.66 — collectEnv 環境資訊收集（IR-038）', () => {
  it('export collectEnv 等四個 helper', () => {
    assert.equal(typeof selfCheck.collectEnv, 'function');
    assert.equal(typeof selfCheck.detectShellChain, 'function');
    assert.equal(typeof selfCheck.detectBashResolution, 'function');
    assert.equal(typeof selfCheck.detectSchedulerDetail, 'function');
  });

  it('collectEnv() 跑得起來 + 必要欄位齊全', async () => {
    const env = await selfCheck.collectEnv();
    // 跨平台必有
    assert.equal(typeof env.os_release, 'string');
    assert.equal(typeof env.arch, 'string');
    assert.equal(typeof env.node.version, 'string');
    assert.equal(typeof env.node.exec_path, 'string');
    assert.ok(['posix', 'msys', 'win32'].includes(env.home_format.style));
    assert.equal(typeof env.home_format.is_msys, 'boolean');
    assert.ok(Array.isArray(env.shell_chain));
    assert.ok(env.shell_chain.length > 0, 'shell_chain 至少要含 node:vX.X.X');
    // 非 Windows 平台 bash_resolution / scheduler_detail = null
    if (process.platform !== 'win32') {
      assert.equal(env.bash_resolution, null, '非 Windows 平台 bash_resolution 應為 null');
      assert.equal(env.scheduler_detail, null, '非 Windows 平台 scheduler_detail 應為 null');
      assert.equal(env.home_format.is_msys, false);
    }
  });

  it('node.exec_path 經過 sanitize（HOME 不外洩）', async () => {
    const env = await selfCheck.collectEnv();
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
      assert.ok(!env.node.exec_path.includes(home),
        `exec_path 不該含未 sanitize 的 HOME (${home})；實際=${env.node.exec_path}`);
    }
  });
});

// v1.17.64 reproduction tests — Adam/Eric/Michelle 升 v1.17.63 後實測：
// (1) checkApiCredentials 打 /api/init → server 沒這條，回 404 → 永遠 fail
// (2) self-check 帶 X-OwnMind-API-Key header → auth middleware 認 Authorization Bearer，回 401
// 這兩個 test 在修復前會 fail，修復後 pass。
describe('checkApiCredentials (v1.17.64 regression)', () => {
  it('打 /api/memory/init（不是 /api/init）+ 帶 Authorization Bearer header', async () => {
    const captured = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      captured.push({ url: String(url), headers: opts?.headers || {}, method: opts?.method });
      return { ok: true, status: 200 };
    };
    try {
      const r = await selfCheck.checkApiCredentials('https://kkvin.com/ownmind', 'k_test_apikey');
      assert.equal(r.status, 'pass');
      assert.equal(captured.length, 1);
      assert.match(captured[0].url, /\/api\/memory\/init$/,
        `應打 /api/memory/init，實際 URL=${captured[0].url}`);
      assert.equal(captured[0].headers.Authorization, 'Bearer k_test_apikey',
        `應用 Authorization: Bearer，實際 headers=${JSON.stringify(captured[0].headers)}`);
      assert.ok(!captured[0].headers['X-OwnMind-API-Key'],
        '不該再帶舊的 X-OwnMind-API-Key header');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('401 回應仍判為 fail（避免 server 換認證後回 false pass）', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    try {
      const r = await selfCheck.checkApiCredentials('https://kkvin.com/ownmind', 'bad');
      assert.equal(r.status, 'fail');
      assert.match(r.detail, /401/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

// ============================================================================
// v1.17.66 reproduction tests — Eric / Adam 升 v1.17.65 失敗劇本
// ============================================================================

describe('v1.17.66 — Bug #2 self-check scheduler 不可帶 shell:true', () => {
  // shell:true on Windows 會包進 cmd.exe，pipe `|` 被 cmd 吃掉，
  // 導致 PowerShell 命令 `Get-ScheduledTask | Select-Object` 永遠 fail。
  // 真實證據：Eric/Adam log 一字不差「'Select-Object' is not recognized as ...」
  it('self-check.cjs 對 powershell.exe 的呼叫不能含 { shell: true }', () => {
    const content = fs.readFileSync(selfCheckPath, 'utf8');
    // 抓所有 powershell.exe spawn / execFile call 的 options block
    const re = /(?:execFile(?:Async)?|spawn)\s*\([\s\S]*?powershell\.exe[\s\S]*?\)/g;
    const matches = content.match(re) || [];
    assert.ok(matches.length > 0,
      '預期至少有一個 powershell.exe 呼叫，但沒找到 — 可能 grep regex 過時');
    for (const m of matches) {
      assert.doesNotMatch(m, /shell\s*:\s*true/,
        `不該對 powershell.exe 用 shell:true（會被 cmd.exe 吃掉 PowerShell pipeline）：${m.slice(0, 200)}`);
    }
  });

  it('checkScheduler 應改用 safe-spawn helper 統一管 windowsHide / shell:false', () => {
    const content = fs.readFileSync(selfCheckPath, 'utf8');
    assert.match(content, /safe-spawn|safeSpawn/,
      'checkScheduler 應走 safe-spawn helper（強制 shell:false + windowsHide:true）');
  });
});

describe('v1.17.66 — Bug #4 self-check uploadReport spool 機制', () => {
  // Adam 案例：API key 401 → 上傳失敗 → 報告直接丟 → server install_check_logs
  // 完全沒收到任何資料。修法：失敗時寫進 spool jsonl，下次跑 self-check 開頭補傳。

  it('module 要 export uploadReport / appendSpool / retrySpool 三個 function', () => {
    assert.equal(typeof selfCheck.uploadReport, 'function',
      '需 export uploadReport 給 test mock');
    assert.equal(typeof selfCheck.appendSpool, 'function',
      '需 export appendSpool（401 / 網路失敗時寫進 spool jsonl）');
    assert.equal(typeof selfCheck.retrySpool, 'function',
      '需 export retrySpool（每次 self-check 開頭先補傳舊報告）');
  });

  it('uploadReport 401 失敗應寫進 spool（不丟掉資料）', async () => {
    if (typeof selfCheck.uploadReport !== 'function' ||
        typeof selfCheck.appendSpool !== 'function') {
      // 還沒實作 — 維持紅
      assert.fail('uploadReport / appendSpool 尚未 export，無法驗證 spool 行為');
    }
    // 用獨立 tmp dir 模擬 ~/.ownmind/logs，避免污染本機
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-spool-'));
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    try {
      const report = { ts: new Date().toISOString(), trigger: 'manual', checks: [], summary: { pass:0, warn:0, fail:0 } };
      const r = await selfCheck.uploadReport(report, 'https://test.invalid', 'fake-key', { spoolDir: tmp });
      assert.equal(r.ok, false, '401 應回 ok:false');
      assert.equal(r.spooled, true, '401 應 spool 而非丟掉');
      // spool 檔該存在
      const spoolPath = path.join(tmp, '.upload-spool.jsonl');
      assert.ok(fs.existsSync(spoolPath), 'spool 檔應被建立');
      const lines = fs.readFileSync(spoolPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1, 'spool 應含一筆紀錄');
      assert.match(lines[0], /"trigger":"manual"/);
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('retrySpool 在 fetch 200 時清空 spool 並回傳重送筆數', async () => {
    if (typeof selfCheck.retrySpool !== 'function' ||
        typeof selfCheck.appendSpool !== 'function') {
      assert.fail('retrySpool / appendSpool 尚未 export，無法驗證補傳行為');
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-spool-'));
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    try {
      // 預先塞兩筆假紀錄到 spool
      const spoolPath = path.join(tmp, '.upload-spool.jsonl');
      fs.writeFileSync(
        spoolPath,
        JSON.stringify({ ts: '2026-05-08T00:00:00Z', trigger: 'manual_after_failure', checks: [], summary: { pass:0,warn:0,fail:0 } }) + '\n' +
        JSON.stringify({ ts: '2026-05-08T01:00:00Z', trigger: 'post_upgrade', checks: [], summary: { pass:0,warn:0,fail:0 } }) + '\n'
      );
      const r = await selfCheck.retrySpool('https://test.invalid', 'good-key', { spoolDir: tmp });
      assert.equal(r.retried, 2, '應補傳 2 筆');
      assert.equal(r.failed, 0, '都應該成功');
      // spool 應被清空（檔不存在或內容空）
      const remaining = fs.existsSync(spoolPath) ? fs.readFileSync(spoolPath, 'utf8').trim() : '';
      assert.equal(remaining, '', '補傳成功後 spool 應為空');
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('check functions (smoke)', () => {
  it('checkMcpFiles 對不存在的家目錄回傳 fail', async () => {
    // 真實 ~/.ownmind 可能存在也可能不存在，看本機狀態。
    // 這個 test 不假設特定結果 — 只驗證形狀正確。
    const r = await selfCheck.checkMcpFiles();
    assert.equal(r.name, 'mcp_files');
    assert.ok(['pass', 'warn', 'fail'].includes(r.status));
    assert.ok(typeof r.detail === 'string');
  });

  it('checkPackageVersion 形狀正確', async () => {
    const r = await selfCheck.checkPackageVersion();
    assert.equal(r.name, 'package_version');
    assert.ok(['pass', 'warn', 'fail'].includes(r.status));
  });

  it('checkScheduler 形狀正確（不依賴特定平台結果）', async () => {
    const r = await selfCheck.checkScheduler();
    assert.equal(r.name, 'scheduler');
    assert.ok(['pass', 'warn', 'fail'].includes(r.status));
  });
});

// ============================================================================
// v1.17.68 — checkApiKeyFormat（IR-007 防同類雷）
// ============================================================================
//
// 背景：Adam 從 2026-03-26 建帳號到 2026-05-08 都吃 401，因為 settings.json 裡
// OWNMIND_API_KEY 殘留字串 "--update"（v1.17.9 之前 install.ps1 沒過濾 flag-like
// args 的存量問題）。期間 token_events 0 筆 / install_check_logs 0 筆 / scanner
// 永遠 401，沒人發現是因為 self-check 只打 server 看 401，不檢查 key 字串本身。
// 加 checkApiKeyFormat 純粹看 key 字串長相，把已經中招的存量挖出來。
// ============================================================================

describe('v1.17.68 — checkApiKeyFormat（client 端格式驗證 / 不打 server）', () => {
  it('module 應 export checkApiKeyFormat', () => {
    assert.equal(typeof selfCheck.checkApiKeyFormat, 'function');
  });

  it('Adam 的 "--update" 應 fail 且 detail 帶歷史踩坑說明', () => {
    const r = selfCheck.checkApiKeyFormat('--update');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /--update/);
    assert.match(r.detail, /1\.17\.9|歷史|存量|flag-like/i,
      'detail 應點出這是 v1.17.9 之前的歷史問題');
  });

  it('其他已知壞值（--upgrade / true / null / ${OWNMIND_API_KEY}）也 fail', () => {
    for (const bad of ['--upgrade', '--install', 'true', 'false', 'null',
                       'undefined', '${OWNMIND_API_KEY}']) {
      const r = selfCheck.checkApiKeyFormat(bad);
      assert.equal(r.status, 'fail', `"${bad}" 應該 fail`);
    }
  });

  it('flag-like（- 開頭但不在已知清單）也 fail', () => {
    const r = selfCheck.checkApiKeyFormat('-mysteriousfutureflag');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /-/);
  });

  it('空字串 / undefined / 非 string 全 fail', () => {
    assert.equal(selfCheck.checkApiKeyFormat('').status, 'fail');
    assert.equal(selfCheck.checkApiKeyFormat(undefined).status, 'fail');
    assert.equal(selfCheck.checkApiKeyFormat(null).status, 'fail');
    assert.equal(selfCheck.checkApiKeyFormat(123).status, 'fail');
  });

  it('長度 < 16 fail（合法 UUID 36 / custom prefix ≥ 20）', () => {
    const r = selfCheck.checkApiKeyFormat('shortkey1234');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /長度/);
  });

  it('含空白字元 fail（CR/LF/space/tab — 設定檔複製貼上常見污染）', () => {
    for (const bad of [
      'eb801d3f-03a3-4592-aee7-a54eb86fe0dc\n',
      ' eb801d3f-03a3-4592-aee7-a54eb86fe0dc',
      'eb801d3f-03a3-4592\t-aee7-a54eb86fe0dc',
      'eb801d3f-03a3-4592 -aee7-a54eb86fe0dc',
    ]) {
      const r = selfCheck.checkApiKeyFormat(bad);
      assert.equal(r.status, 'fail', `"${JSON.stringify(bad)}" 應該 fail`);
    }
  });

  it('含 BOM / 控制字元 fail', () => {
    const withBom = '﻿eb801d3f-03a3-4592-aee7-a54eb86fe0dc';
    const r = selfCheck.checkApiKeyFormat(withBom);
    assert.equal(r.status, 'fail');
  });

  it('合法 UUID v4 → pass', () => {
    const uuid = 'eb801d3f-03a3-4592-aee7-a54eb86fe0dc';
    const r = selfCheck.checkApiKeyFormat(uuid);
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /len=36/);
  });

  it('合法 custom prefix（Vincent id=1 vin-...） → pass', () => {
    const r = selfCheck.checkApiKeyFormat('vin-abcdef0123456789-2026');
    assert.equal(r.status, 'pass');
  });
});

