import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.79 — unified error-reporting mechanism + dirty-tree auto-recovery
 * (IR-038, third round from reporter vin-windows-test)
 *
 * Root cause:
 *   - Any mid-stream fatal error during install / upgrade exits 1, so the end-of-file
 *     self-check never runs and admin sees no root cause.
 *   - vin-windows-test case: their AI edited mcp/start.cmd without committing, so the
 *     next `git pull --ff-only` was rejected → upgrade fails, user stuck, server has
 *     zero record.
 *   - The whole client side lacked a unified "auto-report on failure" mechanism.
 *
 * Fix (two pieces):
 *   1. errors/ spool: every failure point drops a JSON into ~/.ownmind/logs/errors/.
 *      drainErrorSpool() in self-check uploads them uniformly to /api/debug/install-check
 *      (already relaxed in v1.17.78).
 *   2. interactive-upgrade.{sh,ps1}: detect dirty working tree → drop error report
 *      → git reset --hard origin/main → resume upgrade.
 */

describe('report-error.cjs helper (writes the errors/ spool file)', () => {
  const tmpHome = path.join(os.tmpdir(), `ownmind-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const errorsDir = path.join(tmpHome, '.ownmind', 'logs', 'errors');
  const helper = path.join(repoRoot, 'scripts/install-helpers/report-error.cjs');

  beforeEach(() => {
    fs.mkdirSync(errorsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('helper writes <ts>-<kind>.json into the errors/ directory', () => {
    execFileSync('node', [
      helper,
      '--kind=upgrade_dirty_tree',
      '--detail=mcp/start.cmd has uncommitted changes',
    ], { env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome } });

    const files = fs.readdirSync(errorsDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d+-upgrade_dirty_tree\.json$/);

    const obj = JSON.parse(fs.readFileSync(path.join(errorsDir, files[0]), 'utf8'));
    assert.equal(obj.kind, 'upgrade_dirty_tree');
    assert.equal(obj.detail, 'mcp/start.cmd has uncommitted changes');
    assert.ok(obj.ts);
  });

  it('detail with special chars (newlines, quotes) writes safely', () => {
    execFileSync('node', [
      helper,
      '--kind=npm_fail',
      '--detail=line1\nline2 with "quotes" and \\backslash',
    ], { env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome } });

    const files = fs.readdirSync(errorsDir);
    const obj = JSON.parse(fs.readFileSync(path.join(errorsDir, files[0]), 'utf8'));
    assert.equal(obj.detail, 'line1\nline2 with "quotes" and \\backslash');
  });

  it('with --context-file, last 30 lines go into context field (HOME path scrubbed)', () => {
    const logFile = path.join(tmpHome, 'fake.log');
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${tmpHome}/some/path`);
    fs.writeFileSync(logFile, lines.join('\n'));

    execFileSync('node', [
      helper,
      '--kind=git_pull_failed',
      '--detail=conflict',
      `--context-file=${logFile}`,
    ], { env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome } });

    const files = fs.readdirSync(errorsDir);
    const obj = JSON.parse(fs.readFileSync(path.join(errorsDir, files[0]), 'utf8'));
    assert.ok(obj.context.includes('line 49'), 'context must include the log tail');
    assert.ok(!obj.context.includes(tmpHome), `HOME path should be sanitized to ~; context=${obj.context.slice(0, 200)}`);
  });
});

describe('drainErrorSpool — self-check uploads files from errors/ and deletes them', () => {
  let tmpHome;
  let errorsDir;
  const fakeServer = { received: [], status: 200 };

  beforeEach(async () => {
    tmpHome = path.join(os.tmpdir(), `ownmind-drain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    errorsDir = path.join(tmpHome, '.ownmind', 'logs', 'errors');
    fs.mkdirSync(errorsDir, { recursive: true });
    fakeServer.received = [];
    fakeServer.status = 200;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function withServer(handler, fn) {
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.post('/api/debug/install-check', handler);
    return new Promise((resolve, reject) => {
      const server = app.listen(0, async () => {
        const url = `http://127.0.0.1:${server.address().port}`;
        try {
          const result = await fn(url);
          server.close(() => resolve(result));
        } catch (e) {
          server.close(() => reject(e));
        }
      });
    });
  }

  it('uploads each errors/*.json, deletes the file on success', async () => {
    fs.writeFileSync(path.join(errorsDir, '1700000001-foo.json'),
      JSON.stringify({ ts: '2026-05-08T17:00:00Z', kind: 'foo', detail: 'd1' }));
    fs.writeFileSync(path.join(errorsDir, '1700000002-bar.json'),
      JSON.stringify({ ts: '2026-05-08T17:00:01Z', kind: 'bar', detail: 'd2' }));

    const { drainErrorSpool } = await import('../scripts/install-helpers/self-check.cjs');

    await withServer((req, res) => {
      fakeServer.received.push(req.body);
      res.json({ ok: true });
    }, async (url) => {
      const result = await drainErrorSpool(url, 'fake-key', { errorsDir });
      assert.equal(result.uploaded, 2);
      assert.equal(result.failed, 0);
    });

    assert.equal(fakeServer.received.length, 2);
    const triggers = fakeServer.received.map((r) => r.trigger).sort();
    assert.deepEqual(triggers, ['error_bar', 'error_foo']);
    assert.equal(fs.readdirSync(errorsDir).length, 0, 'successfully uploaded files should be deleted');
  });

  it('upload failure (5xx) keeps the file for the next attempt', async () => {
    fs.writeFileSync(path.join(errorsDir, '1700000003-keep.json'),
      JSON.stringify({ ts: '2026-05-08T17:00:00Z', kind: 'keep', detail: 'd' }));

    const { drainErrorSpool } = await import('../scripts/install-helpers/self-check.cjs');

    await withServer((_req, res) => res.status(500).json({ error: 'fail' }), async (url) => {
      const result = await drainErrorSpool(url, 'fake-key', { errorsDir });
      assert.equal(result.uploaded, 0);
      assert.equal(result.failed, 1);
    });

    assert.equal(fs.readdirSync(errorsDir).length, 1, 'failed-upload files should be retained');
  });

  it('no apiUrl/apiKey → skip without crashing, retain every file', async () => {
    fs.writeFileSync(path.join(errorsDir, '1700000004-x.json'),
      JSON.stringify({ ts: '2026-05-08T17:00:00Z', kind: 'x', detail: 'd' }));

    const { drainErrorSpool } = await import('../scripts/install-helpers/self-check.cjs');
    const result = await drainErrorSpool(null, null, { errorsDir });
    assert.equal(result.skipped, 'no_credentials');
    assert.equal(fs.readdirSync(errorsDir).length, 1);
  });

  it('errors/ missing → no crash, returns zero', async () => {
    fs.rmSync(errorsDir, { recursive: true, force: true });
    const { drainErrorSpool } = await import('../scripts/install-helpers/self-check.cjs');
    const result = await drainErrorSpool('http://x', 'k', { errorsDir });
    assert.equal(result.uploaded, 0);
    assert.equal(result.failed, 0);
  });
});

describe('interactive-upgrade.sh — dirty tree auto-recover', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.sh'), 'utf8');

  it('detects non-empty git status --porcelain (dirty tree)', () => {
    assert.match(content, /git status --porcelain/);
  });

  it('when dirty, sends an upgrade_dirty_tree error report', () => {
    assert.match(content, /upgrade_dirty_tree/);
  });

  it('when dirty, force-aligns with git fetch + git reset --hard origin/main (backup safety net runs first)', () => {
    assert.match(content, /git\s+fetch/);
    assert.match(content, /git\s+reset\s+--hard\s+origin\/main/);
  });
});

describe('interactive-upgrade.ps1 — dirty tree auto-recover (Windows)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.ps1'), 'utf8');

  it('detects non-empty git status --porcelain', () => {
    assert.match(content, /git\s+status\s+--porcelain/);
  });

  it('when dirty, sends an upgrade_dirty_tree error report', () => {
    assert.match(content, /upgrade_dirty_tree/);
  });

  it('when dirty, runs git fetch + reset --hard origin/main', () => {
    assert.match(content, /git\s+fetch/);
    assert.match(content, /git\s+reset\s+--hard\s+origin\/main/);
  });
});

describe('mcp/start.cmd — writes an errors/ spool file when node is missing', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'mcp/start.cmd'), 'utf8');

  it('includes an echo into the errors/ directory (cmd writes plain text to .txt)', () => {
    // When start.cmd cannot find node, it echoes the error to errors\<random>-mcp_start_no_node.txt
    assert.match(content, /errors\\/i, 'cmd must redirect to the logs\\errors\\ directory');
    assert.match(content, /mcp_start_no_node/, 'kind must be mcp_start_no_node');
  });
});
