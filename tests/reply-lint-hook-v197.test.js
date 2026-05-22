/**
 * v1.19.7 — reply-lint hook 新行為測試
 *
 * 對應 openspec/changes/v1.20-iron-rule-enforcement/spec.md：
 *   - 場景 13~15：reply-lint block 改用 exit 2 + stderr
 *   - 場景 16：連續 block 達 BLOCK_DOWNGRADE_LIMIT 後降警告 exit 1
 *   - 場景 17：IR-041 偵測身分證 / email；user prompt 例外
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-reply-lint-v197-'));
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  pendingFile = path.join(tmpHome, '.ownmind', 'logs', 'banner-pending.jsonl');
  counterPath = path.join(tmpHome, '.ownmind', 'logs', 'reply-lint-session-counter.json');
  transcriptPath = path.join(tmpHome, 'transcript.jsonl');
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
// 場景 16：連續擋 3 次降警告
// ============================================================

describe('v1.19.7 場景 16 — 連續 block 達 3 次後第 4 次降警告 exit 1', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('違規 4+3 次後第 8 次降警告 exit 1（前 3 次累積、第 4~6 次 block、第 7 次降警告）', () => {
    writeTranscript([{ role: 'assistant', text: VIOLATING_TEXT }]);
    const sessionId = 'sess-downgrade';
    const payload = stopPayload({ session_id: sessionId });

    // 第 1~3 次違規：累積、exit 0
    for (let i = 1; i <= 3; i++) {
      const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
      assert.equal(r.status, 0, `第 ${i} 次該 exit 0`);
    }
    // 第 4 次違規：block_count 變 1，exit 2
    let r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2, '第 4 次該 exit 2');
    let counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 1);

    // 第 5 次：block_count → 2
    r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2);
    counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 2);

    // 第 6 次：block_count → 3
    r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2);
    counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 3);

    // 第 7 次：block_count 已 3，降警告 exit 1、不再 increment block_count
    r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 1, `第 7 次該降警告 exit 1、stderr=${r.stderr}`);
    assert.match(r.stderr, /連續擋下/, 'stderr 該含降警告訊息');
    assert.match(r.stderr, /避免死循環/);
    counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 3, '降警告時不該 increment block_count');
  });

  it('降警告時 compliance event action=repeated_violation_softblock', () => {
    writeTranscript([{ role: 'assistant', text: VIOLATING_TEXT }]);
    const sessionId = 'sess-softblock-event';
    const payload = stopPayload({ session_id: sessionId });

    // 跑到第 7 次違規（降警告）
    for (let i = 1; i <= 6; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });

    // 讀檔抓最後一筆 event
    const archive = path.join(tmpHome, '.ownmind', 'logs', `${new Date().toISOString().slice(0, 10)}.jsonl`);
    assert.ok(fs.existsSync(archive), 'archive 該存在');
    const lines = fs.readFileSync(archive, 'utf8').trim().split('\n').filter(Boolean);
    const lastEvent = JSON.parse(lines[lines.length - 1]);
    assert.equal(lastEvent.details.action, 'repeated_violation_softblock');
  });
});

// ============================================================
// 通過時清零 block_count
// ============================================================

describe('v1.19.7 — 通過 lint 時清零 block_count', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('違規累積 4 次（block_count=1）後 AI 改寫乾淨 → block_count 重設為 0', () => {
    const sessionId = 'sess-reset';
    const payload = stopPayload({ session_id: sessionId });

    writeTranscript([{ role: 'assistant', text: VIOLATING_TEXT }]);
    for (let i = 1; i <= 4; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    let counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 1);

    // AI 改寫成乾淨回應
    writeTranscript([{ role: 'assistant', text: CLEAN_TEXT }]);
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 0);

    counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    assert.equal(counter[sessionId].block_count, 0, '通過時 block_count 該清零');
  });
});

// ============================================================
// IR-041 整合（場景 17）
// ============================================================

describe('v1.19.7 場景 17 — IR-041 隱私偵測整合', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('AI 回應含信箱（user 沒提）→ 第 4 次累積後 exit 2、reason 提到隱私', () => {
    const sessionId = 'sess-privacy';
    const payload = stopPayload({ session_id: sessionId });

    writeTranscript([
      { role: 'user', text: '幫我寫封信' },
      { role: 'assistant', text: '寄到 leaked@fontrip.com 即可' },
    ]);

    for (let i = 1; i <= 3; i++) {
      const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
      assert.equal(r.status, 0);
    }
    const r4 = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r4.status, 2, '隱私違規累積到第 4 次該 block');
    assert.match(r4.stderr, /個資|隱私/);
  });

  it('AI 回應引用 user prompt 裡的身分證 → 不算違反、exit 0', () => {
    // 用身分證測 IR-041 例外（純數字+1 字母、不會被 IR-037 中英混雜抓到）
    writeTranscript([
      { role: 'user', text: '請幫我查身分證 A123456789 的資料' },
      { role: 'assistant', text: '查到了，A123456789 是測試帳號的編號。' },
    ]);
    const r = runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(fs.existsSync(pendingFile), false, '使用者自己提的個資不該觸發 banner');
  });

  it('banner 含 IR-041 標識', () => {
    writeTranscript([
      { role: 'assistant', text: '聯絡 leaked@fontrip.com' },
    ]);
    runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.ok(fs.existsSync(pendingFile), 'IR-041 違反該寫 banner');
    const banner = fs.readFileSync(pendingFile, 'utf8');
    assert.match(banner, /IR-041/);
  });

  it('IR-041 單獨命中時 reason 從「1.」開始（v1.19.7 code-review I-5 修正）', () => {
    // 用身分證觸發（IR-041）且不要中英混雜（避免 IR-037 同步觸發影響編號驗證）
    // A123456789 純大寫字母+數字、不被 IR-037 抓
    const sessionId = 'sess-numbering';
    const payload = stopPayload({ session_id: sessionId });
    writeTranscript([
      { role: 'assistant', text: '查到了，編號 A123456789 是測試用戶資料。' },
    ]);
    for (let i = 1; i <= 4; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2, `期望 exit 2、stderr=${r.stderr}`);
    assert.match(r.stderr, /^1\. /m, 'IR-041 單獨命中時編號該從 1. 開始、不該是 3.');
    assert.ok(!r.stderr.includes('3. 回應疑似'), '不該出現孤立的 3. 編號');
  });

  it('block 觸發時 stderr 不應「再次列出」命中的個資（避免 AI 重寫又帶一次）', () => {
    const sessionId = 'sess-privacy-reason';
    const payload = stopPayload({ session_id: sessionId });
    writeTranscript([
      { role: 'assistant', text: '請聯絡 leaked-secret-mail@fontrip.com' },
    ]);
    for (let i = 1; i <= 4; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2);
    assert.ok(
      !r.stderr.includes('leaked-secret-mail@fontrip.com'),
      'block reason 不該再列原個資字串'
    );
    assert.match(r.stderr, /\[email\]|代稱|改用/, 'block reason 該提示用代稱');
  });
});
