import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { localDateOnly, localIsoTimestamp } from '../shared/local-date.js';
// v1.26.109: the script goes to bash as a file, never as a `-c` command line, because a
// command line gets re-parsed and loses backslashes on Windows. tests/bash-c-escaping.test.js
// enforces this for every test file.
import { spawnBashScript } from './helpers/bash-script.js';

/**
 * v1.26.124 — three programs share one log directory and one update marker, and they did
 * not agree on what day it was.
 *
 * Measured on the real machine at 07:38 local on 2026-08-10 (UTC+8), every value live:
 *
 *     shell hook   `date +%Y-%m-%d`                 2026-08-10
 *     MCP          localDateOnly()                  2026-08-10
 *     Node hooks   toISOString().slice(0, 10)       2026-08-09   <-- the odd one out
 *
 * Two consequences, both silent:
 *
 *   1. `.last-update-check` held 2026-08-09. The Node hook (Claude Code) read that as
 *      "checked today" and skipped. The shell hook (Gemini CLI) read it as "not checked"
 *      and ran the whole update — then wrote 2026-08-10, at which point the Node hook
 *      disagreed in the other direction. Both are registered on this machine. Two programs
 *      deciding to update at the same moment is the one thing the update lock exists to
 *      survive, and this manufactured that race for eight hours a day.
 *
 *   2. Events written by the hooks landed in yesterday's YYYY-MM-DD.jsonl while events
 *      written by the MCP landed in today's, so "today's log" held half the story from
 *      local midnight until 08:00.
 *
 * The project rule predates all of it — mcp/ownmind-log.js, v1.20.1: "Per timezone
 * discipline, OwnMind defines 'today' in the user's local timezone."
 *
 * Why it survived: where local == UTC the two branches return the same string, so CI and
 * any UTC server are structurally incapable of reproducing it. The only machine it happens
 * on is a developer's own.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** True when this machine's clock is offset from UTC, i.e. when the bug was observable. */
const OFFSET_MINUTES = -new Date().getTimezoneOffset();

describe('localDateOnly is the local calendar date', () => {
  it('agrees with the local calendar fields, not with UTC', () => {
    const now = new Date();
    const expected = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');
    assert.equal(localDateOnly(now), expected);
  });

  it('a fixed instant resolves by local offset, not by UTC', () => {
    // 2026-08-09T23:13:15Z is 2026-08-10 in any zone at or east of UTC+1, and still
    // 2026-08-09 west of UTC. Assert against the machine's own reading of that instant, so
    // the test states the rule rather than assuming a timezone.
    const instant = new Date(Date.UTC(2026, 7, 9, 23, 13, 15));
    assert.equal(localDateOnly(instant), [
      instant.getFullYear(),
      String(instant.getMonth() + 1).padStart(2, '0'),
      String(instant.getDate()).padStart(2, '0'),
    ].join('-'));
  });

  it('reverse control: east of UTC the old UTC expression really did differ', {
    skip: OFFSET_MINUTES <= 0
      ? `this machine runs at UTC${OFFSET_MINUTES === 0 ? '' : OFFSET_MINUTES}; the local and UTC dates cannot diverge in the direction this bug needed. The two tests above still run and pin the rule.`
      : false,
  }, () => {
    // Local 00:30 on a machine east of UTC is the previous day in UTC — the exact window
    // the two hooks spent disagreeing. Without this, "use local" could be satisfied by an
    // implementation that happens to equal UTC and nobody would notice.
    const local = new Date(2026, 7, 10, 0, 30, 0);
    assert.equal(localDateOnly(local), '2026-08-10');
    assert.notEqual(
      local.toISOString().slice(0, 10),
      localDateOnly(local),
      'the pre-fix expression must be shown to produce a different day, or this fix proves nothing',
    );
  });
});

describe('localIsoTimestamp', () => {
  it('its date half is the same day as localDateOnly', () => {
    // A line stamped 2026-08-09 sitting in a file named 2026-08-10 is how the old mixture
    // read. The timestamp and the filename now cannot describe different days.
    const now = new Date();
    assert.equal(localIsoTimestamp(now).slice(0, 10), localDateOnly(now));
  });

  it('is a real instant that parses back to the same moment', () => {
    // Carrying an offset is only useful if it is the right offset: a correct parser must
    // recover the original instant to the second.
    const now = new Date();
    const parsed = new Date(localIsoTimestamp(now));
    assert.equal(Math.floor(parsed.getTime() / 1000), Math.floor(now.getTime() / 1000));
  });
});

describe('the shell hooks agree with the JS helper', () => {
  const bash = spawnBashScript('date +%Y-%m-%d\n', { encoding: 'utf8' });

  it('`date +%Y-%m-%d` — the expression both .sh hooks use — returns the same day', {
    skip: bash.error || bash.status !== 0
      ? 'bash is not available here; the guard test below still fails if a JS program reverts to UTC'
      : false,
  }, () => {
    // Anti-drift. The shell hooks were never wrong, so this is the fixed point the JS side
    // had to be moved onto. Reading the real command rather than restating it means a
    // change to either side breaks this.
    assert.equal(bash.stdout.trim(), localDateOnly(new Date()));
  });
});

describe('no program that shares the log directory computes the day in UTC', () => {
  // The three files below write into ~/.ownmind/logs or read/write .last-update-check.
  // A UTC date-only expression in any one of them re-creates the disagreement, and it does
  // so invisibly on every machine whose CI runs in UTC — which is every machine's CI.
  const SHARERS = [
    'hooks/ownmind-session-start.js',
    'hooks/ownmind-reply-lint.js',
    'mcp/index.js',
    'mcp/ownmind-log.js',
  ];

  for (const rel of SHARERS) {
    it(`${rel} has no toISOString().slice(0, 10)`, () => {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      // Strip comments first: these files document the old expression on purpose, and a
      // guard that cannot tell an explanation from a call would force the explanation out.
      const code = src
        .split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const hit = /toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/.exec(code);
      assert.equal(
        hit,
        null,
        `${rel} computes a date-only string in UTC. Use localDateOnly from shared/local-date.js — see the header of that file for what the mismatch did.`,
      );
    });
  }

  it('reverse control: the guard fires on the expression it exists to catch', () => {
    // Otherwise a typo in the regex would make all four tests above pass forever.
    const code = "const today = new Date().toISOString().slice(0, 10);";
    assert.ok(/toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/.test(code));
  });
});

describe('the shared helper is the single definition', () => {
  it('mcp/ownmind-log.js re-exports it rather than keeping its own copy', async () => {
    // v1.20.1 put localDateOnly here and the hooks could not reach it, so they each grew a
    // UTC copy. If this file ever defines its own again, that split is back.
    const mod = await import(pathToFileURL(path.join(repoRoot, 'mcp/ownmind-log.js')).href);
    assert.equal(typeof mod.localDateOnly, 'function', 'existing importers rely on this export');
    assert.equal(
      mod.localDateOnly(new Date(2026, 7, 10, 0, 30)),
      localDateOnly(new Date(2026, 7, 10, 0, 30)),
      'ownmind-log.js must resolve to the shared implementation, not a second one',
    );
  });
});
