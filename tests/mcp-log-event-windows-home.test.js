/**
 * v1.26.131 — the MCP could report "alive" every day and never report a single update outcome.
 *
 * Measured on production 2026-08-10. Nine users. Seven are on the current build and have
 * hundreds of activity events. The two who are badly stale — one frozen six days at 1.26.57,
 * one frozen eight weeks at 1.26.27 — have **zero** activity events in twenty days, while
 * their MCP heartbeat arrives every single day. They are also the only two who do not run
 * Claude Code.
 *
 * Two defects in `mcp/ownmind-log.js` produce exactly that, and both are in this file:
 *
 * 1. `join(process.env.HOME || '', '.ownmind', 'logs')`. **HOME is not set on Windows.** The
 *    logs directory therefore resolved relative to whatever working directory the host
 *    launched the MCP in. Where that is not writable, `ensureDir()` throws.
 *
 *    This repo has already paid for this once: the comment above the auto-update block in
 *    `mcp/index.js` records v1.17.22 — "root cause of Alice (Windows) / Bob being stuck on
 *    old versions: process.env.HOME is undefined on Windows". That file was fixed to
 *    `os.homedir()`. Its logger, sitting one import away, was not.
 *
 * 2. `logEvent` writes the local file **before** pushing to the upload buffer, inside one
 *    `try { } catch { }`. So a filesystem failure does not degrade the event to
 *    "uploaded but not stored locally" — it deletes the event entirely, in silence. One
 *    unwritable directory costs both copies.
 *
 * The heartbeat survives because it touches no filesystem, which is why these machines look
 * healthy from the server and cannot be diagnosed from it.
 *
 * Third, separate: the update outcomes are the events a stuck machine most needs to send, and
 * they were not in the immediate-flush set. The buffer waits for ten events or thirty
 * seconds, and an MCP child process on Windows is terminated rather than signalled, so
 * `beforeExit` / SIGTERM never run. One event a day does not need batching.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGGER = 'mcp/ownmind-log.js';
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

describe('the logs directory does not depend on $HOME', () => {
  it('resolves to an absolute path when HOME is unset — the Windows case', async () => {
    const { resolveLogsDir } = await import('../mcp/ownmind-log.js');
    const saved = process.env.HOME;
    try {
      delete process.env.HOME;
      const dir = resolveLogsDir();
      assert.ok(path.isAbsolute(dir),
        `logs dir is relative without HOME (${dir}); on Windows it would land in whatever `
        + 'directory the host launched the MCP from');
      assert.equal(dir, path.join(os.homedir(), '.ownmind', 'logs'));
    } finally {
      if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    }
  });

  it('prefers USERPROFILE over an empty string', async () => {
    // The shape the rest of the repo uses. Pinned so a future edit cannot quietly go back to
    // `process.env.HOME || ''`, which is a valid-looking expression that yields a relative path.
    const { resolveLogsDir } = await import('../mcp/ownmind-log.js');
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    try {
      delete process.env.HOME;
      process.env.USERPROFILE = path.join(os.tmpdir(), 'ownmind-profile-test');
      assert.equal(resolveLogsDir(),
        path.join(os.tmpdir(), 'ownmind-profile-test', '.ownmind', 'logs'));
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
    }
  });

  it('the source never falls back to an empty string', () => {
    // The defect in one assertion: `process.env.HOME || ''` reads as a safe default and is
    // the thing that produced a relative path.
    //
    // Comments are stripped first, because the fix documents the old expression verbatim —
    // matching the whole file would fail on the explanation of the bug rather than the bug.
    const code = read(LOGGER).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /process\.env\.HOME\s*\|\|\s*''/,
      'an empty-string fallback makes the logs directory relative to the process cwd');
    // Reverse control: the stripper must not have eaten the code along with the prose.
    assert.match(code, /export function resolveLogsDir/,
      'comment stripping removed the implementation; this assertion would pass on an empty file');
  });
});

/**
 * Log one event in a child process and resolve when it exits.
 *
 * A child, because the module reads its credentials once at import. Asynchronous, because the
 * child posts back to a server running in *this* process: spawnSync blocks this event loop,
 * so the connection is never accepted, the child's fetch never returns, and the two deadlock.
 * The first draft of this test did exactly that and hung.
 */
function runChild({ env, source: body }) {
  const source = `
    const { logEvent } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, LOGGER)).href)});
    ${body || "logEvent('update_failed', { source: 'mcp', step: 'pull' });"}
    await new Promise((r) => setTimeout(r, 500));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.resume();
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child timed out')); }, 20000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr }); });
  });
}

describe('a failed local write does not also cost the upload', () => {
  it('an unwritable logs directory still sends the event to the server', async (t) => {
    // Run for real against a throwaway HTTP server, because the source-text version of this
    // assertion did not defend the fix. The original throw came from ensureDir(), which was
    // the *first* statement in the try — not from appendFileSync — so "buffer.push appears
    // before appendFileSync" is satisfied by the broken code as well as the fixed code.
    //
    // HOME points at a regular file, so mkdirSync fails with ENOTDIR. That is this defect's
    // shape on a machine where the resolved directory cannot be created.
    const tmp = tempDir('ownmind-log-');
    const notADir = path.join(tmp, 'home-is-a-file');
    fs.writeFileSync(notADir, 'not a directory');

    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ url: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

    // A child process, because the module reads the credentials once at import.
    const port = server.address().port;
    const child = await runChild({
      env: {
        ...process.env,
        HOME: notADir,
        USERPROFILE: notADir,
        OWNMIND_API_URL: `http://127.0.0.1:${port}`,
        OWNMIND_API_KEY: 'test-key',
      },
    });
    assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);

    assert.equal(received.length, 1,
      'nothing reached the server: the local write failed and took the upload with it, which '
      + 'is the defect — an event that cannot be stored locally must still be reportable');
    assert.match(received[0].url, /\/api\/activity\/batch/);
    assert.match(received[0].body, /update_failed/);
  });

  it('one unserialisable event does not take the buffered ones with it', async (t) => {
    // Reordering created this hazard: an entry that cannot be stringified used to throw at
    // the local write, before it was ever buffered, costing one event. Buffered first, the
    // throw would instead land inside flushToServer — after buffer.splice has already
    // emptied the buffer — destroying up to nine unrelated events on the way out.
    //
    // BigInt is the cheapest thing JSON.stringify refuses.
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push(body); res.end('{}'); });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections?.(); server.close(); });

    const port = server.address().port;
    const child = await runChild({
      env: {
        ...process.env,
        OWNMIND_API_URL: `http://127.0.0.1:${port}`,
        OWNMIND_API_KEY: 'test-key',
      },
      // `init` is not an immediate-flush event, so it waits in the buffer. The poisoned entry
      // follows it, then an immediate event forces the flush that has to survive.
      source: `
        logEvent('init', { source: 'mcp', status: 'ok' });
        logEvent('init', { source: 'mcp', poison: 1n });
        logEvent('update_failed', { source: 'mcp', step: 'pull' });
      `,
    });
    assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);

    const all = received.join('');
    assert.match(all, /"status":"ok"/,
      'the innocent buffered event never arrived: one unserialisable entry emptied the buffer '
      + 'and then threw, taking everything queued behind it');
    assert.match(all, /update_failed/, 'the flush that had to survive did not happen at all');
  });

  it('reverse control: the same probe sees nothing when the server is not told', async (t) => {
    // Without this, a probe that silently never POSTs anywhere would "pass" the moment the
    // assertion above were inverted, and the whole test would be measuring its own plumbing.
    const received = [];
    const server = http.createServer((req, res) => { received.push(req.url); res.end('{}'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections?.(); server.close(); });

    const child = await runChild({
      // No OWNMIND_API_URL / OWNMIND_API_KEY: flushToServer returns early.
      env: { ...process.env, OWNMIND_API_URL: '', OWNMIND_API_KEY: '' },
    });
    assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);
    assert.equal(received.length, 0, 'the probe posts even without credentials, so it proves nothing');
  });
});

describe('update outcomes are sent immediately', () => {
  // These are the events a machine that cannot update most needs to send, they happen once a
  // day, and the host may terminate the MCP without a signal — so there is no later.
  const src = read(LOGGER);
  const set = src.slice(src.indexOf('IMMEDIATE_FLUSH_EVENTS'),
    src.indexOf(']', src.indexOf('IMMEDIATE_FLUSH_EVENTS')));

  for (const event of ['update_applied', 'update_failed', 'update_skipped', 'update_clean']) {
    it(`${event} is not left in the buffer`, () => {
      assert.match(set, new RegExp(`'${event}'`),
        `${event} waits for ten events or a thirty-second timer; a machine whose MCP is `
        + 'terminated before then reports a heartbeat and nothing else, which is exactly '
        + 'how two users sat on stale versions unnoticed');
    });
  }

  it('reverse control: the slice really is the set and not the whole file', () => {
    assert.doesNotMatch(set, /export function logEvent/,
      'the IMMEDIATE_FLUSH_EVENTS slice ran past its end; these assertions are vacuous');
  });
});
