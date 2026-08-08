import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * v1.26.95 — every field the shell hooks logged was thrown away on arrival.
 *
 * `log_event` built its extra key/value pairs flat:
 *
 *     {"ts":…,"event":"update_failed","tool":"claude-code","source":"hook","step":"pull"}
 *
 * and posted that same object to /api/activity/batch, where the handler reads `e.details`
 * and nothing else. `details` was absent, so the row stored `{}`.
 *
 * Measured on production 2026-08-07: 18 `update_failed` rows for one user and 9 for
 * another, every one of them with empty details. The step that failed was written to the
 * local file on their machine and dropped everywhere anyone would actually look.
 *
 * These tests execute the real `log_event` out of each hook, and parse its output with
 * JSON.parse rather than matching text — a string assertion would pass on output that is
 * shaped right and still not valid JSON.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const HOOKS = ['hooks/ownmind-session-start.sh', 'hooks/ownmind-iron-rule-check.sh'];

/**
 * Source the hook's `log_event` and call it, without running the rest of the hook.
 * Returns the line it appended to the local log, parsed.
 */
/**
 * Render one log_event argument for the generated bash. A plain string is JSON-quoted,
 * which bash reads literally — so `\n` in a JS string arrives as backslash-n, not a
 * newline. `{ bash }` is emitted verbatim, which is how a test feeds a real control
 * character (bash `$'…'` does interpret the escapes).
 */
function shArg(a) {
  return typeof a === 'object' && a !== null && 'bash' in a ? a.bash : JSON.stringify(a);
}

function callLogEvent(hookRelPath, args) {
  const src = fs.readFileSync(path.join(repoRoot, hookRelPath), 'utf8');
  const start = src.indexOf('log_event() {');
  assert.ok(start > 0, `${hookRelPath} no longer defines log_event`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, `${hookRelPath}: could not find the end of log_event`);
  const fn = src.slice(start, end + 3);
  // The slice stops at the first `}` in column 0, which is correct only while the function
  // body has no line-start brace of its own. Assert we captured the whole thing, so a future
  // `for … done` or heredoc truncates into a clear message rather than a bash syntax error.
  assert.match(fn, /local entry=/, `${hookRelPath}: log_event extraction was truncated`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-logev-'));
  try {
    const script = [
      `LOG_DIR=${JSON.stringify(dir)}`,
      'API_KEY=""',        // keep the upload branch from firing during a test
      'API_URL=""',
      fn,
      `log_event ${args.map(shArg).join(' ')}`,
    ].join('\n');
    // timeout so the keyless-argument regression fails loudly instead of hanging the run.
    execFileSync('bash', ['-c', script], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 });

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1, 'log_event should append to exactly one file');
    const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    return JSON.parse(lines[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Same as callLogEvent, but with credentials set and a stub `curl` first on PATH, so the
 * upload branch runs and we can read the exact body it was given.
 */
function callLogEventWithUpload(hookRelPath, args) {
  const src = fs.readFileSync(path.join(repoRoot, hookRelPath), 'utf8');
  const start = src.indexOf('log_event() {');
  const end = src.indexOf('\n}\n', start);
  const fn = src.slice(start, end + 3);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-logup-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const capture = path.join(dir, 'posted.json');
    // Records whatever followed -d, then exits 0 like the real thing.
    fs.writeFileSync(path.join(bin, 'curl'), [
      '#!/bin/bash',
      'while [ $# -gt 0 ]; do',
      `  if [ "$1" = "-d" ]; then printf '%s' "$2" > ${JSON.stringify(capture)}; fi`,
      '  shift',
      'done',
      'exit 0',
    ].join('\n'));
    fs.chmodSync(path.join(bin, 'curl'), 0o755);

    const script = [
      `export PATH=${JSON.stringify(bin)}:$PATH`,
      `LOG_DIR=${JSON.stringify(dir)}`,
      'API_KEY="k"',
      'API_URL="http://127.0.0.1:1"',
      fn,
      `log_event ${args.map(shArg).join(' ')}`,
      'wait',   // the upload is backgrounded with &
    ].join('\n');
    // timeout so the keyless-argument regression fails loudly instead of hanging the run.
    execFileSync('bash', ['-c', script], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 });

    const logFile = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    const local = JSON.parse(fs.readFileSync(path.join(dir, logFile), 'utf8').trim());
    assert.ok(fs.existsSync(capture), 'the upload branch never ran');
    return { local, posted: JSON.parse(fs.readFileSync(capture, 'utf8')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('v1.26.95 — the shell hooks log their fields where the server reads them', () => {
  for (const hook of HOOKS) {
    it(`${hook}: extras land inside details, not beside it`, () => {
      const e = callLogEvent(hook, ['update_failed', 'step', 'pull']);
      assert.equal(e.event, 'update_failed');
      assert.deepEqual(e.details, { step: 'pull' },
        'the batch endpoint reads e.details and nothing else — a flat field is discarded');
      assert.equal('step' in e, false, 'and must not also be left at the top level');
    });

    it(`${hook}: several pairs, and the fixed fields survive`, () => {
      const e = callLogEvent(hook, ['iron_rule_trigger', 'trigger', 'deploy', 'count', '27']);
      assert.deepEqual(e.details, { trigger: 'deploy', count: '27' });
      assert.equal(e.tool, 'claude-code');
      assert.equal(e.source, 'hook');
      assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    });

    it(`${hook}: no extras still produces valid JSON`, () => {
      // The empty case is the one a hand-rolled JSON builder gets wrong — a stray comma
      // makes the line unparseable, and the upload would be rejected silently.
      const e = callLogEvent(hook, ['init']);
      assert.deepEqual(e.details, {});
    });

    it(`${hook}: quotes and backslashes in a value do not break the line`, () => {
      const e = callLogEvent(hook, ['error', 'detail', 'C:\\Users\\Vin said "no"']);
      assert.deepEqual(e.details, { detail: 'C:\\Users\\Vin said "no"' });
    });

    it(`${hook}: a value with a newline or tab still parses`, () => {
      // Unescaped control characters make the line invalid JSON, the whole POST body is
      // rejected, and the event vanishes — the silent-loss shape this release is about.
      // No caller passes free text today; the next one to log an error message will.
      // $'…' so bash produces a genuine newline and tab, not the two-character escapes.
      const e = callLogEvent(hook, ['error', 'detail', { bash: "$'line one\\nline two\\tafter tab'" }]);
      assert.deepEqual(e.details, { detail: 'line oneline twoafter tab' },
        'control characters are stripped rather than emitted raw into the JSON');
    });

    it(`${hook}: a key with no value does not hang the hook`, () => {
      // `shift 2` with one argument left fails and shifts nothing, so `while [ $# -gt 0 ]`
      // spun forever: the session stalls with no output at all. Verified by running it.
      const e = callLogEvent(hook, ['update_failed', 'step', 'pull', 'orphan']);
      assert.deepEqual(e.details, { step: 'pull' }, 'the trailing keyless argument is dropped');
    });

    it(`${hook}: the body actually posted carries the same details`, () => {
      // Run the upload branch for real against a stub `curl` on PATH, and parse what it was
      // handed. A regex over the source would pass on a body that is shaped right and still
      // not valid JSON — and would never notice the two paths drifting apart.
      const { local, posted } = callLogEventWithUpload(hook, ['update_failed', 'step', 'npm']);
      assert.deepEqual(posted.events[0].details, { step: 'npm' });
      assert.deepEqual(posted.events[0], local, 'the uploaded event is the logged event');
    });
  }
});
