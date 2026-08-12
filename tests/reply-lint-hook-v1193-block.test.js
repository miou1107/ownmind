/**
 * v1.19.3 — reply-lint hook progressive-block behavior tests
 *
 * Tracks openspec/changes/v1.19.3-reply-lint-progressive-block/spec.md
 *   scenarios 1 ~ 6 + 15.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const hookPath = path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js');

let tmpHome;
let pendingFile;
let transcriptPath;
let counterPath;

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

function setupTmpHome() {
  tmpHome = tempDir('ownmind-reply-lint-v1193-');
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  pendingFile = path.join(tmpHome, '.ownmind', 'logs', 'banner-pending.jsonl');
  counterPath = path.join(tmpHome, '.ownmind', 'logs', 'reply-lint-session-counter.json');
  transcriptPath = path.join(tmpHome, 'transcript.jsonl');
  // v1.26.13: the rule-driven architecture now requires an explicit cache.
  // An empty cache means "user opted in to no validators" → no lint fires.
  // These tests assert block behavior on violations, so seed both validators.
  const cacheDir = path.join(tmpHome, '.ownmind', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'iron_rules.json'), JSON.stringify([
    { code: 'TEST-JARGON', metadata: { lint_validator: { name: 'jargon_explanation', params: {} } } },
    { code: 'TEST-MIXED', metadata: { lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.15 } } } },
  ]));
}

function cleanupTmpHome() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

function writeTranscript(text) {
  const line = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  fs.writeFileSync(transcriptPath, line + '\n');
}

function stopPayload(extra = {}) {
  return {
    session_id: 'v1193-test-' + Math.random(),
    transcript_path: transcriptPath,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    ...extra,
  };
}

// Violating text: Chinese/English mix + jargon without explanation.
const VIOLATING_TEXT = 'I think we should monomorphism the whole codeapp using a completely fresh approach because the implementation has obvious bugs.';

describe('v1.19.3 scenario 1 — first violation must never block (regardless of MODE)', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('MODE unset (v1.19.4+ defaults to block); first violation must not block', () => {
    writeTranscript(VIOLATING_TEXT);
    const r = runHook(stopPayload()); // no MODE; v1.19.4 default is block
    assert.equal(r.status, 0);
    // First violation, counter=1 < 4; must not block.
    assert.ok(!r.stdout.includes('"decision"'), `first violation must not block; stdout=${r.stdout}`);
  });

  it('MODE=warn opt-out; violation → stdout has no block JSON', () => {
    writeTranscript(VIOLATING_TEXT);
    const r = runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'warn' });
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('"decision"'));
  });
});

describe('v1.19.4 — default MODE=block: four consecutive violations also block without env', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('without OWNMIND_REPLY_LINT_MODE set; 4th violation exits 2 + stderr has rewrite directive (v1.19.7)', () => {
    writeTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-v1194-default';
    const payload = stopPayload({ session_id: sessionId });

    // No env; default MODE (v1.19.4+ = block).
    for (let i = 1; i <= 3; i++) {
      const r = runHook(payload);
      assert.equal(r.status, 0, `attempt ${i} must not block`);
      assert.equal(r.stderr, '', `attempt ${i} stderr must be blank`);
    }
    const r4 = runHook(payload);
    assert.equal(r4.status, 2, `v1.19.7 attempt 4 must exit 2; stdout=${r4.stdout} stderr=${r4.stderr}`);
    assert.match(r4.stderr, /Please rewrite/, 'stderr should contain the rewrite directive (directive-style reason)');
  });

  it('MODE=warn explicitly set; even the 4th violation exits 0', () => {
    writeTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-v1194-warn-optout';
    const payload = stopPayload({ session_id: sessionId });

    for (let i = 1; i <= 4; i++) {
      const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'warn' });
      assert.equal(r.status, 0, `attempt ${i} warn opt-out must not block`);
      assert.equal(r.stderr, '', `attempt ${i} warn mode stderr must be blank`);
    }
  });
});

describe('v1.19.3 scenarios 2/3 — MODE=block progressive accumulation', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('first violation → no block (counter=1 < 4)', () => {
    writeTranscript(VIOLATING_TEXT);
    const payload = stopPayload({ session_id: 'sess-progressive-1' });
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'attempt 1 stderr must be blank');
    // counter should be written to file.
    const counterData = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counterData['sess-progressive-1'].count, 1);
  });

  it('four consecutive violations → 4th exits 2 + stderr contains directive-style reason (v1.19.7)', () => {
    writeTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-progressive-4';
    const payload = stopPayload({ session_id: sessionId });

    for (let i = 1; i <= 3; i++) {
      const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
      assert.equal(r.status, 0, `attempt ${i} must not block`);
    }

    // 4th attempt should exit 2 + stderr contains reason.
    const r4 = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r4.status, 2, `attempt 4 must exit 2; stdout=${r4.stdout} stderr=${r4.stderr}`);
    assert.ok(r4.stderr.length > 0, 'stderr should contain a reason');
    assert.match(r4.stderr, /^Please rewrite/m, 'reason should start with "Please rewrite"');

    // block_count is incremented.
    const counterData = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counterData[sessionId].block_count, 1, '4th violation should set block_count=1');
  });
});

describe('v1.19.3 scenario 4 — stop_hook_active=true loop guard', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('stop_hook_active=true: even on violation, do not increment counter; do not block; exit 0', () => {
    writeTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-stop-active';

    // Accumulate 3 violations first.
    for (let i = 1; i <= 3; i++) {
      runHook(stopPayload({ session_id: sessionId }), { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const before = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(before[sessionId].count, 3);

    // The stop_hook_active=true run must not increment and must not block.
    const r = runHook(
      stopPayload({ session_id: sessionId, stop_hook_active: true }),
      { OWNMIND_REPLY_LINT_MODE: 'block' }
    );
    assert.equal(r.status, 0, 'stop_hook_active=true must exit 0');
    assert.equal(r.stderr, '', 'stop_hook_active=true must not write stderr');

    // counter unchanged
    const after = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(after[sessionId].count, 3, 'stop_hook_active=true must not increment counter');
  });
});

describe('v1.19.3 scenario 5 — MODE=disable: skip entirely', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('MODE=disable: violation does nothing', () => {
    writeTranscript(VIOLATING_TEXT);
    const r = runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'disable' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    // Must not write pending; must not write counter.
    assert.equal(fs.existsSync(pendingFile), false, 'disable must not write a banner');
    assert.equal(fs.existsSync(counterPath), false, 'disable must not write a counter');
  });
});

describe('v1.19.3 scenario 6 — unknown MODE value fails open to warn', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it("MODE='foo' violation behaves like warn; banner contains the unknown-value warning", () => {
    writeTranscript(VIOLATING_TEXT);
    const r = runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'foo' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'unknown MODE must not block');
    assert.ok(fs.existsSync(pendingFile), 'violation should write a banner');
    const banner = fs.readFileSync(pendingFile, 'utf8');
    assert.match(banner, /foo/, 'banner should contain the unknown MODE value');
    assert.match(banner, /fallback|falling back/, 'banner should mention the fallback');
  });
});

describe('v1.19.7 scenarios — block reason in stderr is directive-style + contains specific terms', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('when block fires, stderr contains "please rewrite" + specific violating term + rewrite example', () => {
    writeTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-reason';

    // Accumulate 3 (exit 0).
    for (let i = 1; i <= 3; i++) {
      const r = runHook(stopPayload({ session_id: sessionId }), { OWNMIND_REPLY_LINT_MODE: 'block' });
      assert.equal(r.status, 0);
    }

    // 4th attempt should exit 2; stderr has reason.
    const r = runHook(stopPayload({ session_id: sessionId }), { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2, `attempt 4 must exit 2; stderr=${r.stderr}`);

    const reason = r.stderr;

    // 1. Directive-style opening verb.
    assert.match(reason, /^Please rewrite/m, 'reason must start with "Please rewrite" (directive style)');

    // 2. Contains a specific violating term (monomorphism or codeapp).
    assert.ok(
      reason.includes('monomorphism') || reason.includes('codeapp'),
      `reason should contain a specific violating term; actual: ${reason}`
    );

    // 3. Contains a rewrite-format hint.
    assert.match(reason, /parenthetical|explanation|：|（|即/, 'reason should contain a rewrite-format hint');

    // 4. Contains an exception guideline (variable / function names).
    assert.match(reason, /variable names|function names|code references/, 'reason should contain an exception guideline');

    // 5. Must not use the report-style "you violated" wording (neither Chinese nor English variants).
    assert.ok(!reason.includes('你違反') && !reason.includes('You violated'), 'reason must not use the report-style "你違反 / You violated"');
  });
});
