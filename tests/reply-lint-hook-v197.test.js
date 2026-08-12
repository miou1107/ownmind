/**
 * v1.19.7 — reply-lint hook new-behavior tests
 *
 * Tracks openspec/changes/v1.20-iron-rule-enforcement/spec.md:
 *   - scenarios 13~15: reply-lint block switches to exit 2 + stderr
 *   - scenario 16: after consecutive blocks hit BLOCK_DOWNGRADE_LIMIT, downgrade to a warning exit 1
 *   - scenario 17: privacy detects national ID / email; user prompt is an exception
 *     (event name privacy_check; v1.19.10 neutralization)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { localDateOnly } from '../shared/local-date.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  '..'
);
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
  tmpHome = tempDir('ownmind-reply-lint-v197-');
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  pendingFile = path.join(tmpHome, '.ownmind', 'logs', 'banner-pending.jsonl');
  counterPath = path.join(tmpHome, '.ownmind', 'logs', 'reply-lint-session-counter.json');
  transcriptPath = path.join(tmpHome, 'transcript.jsonl');

  // v1.21.0: the rule-driven architecture needs a user iron-rule cache to enable validators.
  // Tests always write a fake cache enabling all 3 validators.
  const cacheDir = path.join(tmpHome, '.ownmind', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'iron_rules.json'), JSON.stringify([
    { code: 'TEST-JARGON', metadata: { lint_validator: { name: 'jargon_explanation', params: {} } } },
    { code: 'TEST-MIXED', metadata: { lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.15 } } } },
    { code: 'TEST-PRIVACY', metadata: { lint_validator: { name: 'privacy_detect', params: {} } } },
  ]));
}

function cleanupTmpHome() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

function writeTranscript(turns) {
  const lines = turns.map((t) => {
    if (t.role === 'user') {
      return JSON.stringify({
        type: 'user',
        message: { role: 'user', content: t.text || '' },
      });
    }
    const content = t.parts || [{ type: 'text', text: t.text || '' }];
    return JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content },
    });
  });
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
}

function stopPayload(extra = {}) {
  return {
    session_id: 'v197-test-' + Math.random(),
    transcript_path: transcriptPath,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    ...extra,
  };
}

const VIOLATING_TEXT = 'I think we should monomorphism the whole codeapp using a completely fresh approach because the implementation has obvious bugs.';
const CLEAN_TEXT = '好、我來把那段改成白話中文、不夾英文。';

// ============================================================
// Scenario 16: consecutive blocks downgrade to a warning
// ============================================================

describe('v1.19.7 scenario 16 — after 3 consecutive blocks, the 4th downgrades to exit 1', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('after 4+3 violations, the 7th downgrades to exit 1 (first 3 accumulate; 4th–6th block; 7th downgrades)', () => {
    writeTranscript([{ role: 'assistant', text: VIOLATING_TEXT }]);
    const sessionId = 'sess-downgrade';
    const payload = stopPayload({ session_id: sessionId });

    // Violations 1~3: accumulate, exit 0.
    for (let i = 1; i <= 3; i++) {
      const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
      assert.equal(r.status, 0, `attempt ${i} should exit 0`);
    }
    // Violation 4: block_count becomes 1, exit 2.
    let r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2, 'attempt 4 should exit 2');
    let counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 1);

    // Attempt 5: block_count → 2.
    r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2);
    counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 2);

    // Attempt 6: block_count → 3.
    r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2);
    counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 3);

    // Attempt 7: block_count is already 3; downgrade to exit 1; do not increment block_count.
    r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 1, `attempt 7 should downgrade to exit 1; stderr=${r.stderr}`);
    assert.match(r.stderr, /blocked .* times in a row/, 'stderr should include the downgrade message');
    assert.match(r.stderr, /break the loop/);
    counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 3, 'downgrade must not increment block_count');
  });

  it('on downgrade, compliance event action=repeated_violation_softblock', () => {
    writeTranscript([{ role: 'assistant', text: VIOLATING_TEXT }]);
    const sessionId = 'sess-softblock-event';
    const payload = stopPayload({ session_id: sessionId });

    // Drive to the 7th violation (downgrade).
    for (let i = 1; i <= 6; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });

    // Read the archive and grab the last event.
    // v1.26.124: localDateOnly, not toISOString().slice(0, 10). The hook names this file by
    // the local date now, so a UTC name here looks for a file that does not exist for the
    // eight hours a UTC+8 machine runs ahead — which is exactly the flake v1.20.1 recorded
    // when the MCP and its test disagreed the same way. Importing the helper rather than
    // restating it means the test cannot drift from the hook again.
    const archive = path.join(tmpHome, '.ownmind', 'logs', `${localDateOnly(new Date())}.jsonl`);
    assert.ok(fs.existsSync(archive), 'archive should exist');
    const lines = fs.readFileSync(archive, 'utf8').trim().split('\n').filter(Boolean);
    const lastEvent = JSON.parse(lines[lines.length - 1]);
    assert.equal(lastEvent.details.action, 'repeated_violation_softblock');
  });
});

// ============================================================
// Pass clears block_count
// ============================================================

describe('v1.19.7 — passing the lint clears block_count', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('after 4 violations (block_count=1), an all-clean rewrite resets block_count to 0', () => {
    const sessionId = 'sess-reset';
    const payload = stopPayload({ session_id: sessionId });

    writeTranscript([{ role: 'assistant', text: VIOLATING_TEXT }]);
    for (let i = 1; i <= 4; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    let counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 1);

    // AI rewrites with a clean reply.
    writeTranscript([{ role: 'assistant', text: CLEAN_TEXT }]);
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 0);

    counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 0, 'pass should clear block_count');
  });
});

// ============================================================
// Privacy detection integration (scenario 17; event name privacy_check)
// ============================================================

describe('v1.19.7 scenario 17 — privacy detection integration (event name privacy_check)', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('AI reply contains an email (user did not provide it) → after 4 accumulations, exit 2; reason mentions privacy', () => {
    const sessionId = 'sess-privacy';
    const payload = stopPayload({ session_id: sessionId });

    writeTranscript([
      { role: 'user', text: '幫我寫封信' },
      { role: 'assistant', text: '寄到 leaked@acme.com 即可' },
    ]);

    for (let i = 1; i <= 3; i++) {
      const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
      assert.equal(r.status, 0);
    }
    const r4 = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r4.status, 2, 'after the privacy violation accumulates to 4, it should block');
    assert.match(r4.stderr, /privacy|email|Privacy content/i);
  });

  it('AI reply quotes a national ID the user shared → not a violation; exit 0', () => {
    // Use national ID to test the privacy exception (only digits + 1 letter; IR-037 mixed-language does not match).
    writeTranscript([
      { role: 'user', text: '請幫我查身分證 A123456789 的資料' },
      { role: 'assistant', text: '查到了，A123456789 是測試帳號的編號。' },
    ]);
    const r = runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(fs.existsSync(pendingFile), false, 'PII shared by the user themselves should not trigger a banner');
  });

  it('banner contains the privacy_check identifier (v1.19.10 neutralization)', () => {
    writeTranscript([
      { role: 'assistant', text: '聯絡 leaked@acme.com' },
    ]);
    runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.ok(fs.existsSync(pendingFile), 'privacy violation should write a banner');
    const banner = fs.readFileSync(pendingFile, 'utf8');
    assert.match(banner, /privacy_check/);
  });

  it('when privacy hits alone, reason numbering starts from "1." (v1.19.7 code-review I-5 fix)', () => {
    // Trigger via national ID (privacy_check) without mixed-language (so IR-037 does not co-fire).
    // A123456789 is uppercase + digits and is not caught by IR-037.
    // v1.19.11 note: only drive to "the 4th violation (1st block)" for the full message; not the 5th (tiered short msg).
    const sessionId = 'sess-numbering';
    const payload = stopPayload({ session_id: sessionId });
    writeTranscript([
      { role: 'assistant', text: '查到了，編號 A123456789 是測試用戶資料。' },
    ]);
    for (let i = 1; i <= 3; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2, `expected exit 2; stderr=${r.stderr}`);
    assert.match(r.stderr, /^1\. /m, 'when privacy hits alone, numbering should start at 1., not 3.');
    assert.ok(!r.stderr.includes('3. 回應疑似'), 'must not produce an orphan numbered "3." line');
  });

  it('when block fires, stderr should not "relist" the matched PII (avoid the AI re-including it on rewrite)', () => {
    // v1.19.11 note: only drive to the 1st block; that path produces the full message (including "use a placeholder").
    const sessionId = 'sess-privacy-reason';
    const payload = stopPayload({ session_id: sessionId });
    writeTranscript([
      { role: 'assistant', text: '請聯絡 leaked-secret-mail@acme.com' },
    ]);
    for (let i = 1; i <= 3; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2);
    assert.ok(
      !r.stderr.includes('leaked-secret-mail@acme.com'),
      'block reason should not re-list the original PII string'
    );
    assert.match(r.stderr, /\[email\]|placeholders|Rewrite that segment/i, 'block reason should hint at using a placeholder');
  });
});
