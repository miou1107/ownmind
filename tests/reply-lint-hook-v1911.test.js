/**
 * v1.19.11 — reply-lint hook tiered display + log persistence tests
 *
 * Tracks openspec/changes/v1.19.11-lint-ux-improvements/spec.md scenarios 5–10, 13–14.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  '..'
);
const hookPath = path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js');

let tmpHome;
let transcriptPath;
let eventLogPath;

function setup() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-v1911-'));
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  transcriptPath = path.join(tmpHome, 'transcript.jsonl');
  eventLogPath = path.join(tmpHome, '.ownmind', 'logs', 'reply-lint-events.jsonl');
  // v1.26.13: seed validator cache (rule-driven; empty cache = no lint).
  const cacheDir = path.join(tmpHome, '.ownmind', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'iron_rules.json'), JSON.stringify([
    { code: 'TEST-JARGON', metadata: { lint_validator: { name: 'jargon_explanation', params: {} } } },
    { code: 'TEST-MIXED', metadata: { lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.15 } } } },
  ]));
}

function teardown() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

function runHook(input, env = {}) {
  return spawnSync('node', [hookPath], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      OWNMIND_TTY_FORCE_FALLBACK: '1',
      OWNMIND_REPLY_LINT_NO_NETWORK: '1',
      ...env,
    },
  });
}

function writeTranscript(text) {
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

function stopPayload(extra = {}) {
  return {
    session_id: 'v1911-test-' + Math.random(),
    transcript_path: transcriptPath,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    ...extra,
  };
}

const VIOLATING_TEXT = 'I think we should monomorphism the codeapp using a completely fresh approach because the implementation has obvious bugs.';

// ============================================================
// Scenarios 5 + 7: first block; full annotated message
// ============================================================

describe('v1.19.11 scenarios 5+7 — first block; full message including annotation requirement', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('4th violation (1st block) → stderr contains the full directive + annotation requirement', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-block-1';
    const payload = stopPayload({ session_id: sid });

    for (let i = 1; i <= 3; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r4 = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r4.status, 2, '4th violation should exit 2');

    // Full directive opens with the original "please rewrite" line.
    assert.match(r4.stderr, /Please rewrite/);
    // Includes the annotation requirement.
    assert.match(r4.stderr, /rewrite must start with a quoted-block annotation/);
    // Includes the markdown quote example.
    assert.match(r4.stderr, /^> ⚠️/m);
    // Includes the separator example.
    assert.match(r4.stderr, /^---$/m);
  });
});

// ============================================================
// Scenario 8: 2nd-3rd block; short message
// ============================================================

describe('v1.19.11 scenario 8 — 2nd–3rd block; short message', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('5th violation (2nd block) → short message; no full list', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-block-2';
    const payload = stopPayload({ session_id: sid });

    // Run the first 4 (1st block).
    for (let i = 1; i <= 4; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }

    // 5th (2nd block).
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2);

    // Short message contains "↻" + session count.
    assert.match(r.stderr, /↻/);
    assert.match(r.stderr, /session block #2/);

    // Must not contain the full rewrite directive list.
    assert.ok(
      !r.stderr.includes('1. Use plain Chinese to replace the following English terms'),
      'short message must not contain the full violation-word list'
    );
  });

  it('6th violation (3rd block) → still short', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-block-3';
    const payload = stopPayload({ session_id: sid });

    for (let i = 1; i <= 5; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /session block #3/);
  });
});

// ============================================================
// Scenario 9: 4th block downgrades to warning (preserves v1.19.7 behavior)
// ============================================================

describe('v1.19.11 scenario 9 — 4th block hits downgrade limit; switch to warning', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('after 3 consecutive blocks, the 4th downgrades to exit 1 warning', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-downgrade';
    const payload = stopPayload({ session_id: sid });

    // Run the first 6 (3 accumulate + 3 blocks → block_count=3).
    for (let i = 1; i <= 6; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }

    // 7th (block_count=3, should downgrade to warning).
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 1, 'should downgrade to warning exit 1');
    assert.match(r.stderr, /blocked .* times in a row|downgrading to warning/);
  });
});

// ============================================================
// Scenario 10: block events are written to reply-lint-events.jsonl
// ============================================================

describe('v1.19.11 scenario 10 — block events are persisted', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('after a block, reply-lint-events.jsonl has a new entry', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-log';
    const payload = stopPayload({ session_id: sid });

    for (let i = 1; i <= 3; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    // 4th block.
    runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });

    assert.equal(fs.existsSync(eventLogPath), true, 'reply-lint-events.jsonl should exist');
    const lines = fs.readFileSync(eventLogPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, 'at least one block entry');

    const lastEntry = JSON.parse(lines[lines.length - 1]);
    assert.equal(lastEntry.session_id, sid);
    assert.equal(lastEntry.event, 'blocked');
    assert.ok(Array.isArray(lastEntry.rule_codes));
    assert.ok(lastEntry.rule_codes.length > 0);
    assert.equal(lastEntry.block_count_in_session, 1);
    assert.equal(lastEntry.downgraded_to_warning, false);
    assert.equal(lastEntry.ai_instructed_to_annotate, true);
  });
});

// ============================================================
// Scenario 13: do not log when nothing blocked
// ============================================================

describe('v1.19.11 scenario 13 — no block → no log entry', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('a compliant reply must not write an entry', () => {
    writeTranscript('好、我來改這個問題、先寫測試再實作。');
    runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(fs.existsSync(eventLogPath), false, 'passing lint must not write an entry');
  });
});

// ============================================================
// Scenario 14: downgrade-to-warning is also logged
// ============================================================

describe('v1.19.11 scenario 14 — downgrade to warning is also logged', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('downgrade entry has event=downgraded_to_warning', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-log-downgrade';
    const payload = stopPayload({ session_id: sid });

    // Run until downgrade fires.
    for (let i = 1; i <= 6; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });

    const lines = fs.readFileSync(eventLogPath, 'utf8').trim().split('\n').filter(Boolean);
    const downgradeEntry = lines.map(l => JSON.parse(l)).find(e => e.downgraded_to_warning === true);
    assert.ok(downgradeEntry, 'should have a downgrade entry');
    assert.equal(downgradeEntry.event, 'downgraded_to_warning');
  });
});
