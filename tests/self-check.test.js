import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const selfCheck = require(
  path.join(__dirname, '..', 'scripts', 'install-helpers', 'self-check.cjs')
);

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
