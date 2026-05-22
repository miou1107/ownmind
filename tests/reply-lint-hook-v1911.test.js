/**
 * v1.19.11 — reply-lint hook 分級顯示 + log 保底測試
 *
 * 對應 openspec/changes/v1.19.11-lint-ux-improvements/spec.md 場景 5-10、13-14。
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
// 場景 5 + 7：第 1 次擋下、完整標註
// ============================================================

describe('v1.19.11 場景 5+7 — 第 1 次擋下、完整訊息含標註要求', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('第 4 次違規（第 1 次擋下）→ stderr 含完整指令 + 標註要求', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-block-1';
    const payload = stopPayload({ session_id: sid });

    for (let i = 1; i <= 3; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r4 = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r4.status, 2, '第 4 次該 exit 2');

    // 完整指令含原本的「請重寫」開頭
    assert.match(r4.stderr, /請重寫/);
    // 含標註要求
    assert.match(r4.stderr, /重寫時必須在開頭加一段引述標註/);
    // 含 markdown 引述範例
    assert.match(r4.stderr, /^> ⚠️/m);
    // 含分隔線範例
    assert.match(r4.stderr, /^---$/m);
  });
});

// ============================================================
// 場景 8：第 2-3 次擋下、簡短訊息
// ============================================================

describe('v1.19.11 場景 8 — 第 2-3 次擋下、簡短訊息', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('第 5 次違規（第 2 次擋下）→ 簡短訊息、不含完整列表', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-block-2';
    const payload = stopPayload({ session_id: sid });

    // 跑前 4 次（第 1 次擋下）
    for (let i = 1; i <= 4; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }

    // 第 5 次（第 2 次擋下）
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2);

    // 簡短訊息含「↻」+ session 次數
    assert.match(r.stderr, /↻/);
    assert.match(r.stderr, /第 2 次擋下/);

    // 不該含「請重寫你剛才的回應、改善以下品質問題」完整訊息
    assert.ok(
      !r.stderr.includes('1. 用白話中文取代以下英文詞'),
      '簡短訊息不該含完整違規詞列表'
    );
  });

  it('第 6 次違規（第 3 次擋下）→ 仍簡短', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-block-3';
    const payload = stopPayload({ session_id: sid });

    for (let i = 1; i <= 5; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /第 3 次擋下/);
  });
});

// ============================================================
// 場景 9：第 4 次降警告（既有 v1.19.7 行為、確認沒被破壞）
// ============================================================

describe('v1.19.11 場景 9 — 第 4 次擋下達 downgrade limit、降警告', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('連續擋下 3 次後、第 4 次降為 exit 1 警告', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-downgrade';
    const payload = stopPayload({ session_id: sid });

    // 跑前 6 次（前 3 次累積、第 4-6 次擋下、block_count 達 3）
    for (let i = 1; i <= 6; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }

    // 第 7 次（block_count=3、要降警告）
    const r = runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 1, '應該降為警告 exit 1');
    assert.match(r.stderr, /連續擋下|降為警告/);
  });
});

// ============================================================
// 場景 10：擋下事件寫進 reply-lint-events.jsonl
// ============================================================

describe('v1.19.11 場景 10 — 擋下事件寫紀錄檔', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('擋下後 reply-lint-events.jsonl 有新紀錄', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-log';
    const payload = stopPayload({ session_id: sid });

    for (let i = 1; i <= 3; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    // 第 4 次擋下
    runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });

    assert.equal(fs.existsSync(eventLogPath), true, 'reply-lint-events.jsonl 該存在');
    const lines = fs.readFileSync(eventLogPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, '至少一筆擋下紀錄');

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
// 場景 13：未擋下時不寫紀錄
// ============================================================

describe('v1.19.11 場景 13 — 沒擋下不寫紀錄', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('合規回應不該寫紀錄', () => {
    writeTranscript('好、我來改這個問題、先寫測試再實作。');
    runHook(stopPayload(), { OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(fs.existsSync(eventLogPath), false, '通過 lint 不該寫紀錄');
  });
});

// ============================================================
// 場景 14：降警告也寫紀錄
// ============================================================

describe('v1.19.11 場景 14 — 降警告也寫紀錄', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('降警告事件含 event=downgraded_to_warning', () => {
    writeTranscript(VIOLATING_TEXT);
    const sid = 'sess-log-downgrade';
    const payload = stopPayload({ session_id: sid });

    // 跑到觸發降警告
    for (let i = 1; i <= 6; i++) {
      runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    runHook(payload, { OWNMIND_REPLY_LINT_MODE: 'block' });

    const lines = fs.readFileSync(eventLogPath, 'utf8').trim().split('\n').filter(Boolean);
    const downgradeEntry = lines.map(l => JSON.parse(l)).find(e => e.downgraded_to_warning === true);
    assert.ok(downgradeEntry, '應有一筆降警告紀錄');
    assert.equal(downgradeEntry.event, 'downgraded_to_warning');
  });
});
