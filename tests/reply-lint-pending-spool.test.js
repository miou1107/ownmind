import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { tempDir } from './helpers/temp-dir.js';

/**
 * v1.17.97 — hook-side conditional spool: only write reply-lint-pending.jsonl
 * when POST fails.
 *
 * Why: in v1.17.96 the hook wrote YYYY-MM-DD.jsonl as an archive whether the
 * POST succeeded or failed, but no reader actively picked it up — an effective
 * black hole. v1.17.97 adds a SessionStart flush that does pick it up; if the
 * hook also writes into the same file unconditionally, the flush will
 * re-deliver successful events and cause DB duplicates.
 *
 * Fix (smallest possible, preserves archive behavior):
 *   - Keep the YYYY-MM-DD.jsonl writes (archive / debugging, no reader).
 *   - Add reply-lint-pending.jsonl; only written on POST failure / NO_NETWORK.
 *   - SessionStart flush reads only reply-lint-pending.jsonl, never the archive.
 */

const repoRoot = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const hookPath = path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js');

let tmpHome;
let pendingSpoolPath;
let archiveDir;
let transcriptPath;

function setupTmpHome() {
  tmpHome = tempDir('ownmind-pending-spool-test-');
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  archiveDir = path.join(tmpHome, '.ownmind', 'logs');
  pendingSpoolPath = path.join(archiveDir, 'reply-lint-pending.jsonl');
  transcriptPath = path.join(tmpHome, 'transcript.jsonl');
  // v1.26.13: seed validator cache so violations actually fire (rule-driven).
  const cacheDir = path.join(tmpHome, '.ownmind', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'iron_rules.json'), JSON.stringify([
    { code: 'TEST-JARGON', metadata: { lint_validator: { name: 'jargon_explanation', params: {} } } },
    { code: 'TEST-MIXED', metadata: { lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.15 } } } },
  ]));
}
function cleanupTmpHome() { fs.rmSync(tmpHome, { recursive: true, force: true }); }

function writeViolatingTranscript() {
  const turn = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'I really should refactor everything completely from scratch immediately because clearly bugs.' }] },
  });
  fs.writeFileSync(transcriptPath, turn + '\n');
}

function setupCredentials(apiUrl) {
  const claudeDir = path.join(tmpHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'k', OWNMIND_API_URL: apiUrl } } },
  }));
}

function runHook(env = {}) {
  return spawnSync('node', [hookPath], {
    input: JSON.stringify({
      session_id: 'x',
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      OWNMIND_TTY_FORCE_FALLBACK: '1',
      ...env,
    },
  });
}

/**
 * Async spawn variant — required when the fake server and the hook share the
 * same Node process. spawnSync blocks the event loop, so the fake server can
 * never accept connections and the hook sees ECONNREFUSED.
 */
function runHookAsync(env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [hookPath], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        OWNMIND_TTY_FORCE_FALLBACK: '1',
        ...env,
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({ status: code, stdout, stderr }));
    child.stdin.write(JSON.stringify({
      session_id: 'x',
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }));
    child.stdin.end();
  });
}

describe('v1.17.97 — hook conditional spool (pending only on failure)', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('POST success → reply-lint-pending.jsonl must NOT be created', async () => {
    const server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        let body = ''; req.on('data', c => body += c);
        req.on('end', () => { res.statusCode = 200; res.end('{"inserted":1}'); });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      writeViolatingTranscript();
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      setupCredentials(apiUrl);
      // Must use async spawn — fake server + hook share the same process and spawnSync deadlocks.
      const r = await runHookAsync({ OWNMIND_REPLY_LINT_API_URL: apiUrl });
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      assert.equal(fs.existsSync(pendingSpoolPath), false,
        'POST success must not write reply-lint-pending.jsonl (otherwise SessionStart flush would re-deliver)');
    } finally { server.close(); }
  });

  it('POST failure (server not running) → reply-lint-pending.jsonl must be written', () => {
    writeViolatingTranscript();
    // Point at a port no one is listening on — POST must fail.
    setupCredentials('http://127.0.0.1:1');  // port 1 reserved, no server
    const r = runHook({ OWNMIND_REPLY_LINT_API_URL: 'http://127.0.0.1:1' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.ok(fs.existsSync(pendingSpoolPath),
      'POST failure must spool to the pending file for the next SessionStart flush');
    const lines = fs.readFileSync(pendingSpoolPath, 'utf8').trim().split('\n');
    assert.ok(lines.length > 0);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.event, 'iron_rule_compliance');
    assert.equal(ev.details.action, 'violate');
    // v1.20.4: rule_code may be empty (rule cache has no entry); verify triggered_by_event instead.
    assert.match(
      ev.details.triggered_by_event,
      /^(lint_|privacy_check)/,
      'triggered_by_event must be a neutral event constant'
    );
  });

  it('NO_NETWORK mode → reply-lint-pending.jsonl must be written (offline / tests / opt-out)', () => {
    writeViolatingTranscript();
    setupCredentials('http://127.0.0.1:1');
    const r = runHook({ OWNMIND_REPLY_LINT_NO_NETWORK: '1' });
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingSpoolPath),
      'NO_NETWORK mode (offline / tests) must also spool — flushed when network comes back');
  });

  it('no violation → neither archive nor pending should be written', () => {
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '好、用全中文回應、沒違反。' }] },
    }) + '\n');
    setupCredentials('http://127.0.0.1:1');
    const r = runHook({ OWNMIND_REPLY_LINT_NO_NETWORK: '1' });
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingSpoolPath), false,
      'no violation → must not touch pending file');
  });

  // review-N1: 1MB size cap + rotate
  it('pending file exceeds 1MB → rotate to .old; new spool starts from a clean file', () => {
    // Write a > 1MB pending file.
    const padding = 'x'.repeat(1100 * 1024);
    fs.writeFileSync(pendingSpoolPath, padding);
    const oldStat = fs.statSync(pendingSpoolPath);
    assert.ok(oldStat.size > 1024 * 1024);

    writeViolatingTranscript();
    setupCredentials('http://127.0.0.1:1');
    runHook({ OWNMIND_REPLY_LINT_NO_NETWORK: '1' });

    // .old must exist (rotated).
    assert.ok(fs.existsSync(pendingSpoolPath + '.old'),
      '> 1MB old pending must be rotated to .old');
    // New pending must contain only the freshly-added entry (< 5KB).
    const newStat = fs.statSync(pendingSpoolPath);
    assert.ok(newStat.size < 10 * 1024,
      `post-rotate pending should contain only the new event; actual ${newStat.size} bytes`);
  });

  // v1.17.98 — client_event_id must appear in spooled events
  it('every spooled event must carry a valid UUID v4 client_event_id', () => {
    writeViolatingTranscript();
    setupCredentials('http://127.0.0.1:1');
    runHook({ OWNMIND_REPLY_LINT_NO_NETWORK: '1' });
    assert.ok(fs.existsSync(pendingSpoolPath));
    const lines = fs.readFileSync(pendingSpoolPath, 'utf8').trim().split('\n');
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const line of lines) {
      const ev = JSON.parse(line);
      assert.ok(ev.client_event_id, 'every spooled event must have a client_event_id');
      assert.match(ev.client_event_id, uuidV4, 'client_event_id must be a valid UUID v4');
    }
  });

  it('the same violation spooled twice (hook + flush) must reuse the same id (no regeneration)', () => {
    // First: hook runs, POST fails → one event spooled to pending, with an id.
    writeViolatingTranscript();
    setupCredentials('http://127.0.0.1:1');
    runHook({ OWNMIND_REPLY_LINT_NO_NETWORK: '1' });
    const linesAfterHook = fs.readFileSync(pendingSpoolPath, 'utf8').trim().split('\n');
    const idAfterHook = JSON.parse(linesAfterHook[0]).client_event_id;
    // The same events array object should reuse the id (events are the same object inside the hook;
    // we never generate the id twice). This test verifies that spool and archive write the same
    // events object, so the id matches.
    // Archive file name format: YYYY-MM-DD.jsonl.
    const today = new Date().toISOString().slice(0, 10);
    const archivePath = path.join(tmpHome, '.ownmind', 'logs', `${today}.jsonl`);
    if (fs.existsSync(archivePath)) {
      const arch = JSON.parse(fs.readFileSync(archivePath, 'utf8').trim().split('\n')[0]);
      assert.equal(arch.client_event_id, idAfterHook,
        'archive and pending must use the same client_event_id (the hook must not regenerate it)');
    }
  });

  it('existing pending content + a new failed round → append (do not overwrite)', () => {
    fs.writeFileSync(pendingSpoolPath, JSON.stringify({
      ts: '2026-05-12T00:00:00.000Z',
      event: 'iron_rule_compliance',
      tool: 'claude-code',
      source: 'reply-lint-hook',
      details: { action: 'violate', rule_code: '', triggered_by_event: 'lint_language_mixed_ratio', message: 'old' },
    }) + '\n');
    writeViolatingTranscript();
    setupCredentials('http://127.0.0.1:1');
    runHook({ OWNMIND_REPLY_LINT_NO_NETWORK: '1' });
    const lines = fs.readFileSync(pendingSpoolPath, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 2, 'existing + new — append mode');
    assert.equal(JSON.parse(lines[0]).details.message, 'old');
  });
});
