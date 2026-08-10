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
import { fileURLToPath } from 'node:url';

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

describe('a failed local write does not also cost the upload', () => {
  it('the event is buffered before the file is touched', () => {
    // Both live in one try/catch. Written the other way round, an unwritable directory throws
    // on appendFileSync and the buffer.push below it never runs — so the event is not merely
    // unstored, it is never sent either. That is the state the two stale machines are in.
    const src = read(LOGGER);
    const body = src.slice(src.indexOf('export function logEvent'));
    const buffered = body.indexOf('buffer.push(entry)');
    const written = body.indexOf('appendFileSync(');
    assert.ok(buffered !== -1 && written !== -1, 'logEvent no longer buffers or no longer writes');
    assert.ok(buffered < written,
      'the local write happens first, so one unwritable directory deletes the event entirely');
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
