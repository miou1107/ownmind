/**
 * v1.26.133 — the SessionStart hook destroyed the banner spool instead of showing it.
 *
 * Measured on Windows 2026-08-10, Claude Code desktop app, client 1.26.132:
 *
 *     📥 OwnMind messages queued from your last session:
 *     <nothing>
 *
 * and `logs/banner-pending.jsonl` went from 77 bytes to 0. drainSpools() printed that header,
 * called runLibScript('flush-pending-banners.js') — which spawns detached with all three
 * streams ignored — and truncated the file on the very next line. The CLI writes each block
 * to its own stderr, so the blocks went into a discarded pipe while the spool was emptied.
 *
 * The reason this is not a corner case: both writers of that spool (the tty-echo PostToolUse
 * hook and the reply-lint Stop hook) only write to it when they cannot open the terminal
 * device, and under the desktop app on Windows they never can. So the spool is the *only*
 * channel there — 19 banners accumulated in a 25-minute session, including a reply-lint
 * language warning — and this code deleted all of it, every session.
 *
 * Two things are asserted here: the parsing rule both drains share, and that the hook does
 * not go back to piping a spool into a child whose output it cannot see.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parsePendingBanners,
  renderPendingBanners,
  PENDING_BANNER_HEADER,
} from '../hooks/lib/pending-banners.js';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
/**
 * Source with comments removed, the way tests/scanner-schedule-ownership.test.js does it.
 *
 * The assertions below name the thing that must be gone, and this file explains at length why
 * it is gone — so matching the raw text would fail on its own explanation.
 */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const line = (block) => JSON.stringify({ ts: '2026-08-10T12:20:13.149Z', block });

describe('parsePendingBanners', () => {
  it('returns the blocks in the order they were queued', () => {
    const raw = [line('first'), line('second')].join('\n') + '\n';
    assert.deepEqual(parsePendingBanners(raw).blocks, ['first', 'second']);
  });

  it('keeps a multi-line block intact', () => {
    // A real banner is several lines: version header, the violation, the tip. Splitting one
    // into pieces would be as unreadable as losing it.
    const block = "[OwnMind v1.26.132] 🟢 OwnMind found something in the AI's reply that breaks your rules\n  ・lint_language_mixed_ratio: 67.3%";
    assert.deepEqual(parsePendingBanners(line(block) + '\n').blocks, [block]);
  });

  it('a broken line does not cost the readable ones, and comes back verbatim', () => {
    // Several processes append to this file, so a half-written record at the tail is a normal
    // thing to find rather than corruption. It is returned rather than counted because the
    // caller writes the remainder back, and a count cannot be written back.
    const broken = '{"block": "truncated';
    const raw = [line('kept'), broken, line('also kept')].join('\n');
    const { blocks, unreadable } = parsePendingBanners(raw);
    assert.deepEqual(blocks, ['kept', 'also kept']);
    assert.deepEqual(unreadable, [broken]);
  });

  it('keeps a record that parses but carries no block', () => {
    // Otherwise a spool full of these looks exactly like an empty queue, and the caller
    // deletes it without anybody having seen what was in it.
    const lines = [JSON.stringify({ ts: 'x' }), JSON.stringify({ ts: 'x', block: '' })];
    const { blocks, unreadable } = parsePendingBanners(lines.join('\n'));
    assert.deepEqual(blocks, []);
    assert.deepEqual(unreadable, lines);
  });

  it('an empty or blank spool is not an error and not unreadable', () => {
    for (const raw of ['', '\n\n', '   ']) {
      assert.deepEqual(parsePendingBanners(raw), { blocks: [], unreadable: [] });
    }
  });

  it('a non-string input yields nothing rather than throwing', () => {
    // This runs inside SessionStart; a throw here would cost the memory load.
    for (const raw of [null, undefined, 42, {}]) {
      assert.deepEqual(parsePendingBanners(raw), { blocks: [], unreadable: [] });
    }
  });
});

describe('renderPendingBanners', () => {
  it('prints the header above the blocks', () => {
    const out = renderPendingBanners(['one', 'two']);
    assert.ok(out.startsWith(PENDING_BANNER_HEADER), 'the header must come first');
    assert.match(out, /one/);
    assert.match(out, /two/);
    assert.ok(out.indexOf('one') < out.indexOf('two'), 'queue order must survive rendering');
  });

  it('renders nothing at all when there are no blocks — no lonely header', () => {
    // The lonely header is what the defect looked like from the user's side: a promise of
    // messages with nothing under it. It is also the caller's signal to keep the spool.
    for (const blocks of [[], null, undefined]) {
      assert.equal(renderPendingBanners(blocks), '');
    }
  });
});

describe('the SessionStart hook leaves the banner spool alone (v1.26.171)', () => {
  const HOOK = 'hooks/ownmind-session-start.js';

  // The flush this block used to test is gone on purpose. Notices are delivered at the turn
  // they happen, as systemMessage on the Stop hook's stdout; the spool is a durable audit
  // record, rotated by its writer. The old flush wrote the blocks to this hook's stderr -
  // which at exit 0 goes to the debug log, not the user - and then erased the file: an
  // invisible re-announcement that destroyed the only record. What is asserted now is that
  // no code path here reads, pipes, or truncates the spool.

  it('no code path flushes or truncates the spool', () => {
    const src = codeOnly(read(HOOK));
    assert.doesNotMatch(src, /flushPendingBannerFile\s*\(/,
      'the session-start flush is back - notices already reached the user at their own turn');
    assert.doesNotMatch(src, /runLibScript\(\s*'flush-pending-banners\.js'/,
      'the banner flush is back in a child process whose stderr is discarded');
  });

  it('end to end: a queued banner survives a session start untouched', () => {
    const home = tempDir('ownmind-banner-');
    try {
      const logs = path.join(home, '.ownmind', 'logs');
      fs.mkdirSync(logs, { recursive: true });
      const spool = path.join(logs, 'banner-pending.jsonl');
      const content = line('[OwnMind test] audit record, not a message queue') + '\n';
      fs.writeFileSync(spool, content);

      spawnSync(process.execPath, [path.join(repoRoot, HOOK)], {
        encoding: 'utf8',
        input: JSON.stringify({ session_id: 't', hook_event_name: 'SessionStart', source: 'startup' }),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          OWNMIND_API_URL: 'http://127.0.0.1:1',
          OWNMIND_API_KEY: '00000000-0000-4000-8000-000000000000',
        },
        timeout: 30000,
      });

      assert.equal(fs.readFileSync(spool, 'utf8'), content,
        'the audit spool must come through a session start byte-for-byte intact');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
