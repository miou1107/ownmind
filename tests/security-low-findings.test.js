import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeEqual } from '../src/utils/safe-equal.js';
import { errorResponse } from '../src/utils/error-response.js';
import { classifyMemoryError } from '../src/utils/memory-error-classifier.js';
import { makeOfflineHelpers } from '../mcp/offline.js';
import { writePrivateFile, appendPrivateFile } from '../shared/private-file.js';
import { tempDir } from './helpers/temp-dir.js';

/**
 * The low-severity findings of the 2026-10-03 security scan (v1.31.4).
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('setup token comparison', () => {
  it('matches only the exact secret', () => {
    assert.equal(safeEqual('s3cret-value', 's3cret-value'), true);
    assert.equal(safeEqual('s3cret-valuX', 's3cret-value'), false);
    assert.equal(safeEqual('s3cret', 's3cret-value'), false);
    assert.equal(safeEqual('', 's3cret-value'), false);
  });

  it('never matches a non-string or an unset secret', () => {
    assert.equal(safeEqual(undefined, 'x'), false);
    assert.equal(safeEqual(['x'], 'x'), false);
    assert.equal(safeEqual({ toString: () => 'x' }, 'x'), false);
    assert.equal(safeEqual('', ''), false);
  });

  it('the setup route uses it instead of !==', () => {
    const src = read('src/routes/admin.js');
    assert.match(src, /safeEqual\(req\.body\.setup_token, setupToken\)/);
    assert.doesNotMatch(src, /setup_token !== setupToken/);
  });
});

describe('errors do not carry server internals to the client', () => {
  it('a server failure gets a generic sentence', () => {
    const err = new Error('relation "memories" does not exist at /app/src/x.js');
    assert.deepEqual(errorResponse(err), { status: 500, body: { error: '伺服器內部錯誤' } });
    const e503 = Object.assign(new Error('pool exhausted'), { status: 503 });
    assert.equal(errorResponse(e503).body.error, '伺服器內部錯誤');
  });

  it('a request error keeps its message, which says what to fix', () => {
    const err = Object.assign(new Error('request entity too large'), { status: 413 });
    assert.deepEqual(errorResponse(err), { status: 413, body: { error: 'request entity too large' } });
    const hidden = Object.assign(new Error('internal'), { status: 400, expose: false });
    assert.equal(errorResponse(hidden).body.error, '伺服器內部錯誤');
  });

  it('a thrown 5xx in the memory routes keeps its message in the log', () => {
    const out = classifyMemoryError(Object.assign(new Error('ECONNREFUSED 10.0.0.5:5432'), { status: 502 }), { context: 'create' });
    assert.equal(out.status, 502);
    assert.equal(out.body.error, '建立記憶失敗');
    const four = classifyMemoryError(Object.assign(new Error('title too long'), { status: 400 }), { context: 'create' });
    assert.equal(four.body.error, 'title too long');
  });

  it('no route builds a 500 body from err.message', () => {
    for (const rel of ['src/routes/broadcast.js', 'src/routes/memory.js', 'src/routes/admin-work-log.js']) {
      const src = read(rel);
      assert.doesNotMatch(src, /status\(500\)\.json\([^)]*(err|e)\.message/, rel);
    }
  });
});

describe('the console build publishes no source map', () => {
  it('vite does not emit one', () => {
    assert.match(read('client/vite.config.js'), /sourcemap:\s*false/);
  });
});

describe('ids are escaped before they go into a request path', () => {
  it('no MCP call interpolates args.id raw', () => {
    const src = read('mcp/index.js');
    assert.doesNotMatch(src, /`\/api\/[^`]*\$\{args\.id\}/);
  });
});

describe('the offline cache answers only the account that wrote it', () => {
  const setup = () => {
    const dir = tempDir('ownmind-low-cache-');
    const cachePath = path.join(dir, 'cache', 'mcp-memories.json');
    const queuePath = path.join(dir, 'queue.jsonl');
    return { dir, cachePath, queuePath, h: makeOfflineHelpers(cachePath, queuePath, path.join(dir, 'none.json')) };
  };

  it('a cache stamped for another account, or not stamped, reads as absent', () => {
    const { h } = setup();
    h.writeMemoryCache({ saved_at: 'x', account: 'acct-A', data: { project: [{ id: 1, title: 'A secret' }] } });
    assert.equal(h.readMemoryCache('acct-B'), null);
    assert.equal(h.readMemoryCache('acct-A').data.project[0].title, 'A secret');
    assert.ok(h.readMemoryCache(), 'the init merge reads without a fingerprint and checks for itself');
    h.writeMemoryCache({ saved_at: 'x', data: { project: [] } });
    assert.equal(h.readMemoryCache('acct-A'), null);
  });

  it('every offline read in the MCP goes through the account check', () => {
    const src = read('mcp/index.js');
    const bare = src.split('\n').filter((l) => /readMemoryCache\(\)/.test(l) && !/previousDataForAccount/.test(l));
    assert.deepEqual(bare, []);
  });

  it('a write queued under another key is not sent with this one, and stays queued', async () => {
    const { h } = setup();
    h.enqueueOperation({ method: 'POST', path: '/api/memory', body: { title: 'mine' }, account: 'acct-B' });
    h.enqueueOperation({ method: 'POST', path: '/api/memory', body: { title: 'theirs' }, account: 'acct-A' });
    h.enqueueOperation({ method: 'POST', path: '/api/memory', body: { title: 'legacy' } });
    const sent = [];
    const out = await h.replayQueue(async (m, p, b) => { sent.push(b.title); }, 'tok', 'acct-B');
    assert.deepEqual(sent, ['mine', 'legacy']);
    assert.equal(out.replayed, 2);
    const left = h.readQueue();
    assert.deepEqual(left.map((o) => o.body.title), ['theirs']);
    assert.ok(left[0].queued_at, 'the original queue time survives a requeue');
  });

  it('writes waiting for another key are mentioned, not silently held', async () => {
    const { h } = setup();
    h.enqueueOperation({ method: 'POST', path: '/a', body: { title: 'x' }, account: 'other' });
    const out = await h.replayQueue(async () => { throw new Error('must not be called'); }, 'tok', 'me');
    assert.equal(out.replayed, 0);
    assert.match(out.message, /1 more queued under a different API key/);
    assert.equal(h.readQueue().length, 1);
    const empty = setup().h;
    assert.equal((await empty.replayQueue(async () => {}, 'tok', 'me')).message, null);
  });

  it('a failed replay keeps the rest and the other account\'s writes', async () => {
    const { h } = setup();
    h.enqueueOperation({ method: 'POST', path: '/a', body: { title: '1' }, account: 'me' });
    h.enqueueOperation({ method: 'POST', path: '/b', body: { title: '2' }, account: 'other' });
    h.enqueueOperation({ method: 'POST', path: '/c', body: { title: '3' }, account: 'me' });
    const out = await h.replayQueue(async (m, p) => { if (p === '/c') throw new Error('down'); }, 'tok', 'me');
    assert.equal(out.replayed, 1);
    assert.deepEqual(h.readQueue().map((o) => o.body.title).sort(), ['2', '3']);
  });
});

describe('memory caches are owner-only', { skip: process.platform === 'win32' && 'no POSIX modes on Windows' }, () => {
  it('new and existing files end up 0600 in a 0700 folder', () => {
    const dir = tempDir('ownmind-low-mode-');
    const f = path.join(dir, 'cache', 'c.json');
    writePrivateFile(f, '{}');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f)).mode & 0o077, 0);
    fs.chmodSync(f, 0o644);
    writePrivateFile(f, '{}');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'a file left 0644 by an older version is tightened');
    const q = path.join(dir, 'queue.jsonl');
    fs.writeFileSync(q, '', { mode: 0o644 });
    appendPrivateFile(q, 'x\n');
    assert.equal(fs.statSync(q).mode & 0o777, 0o600);
  });

  it('the SessionStart cache and the MCP rule cache use owner-only writes', () => {
    assert.match(read('hooks/lib/conditional-sync.js'), /mode: 0o600/);
    const mcp = read('mcp/index.js');
    assert.match(mcp, /writePrivateFile\(CACHE_PATH/);
    assert.match(mcp, /writePrivateFile\(cachePath/);
    assert.match(read('hooks/ownmind-git-pre-commit.js'), /writePrivateFile\(CACHE_FILE/);
    assert.match(read('hooks/lib/enforcement-cache.js'), /writePrivateFile\(file/);
    const lint = read('hooks/ownmind-reply-lint.js');
    assert.match(lint, /appendPrivateFile\(PENDING_FILE/);
    assert.match(lint, /appendPrivateFile\(COMPLIANCE_PENDING_FILE/);
  });
});
