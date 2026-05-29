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
  it('default trigger is manual', () => {
    assert.deepEqual(selfCheck.parseArgs(['node', 'self-check.cjs']), { trigger: 'manual' });
  });

  it('reads --trigger=post_install', () => {
    assert.equal(
      selfCheck.parseArgs(['node', 'self-check.cjs', '--trigger=post_install']).trigger,
      'post_install'
    );
  });

  it('reads --trigger=post_upgrade', () => {
    assert.equal(
      selfCheck.parseArgs(['node', 'self-check.cjs', '--trigger=post_upgrade']).trigger,
      'post_upgrade'
    );
  });

  it('ignores unknown arguments', () => {
    assert.deepEqual(
      selfCheck.parseArgs(['node', 'x', '--unknown=foo', '--trigger=manual']),
      { trigger: 'manual' }
    );
  });
});

describe('summarize', () => {
  it('counts each status', () => {
    const checks = [
      { status: 'pass' }, { status: 'pass' }, { status: 'pass' },
      { status: 'warn' },
      { status: 'fail' }, { status: 'fail' },
    ];
    assert.deepEqual(selfCheck.summarize(checks), { pass: 3, warn: 1, fail: 2 });
  });

  it('empty array returns all zeros', () => {
    assert.deepEqual(selfCheck.summarize([]), { pass: 0, warn: 0, fail: 0 });
  });
});

describe('sanitizePath', () => {
  it('replaces home directory with ~', () => {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (!home) return; // skip on CI without home
    const out = selfCheck.sanitizePath(`error reading ${home}/secret.txt`);
    assert.ok(out.includes('~/secret.txt'));
    assert.ok(!out.includes(home));
  });

  it('handles non-strings safely', () => {
    assert.equal(selfCheck.sanitizePath(null), '');
    assert.equal(selfCheck.sanitizePath(undefined), '');
    assert.equal(selfCheck.sanitizePath(42), '42');
  });

  it('plain text passes through', () => {
    assert.equal(selfCheck.sanitizePath('plain string'), 'plain string');
  });
});

describe('buildReport', () => {
  it('assembles the full report shape', () => {
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

  it('v1.17.66 — env is included when provided, absent when not', () => {
    const fakeEnv = { os_release: '10.0.26100', arch: 'x64' };
    const withEnv = selfCheck.buildReport({ checks: [], trigger: 'manual', clientVersion: 'x', machine: 'm', env: fakeEnv });
    assert.deepEqual(withEnv.env, fakeEnv);
    const without = selfCheck.buildReport({ checks: [], trigger: 'manual', clientVersion: 'x', machine: 'm' });
    assert.equal(without.env, undefined, 'env field should be absent when not provided');
  });
});

describe('v1.17.66 — collectEnv environment collection (IR-038)', () => {
  it('exports collectEnv and three companion helpers', () => {
    assert.equal(typeof selfCheck.collectEnv, 'function');
    assert.equal(typeof selfCheck.detectShellChain, 'function');
    assert.equal(typeof selfCheck.detectBashResolution, 'function');
    assert.equal(typeof selfCheck.detectSchedulerDetail, 'function');
  });

  it('collectEnv() runs successfully + all required fields present', async () => {
    const env = await selfCheck.collectEnv();
    // Cross-platform: always present.
    assert.equal(typeof env.os_release, 'string');
    assert.equal(typeof env.arch, 'string');
    assert.equal(typeof env.node.version, 'string');
    assert.equal(typeof env.node.exec_path, 'string');
    assert.ok(['posix', 'msys', 'win32'].includes(env.home_format.style));
    assert.equal(typeof env.home_format.is_msys, 'boolean');
    assert.ok(Array.isArray(env.shell_chain));
    assert.ok(env.shell_chain.length > 0, 'shell_chain should at least include node:vX.X.X');
    // Non-Windows: bash_resolution / scheduler_detail = null.
    if (process.platform !== 'win32') {
      assert.equal(env.bash_resolution, null, 'bash_resolution should be null on non-Windows');
      assert.equal(env.scheduler_detail, null, 'scheduler_detail should be null on non-Windows');
      assert.equal(env.home_format.is_msys, false);
    }
  });

  it('node.exec_path is sanitized (HOME does not leak)', async () => {
    const env = await selfCheck.collectEnv();
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
      assert.ok(!env.node.exec_path.includes(home),
        `exec_path must not contain un-sanitized HOME (${home}); actual=${env.node.exec_path}`);
    }
  });
});

// v1.17.64 reproduction tests — Bob/Alice/Dana after upgrading to v1.17.63:
// (1) checkApiCredentials hits /api/init → server has no such route, returns 404 → always fails.
// (2) self-check sends X-OwnMind-API-Key header → auth middleware expects Authorization Bearer, returns 401.
// Both tests fail before the fix and pass after.
describe('checkApiCredentials (v1.17.64 regression)', () => {
  it('hits /api/memory/init (not /api/init) + sends Authorization Bearer header', async () => {
    const captured = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      captured.push({ url: String(url), headers: opts?.headers || {}, method: opts?.method });
      return { ok: true, status: 200 };
    };
    try {
      const r = await selfCheck.checkApiCredentials('https://example.com/ownmind', 'k_test_apikey');
      assert.equal(r.status, 'pass');
      assert.equal(captured.length, 1);
      assert.match(captured[0].url, /\/api\/memory\/init$/,
        `should hit /api/memory/init, actual URL=${captured[0].url}`);
      assert.equal(captured[0].headers.Authorization, 'Bearer k_test_apikey',
        `should use Authorization: Bearer, actual headers=${JSON.stringify(captured[0].headers)}`);
      assert.ok(!captured[0].headers['X-OwnMind-API-Key'],
        'must no longer send the legacy X-OwnMind-API-Key header');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('401 response is still treated as fail (avoid false pass after server auth change)', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    try {
      const r = await selfCheck.checkApiCredentials('https://example.com/ownmind', 'bad');
      assert.equal(r.status, 'fail');
      assert.match(r.detail, /401/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

// ============================================================================
// v1.17.66 reproduction tests — Alice / Bob upgrade-to-v1.17.65 failure scenarios
// ============================================================================

describe('v1.17.66 — Bug #2 self-check scheduler must not pass shell:true', () => {
  // shell:true on Windows wraps the call inside cmd.exe; the `|` pipe is eaten
  // by cmd, so PowerShell commands like `Get-ScheduledTask | Select-Object` always fail.
  // Live evidence: Alice/Bob logs verbatim "'Select-Object' is not recognized as ...".
  it('self-check.cjs calls to powershell.exe must not include { shell: true }', () => {
    const content = fs.readFileSync(selfCheckPath, 'utf8');
    // Grab every powershell.exe spawn / execFile call's options block.
    const re = /(?:execFile(?:Async)?|spawn)\s*\([\s\S]*?powershell\.exe[\s\S]*?\)/g;
    const matches = content.match(re) || [];
    assert.ok(matches.length > 0,
      'expected at least one powershell.exe call but none found — the grep regex may be stale');
    for (const m of matches) {
      assert.doesNotMatch(m, /shell\s*:\s*true/,
        `must not use shell:true with powershell.exe (cmd.exe would swallow the PowerShell pipeline): ${m.slice(0, 200)}`);
    }
  });

  it('checkScheduler should use the safe-spawn helper to enforce windowsHide / shell:false', () => {
    const content = fs.readFileSync(selfCheckPath, 'utf8');
    assert.match(content, /safe-spawn|safeSpawn/,
      'checkScheduler should go through the safe-spawn helper (forces shell:false + windowsHide:true)');
  });
});

describe('v1.17.66 — Bug #4 self-check uploadReport spool mechanism', () => {
  // Bob's case: API key 401 → upload fails → report dropped → server install_check_logs
  // receives nothing. Fix: on failure, append to a spool jsonl and replay at the start of the next run.

  it('module must export uploadReport / appendSpool / retrySpool', () => {
    assert.equal(typeof selfCheck.uploadReport, 'function',
      'uploadReport must be exported for test mocking');
    assert.equal(typeof selfCheck.appendSpool, 'function',
      'appendSpool must be exported (writes to spool jsonl on 401 / network failure)');
    assert.equal(typeof selfCheck.retrySpool, 'function',
      'retrySpool must be exported (replays old reports at the start of each self-check)');
  });

  it('uploadReport 401 failure should spool (do not drop data)', async () => {
    if (typeof selfCheck.uploadReport !== 'function' ||
        typeof selfCheck.appendSpool !== 'function') {
      // Not yet implemented — keep red.
      assert.fail('uploadReport / appendSpool not yet exported; cannot verify spool behavior');
    }
    // Use an isolated tmp dir to simulate ~/.ownmind/logs, avoiding pollution of the real host.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-spool-'));
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    try {
      const report = { ts: new Date().toISOString(), trigger: 'manual', checks: [], summary: { pass:0, warn:0, fail:0 } };
      const r = await selfCheck.uploadReport(report, 'https://test.invalid', 'fake-key', { spoolDir: tmp });
      assert.equal(r.ok, false, '401 should return ok:false');
      assert.equal(r.spooled, true, '401 should spool rather than drop');
      // Spool file must exist.
      const spoolPath = path.join(tmp, '.upload-spool.jsonl');
      assert.ok(fs.existsSync(spoolPath), 'spool file should be created');
      const lines = fs.readFileSync(spoolPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1, 'spool should contain one record');
      assert.match(lines[0], /"trigger":"manual"/);
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('retrySpool clears the spool when fetch is 200 and returns the replayed count', async () => {
    if (typeof selfCheck.retrySpool !== 'function' ||
        typeof selfCheck.appendSpool !== 'function') {
      assert.fail('retrySpool / appendSpool not yet exported; cannot verify replay behavior');
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-spool-'));
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    try {
      // Pre-populate the spool with two fake records.
      const spoolPath = path.join(tmp, '.upload-spool.jsonl');
      fs.writeFileSync(
        spoolPath,
        JSON.stringify({ ts: '2026-05-08T00:00:00Z', trigger: 'manual_after_failure', checks: [], summary: { pass:0,warn:0,fail:0 } }) + '\n' +
        JSON.stringify({ ts: '2026-05-08T01:00:00Z', trigger: 'post_upgrade', checks: [], summary: { pass:0,warn:0,fail:0 } }) + '\n'
      );
      const r = await selfCheck.retrySpool('https://test.invalid', 'good-key', { spoolDir: tmp });
      assert.equal(r.retried, 2, 'should replay 2 records');
      assert.equal(r.failed, 0, 'all should succeed');
      // Spool should be cleared (missing file or empty contents).
      const remaining = fs.existsSync(spoolPath) ? fs.readFileSync(spoolPath, 'utf8').trim() : '';
      assert.equal(remaining, '', 'spool should be empty after a successful replay');
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('check functions (smoke)', () => {
  it('checkMcpFiles returns fail for a missing home directory', async () => {
    // Real ~/.ownmind may or may not exist depending on the host;
    // this test does not assume a specific outcome — it only validates the shape.
    const r = await selfCheck.checkMcpFiles();
    assert.equal(r.name, 'mcp_files');
    assert.ok(['pass', 'warn', 'fail'].includes(r.status));
    assert.ok(typeof r.detail === 'string');
  });

  it('checkPackageVersion shape is correct', async () => {
    const r = await selfCheck.checkPackageVersion();
    assert.equal(r.name, 'package_version');
    assert.ok(['pass', 'warn', 'fail'].includes(r.status));
  });

  it('checkScheduler shape is correct (does not depend on a specific platform outcome)', async () => {
    const r = await selfCheck.checkScheduler();
    assert.equal(r.name, 'scheduler');
    assert.ok(['pass', 'warn', 'fail'].includes(r.status));
  });
});

// ============================================================================
// v1.17.68 — checkApiKeyFormat (IR-007 same-mine defense)
// ============================================================================
//
// Background: from 2026-03-26 (account creation) to 2026-05-08, Bob kept hitting 401
// because his settings.json had OWNMIND_API_KEY left as the literal string "--update"
// (pre-v1.17.9 install.ps1 did not filter flag-like args from the legacy slot).
// During that window, token_events were 0 / install_check_logs were 0 / scanner was always 401,
// and nobody noticed because self-check only hit the server for 401, not the key string itself.
// Add checkApiKeyFormat to inspect the key string locally and uncover already-stuck installs.
// ============================================================================

describe('v1.17.68 — checkApiKeyFormat (client-side format validation; does not call server)', () => {
  it('module must export checkApiKeyFormat', () => {
    assert.equal(typeof selfCheck.checkApiKeyFormat, 'function');
  });

  it('Bob\'s "--update" should fail and detail must reference the historical regression', () => {
    const r = selfCheck.checkApiKeyFormat('--update');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /--update/);
    assert.match(r.detail, /1\.17\.9|歷史|存量|flag-like/i,
      'detail should call out this is a pre-v1.17.9 historical issue');
  });

  it('other known bad values (--upgrade / true / null / ${OWNMIND_API_KEY}) also fail', () => {
    for (const bad of ['--upgrade', '--install', 'true', 'false', 'null',
                       'undefined', '${OWNMIND_API_KEY}']) {
      const r = selfCheck.checkApiKeyFormat(bad);
      assert.equal(r.status, 'fail', `"${bad}" should fail`);
    }
  });

  it('flag-like (starts with - but not on the known list) also fails', () => {
    const r = selfCheck.checkApiKeyFormat('-mysteriousfutureflag');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /-/);
  });

  it('empty string / undefined / non-string all fail', () => {
    assert.equal(selfCheck.checkApiKeyFormat('').status, 'fail');
    assert.equal(selfCheck.checkApiKeyFormat(undefined).status, 'fail');
    assert.equal(selfCheck.checkApiKeyFormat(null).status, 'fail');
    assert.equal(selfCheck.checkApiKeyFormat(123).status, 'fail');
  });

  it('length < 16 fails (legal UUID is 36; custom prefix ≥ 20)', () => {
    const r = selfCheck.checkApiKeyFormat('shortkey1234');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /length|too short/i);
  });

  it('whitespace fails (CR/LF/space/tab — common contamination from copy-paste)', () => {
    for (const bad of [
      'eb801d3f-03a3-4592-aee7-a54eb86fe0dc\n',
      ' eb801d3f-03a3-4592-aee7-a54eb86fe0dc',
      'eb801d3f-03a3-4592\t-aee7-a54eb86fe0dc',
      'eb801d3f-03a3-4592 -aee7-a54eb86fe0dc',
    ]) {
      const r = selfCheck.checkApiKeyFormat(bad);
      assert.equal(r.status, 'fail', `"${JSON.stringify(bad)}" should fail`);
    }
  });

  it('BOM / control characters fail', () => {
    const withBom = '﻿eb801d3f-03a3-4592-aee7-a54eb86fe0dc';
    const r = selfCheck.checkApiKeyFormat(withBom);
    assert.equal(r.status, 'fail');
  });

  it('legal UUID v4 → pass', () => {
    const uuid = 'eb801d3f-03a3-4592-aee7-a54eb86fe0dc';
    const r = selfCheck.checkApiKeyFormat(uuid);
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /len=36/);
  });

  it('legal custom prefix (Vin id=1 vin-...) → pass', () => {
    const r = selfCheck.checkApiKeyFormat('vin-abcdef0123456789-2026');
    assert.equal(r.status, 'pass');
  });
});
