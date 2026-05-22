/**
 * v1.19.3 — reply-lint hook 漸進式 block 行為測試
 *
 * 對應 openspec/changes/v1.19.3-reply-lint-progressive-block/spec.md
 *   場景 1 ~ 6 + 15
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-reply-lint-v1193-'));
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  pendingFile = path.join(tmpHome, '.ownmind', 'logs', 'banner-pending.jsonl');
  counterPath = path.join(tmpHome, '.ownmind', 'logs', 'reply-lint-session-counter.json');
  transcriptPath = path.join(tmpHome, 'transcript.jsonl');
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

// 違規文本：中英混雜 + 行話無解釋
const VIOLATING_TEXT = 'I think we should monomorphism the whole codeapp using a completely fresh approach because the implementation has obvious bugs.';

describe('v1.19.3 場景 1 — MODE=warn（預設）違規只警告', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('MODE 未設、違規 → stdout 不含 block JSON', () => {
    writeTranscript(VIOLATING_TEXT);
    const r = runHook(stopPayload()); // 沒設 MODE
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('"decision"'), `MODE=warn 不該寫 block decision、stdout=${r.stdout}`);
  });

  it('MODE=warn 明確設、違規 → stdout 不含 block JSON', () => {
    writeTranscript(VIOLATING_TEXT);
    const r = runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'warn' });
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('"decision"'));
  });
});

describe('v1.19.3 場景 2/3 — MODE=block 漸進累積', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('第 1 次違規 → 不 block（計數=1 < 4）', () => {
    writeTranscript(VIOLATING_TEXT);
    const payload = stopPayload({ session_id: 'sess-progressive-1' });
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('"decision"'), `第 1 次不該 block、stdout=${r.stdout}`);
    // counter 應寫進檔
    const counterData = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counterData['sess-progressive-1'].count, 1);
  });

  it('連續 4 次違規 → 第 4 次寫 block JSON', () => {
    writeTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-progressive-4';
    const payload = stopPayload({ session_id: sessionId });

    for (let i = 1; i <= 3; i++) {
      const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
      assert.equal(r.status, 0);
      assert.ok(!r.stdout.includes('"decision"'), `第 ${i} 次不該 block`);
    }

    // 第 4 次應 block
    const r4 = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r4.status, 0);
    assert.ok(r4.stdout.includes('"decision"'), `第 4 次該寫 block JSON、stdout=${r4.stdout}`);

    // 驗 block JSON 格式
    const parsed = JSON.parse(r4.stdout.trim());
    assert.equal(parsed.decision, 'block');
    assert.ok(typeof parsed.reason === 'string', 'reason 必須是字串');
    assert.ok(parsed.reason.length > 0, 'reason 不該為空');
  });
});

describe('v1.19.3 場景 4 — stop_hook_active=true 防迴圈', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('stop_hook_active=true 即使違規也不增計數、不寫 stdout', () => {
    writeTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-stop-active';

    // 先製造 3 次違規累積
    for (let i = 1; i <= 3; i++) {
      runHook(stopPayload({ session_id: sessionId }), { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const before = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(before[sessionId].count, 3);

    // stop_hook_active=true 那次不該增、不該 block
    const r = runHook(
      stopPayload({ session_id: sessionId, stop_hook_active: true }),
      { OWNMIND_REPLY_LINT_MODE: 'block' }
    );
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('"decision"'), 'stop_hook_active=true 絕不寫 block');

    // counter 不增
    const after = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(after[sessionId].count, 3, 'stop_hook_active=true 不該增計數');
  });
});

describe('v1.19.3 場景 5 — MODE=disable 完全跳過', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('MODE=disable 違規也完全不動', () => {
    writeTranscript(VIOLATING_TEXT);
    const r = runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'disable' });
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('"decision"'));
    // 不該寫 pending 也不該寫 counter
    assert.equal(fs.existsSync(pendingFile), false, 'disable 不該寫 banner');
    assert.equal(fs.existsSync(counterPath), false, 'disable 不該寫 counter');
  });
});

describe('v1.19.3 場景 6 — MODE 未知值 fail-open 到 warn', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it("MODE='foo' 違規行為同 warn、banner 含未知值警語", () => {
    writeTranscript(VIOLATING_TEXT);
    const r = runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'foo' });
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('"decision"'), '未知 MODE 不該 block');
    assert.ok(fs.existsSync(pendingFile), '違規該寫 banner');
    const banner = fs.readFileSync(pendingFile, 'utf8');
    assert.match(banner, /foo/, 'banner 該含未知 MODE 值');
    assert.match(banner, /fallback/, 'banner 該說 fallback');
  });
});

describe('v1.19.3 場景 15 — block reason 為指令型 + 含具體詞', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('block 觸發時 reason 含「請重寫」、具體違規詞、改寫格式範例', () => {
    writeTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-reason';

    for (let i = 1; i <= 4; i++) {
      runHook(stopPayload({ session_id: sessionId }), { OWNMIND_REPLY_LINT_MODE: 'block' });
    }

    // 撈最後一次的 stdout
    const r = runHook(stopPayload({ session_id: sessionId }), { OWNMIND_REPLY_LINT_MODE: 'block' });
    const parsed = JSON.parse(r.stdout.trim());

    // 1. 指令動詞開頭
    assert.match(parsed.reason, /^請重寫/, 'reason 必須以「請重寫」開頭（指令型）');

    // 2. 含具體違規詞（monomorphism 或 codeapp）
    assert.ok(
      parsed.reason.includes('monomorphism') || parsed.reason.includes('codeapp'),
      `reason 該含具體違規詞、實際：${parsed.reason}`
    );

    // 3. 含改寫格式範例
    assert.match(parsed.reason, /括號|：|（|即/, 'reason 該含改寫格式提示');

    // 4. 含例外指引（變數名 / 函式名）
    assert.match(parsed.reason, /變數名|函式名|程式碼/, 'reason 該含例外指引');

    // 5. 不含「你違反」這種報告式語氣
    assert.ok(!parsed.reason.includes('你違反'), 'reason 不該用報告式「你違反」');
  });
});
